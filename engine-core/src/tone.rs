//! Pitched voices: bass, stabs, lead, pad, arp.
//!
//! One `ToneVoice` is a small polyBLEP oscillator bank feeding a resonant lowpass
//! with its own envelope, then an amplitude envelope. Voicing per track flavour is
//! selected by [`Voicing`] so the house/deep/acid/lo-fi characters stay distinct.

use crate::dsp::{exp_between, midi_hz, Adsr, Osc, StereoBiquad, Wave};
use crate::track::{NoteEvent, TrackKind};

/// Per-stem voicing parameters.
#[derive(Clone)]
pub struct Voicing {
    pub wave: Wave,
    /// Detune in cents, per oscillator, exactly as the original's `detune` array.
    ///
    /// This is a list rather than a single amount because the original applies it by
    /// oscillator *index*: oscillator `i` takes `detune[i]`, falling back to the last
    /// entry once the list runs out. So `[-6, 5]` on a four-note chord means the first
    /// note is 6 cents flat and the other three are 5 cents sharp, and the pad's
    /// `[−9, 11, −9, 11, …]` alternates all the way up the chord.
    pub detune: Vec<f32>,
    pub peak: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub f_start: f32,
    pub f_peak: f32,
    pub f_end: f32,
    pub q: f32,
    pub f_attack: f32,
    /// Spread the oscillator bank across the stereo field.
    pub wide: bool,
    /// How many oscillators to build per note.
    ///
    /// The original builds its oscillator list from the note list in one of two ways.
    /// Most stems pass the notes straight through, one oscillator each. Two do not: the
    /// pad passes `notes.flatMap(n => [hz, hz])`, doubling every note so the chord is a
    /// 2N-wide spread, and the house lead passes `[freq, freq]` — a single note doubled
    /// into a stereo unison, which is the entire character of that sound. Without the
    /// unison the house lead is a lone centred oscillator and loses its width entirely.
    pub unison: usize,
    /// How this voicing adjusts the gate the engine hands it.
    pub hold: Hold,
}

/// What a voicing does to the gate it is given.
///
/// Not decoration: the original caps and shortens gates per layer, and a stab that is
/// allowed to ring for its full note length smears the backbeat into the next bar.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Hold {
    /// Use the gate as given.
    AsGiven,
    /// `min(hold, cap)` — a stab that must not ring past its own length.
    Capped(f32),
    /// `max(floor, hold * scale)` — a shortened pluck with a legibility floor.
    Shortened { floor: f32, scale: f32 },
}

impl Hold {
    pub fn apply(self, hold: f32) -> f32 {
        match self {
            Hold::AsGiven => hold,
            Hold::Capped(cap) => hold.min(cap),
            Hold::Shortened { floor, scale } => (hold * scale).max(floor),
        }
    }
}

impl Voicing {
    /// Whether a filter sweep should be skipped when the peak equals the end
    /// frequency — matching the original's `abs(endF - peakF) > 4` guard, which
    /// avoids a pointless ramp on flat filter gestures.
    pub fn sweeps(&self) -> bool {
        (self.f_end - self.f_peak).abs() > 4.0
    }
}

/// Voicing table for a stem on a given flavour. Values are carried over from the
/// original engine so the port sounds like the same instrument.
pub fn voicing(stem: Stem, kind: TrackKind, ev: &NoteEvent, freq: f32) -> Voicing {
    voicing_for(stem, kind, ev, freq)
}

fn voicing_for(stem: Stem, kind: TrackKind, ev: &NoteEvent, freq: f32) -> Voicing {
    match stem {
        Stem::Bass => bass_voicing(kind, ev, freq),
        Stem::Stab => stab_voicing(kind, ev),
        Stem::Lead => lead_voicing(kind, ev, freq),
        Stem::Pad => pad_voicing(kind, ev),
        _ => arp_voicing(kind, ev),
    }
}

pub use crate::track::Stem;

fn bass_voicing(kind: TrackKind, ev: &NoteEvent, freq: f32) -> Voicing {
    match kind {
        TrackKind::Acid => Voicing {
            wave: Wave::Saw,
            detune: vec![4.0],
            peak: ev.vel * 0.4,
            attack: 0.004,
            decay: 0.09,
            sustain: 0.18,
            release: 0.04,
            f_start: (freq * 1.1).max(80.0),
            f_peak: if ev.accent { 2600.0 } else { 980.0 },
            f_end: (freq * 1.3).max(90.0),
            q: if ev.accent { 15.0 } else { 10.0 },
            f_attack: 0.018,
            wide: false,
            unison: 1,
            hold: Hold::Shortened { floor: 0.05, scale: 0.85 },
        },
        TrackKind::Lofi => Voicing {
            wave: Wave::Sine,
            detune: vec![0.0],
            peak: ev.vel * 0.46,
            attack: 0.02,
            decay: 0.22,
            sustain: 0.8,
            release: 0.16,
            f_start: 140.0,
            f_peak: 360.0,
            f_end: 160.0,
            q: 0.5,
            f_attack: 0.04,
            wide: false,
            unison: 1,
            hold: Hold::AsGiven,
        },
        TrackKind::Deep => Voicing {
            wave: Wave::Sine,
            detune: vec![0.0],
            peak: ev.vel * 0.55,
            attack: 0.006,
            decay: 0.18,
            sustain: 0.75,
            release: 0.1,
            f_start: 200.0,
            f_peak: 800.0,
            f_end: 200.0,
            q: 0.6,
            f_attack: 0.02,
            wide: false,
            unison: 1,
            hold: Hold::AsGiven,
        },
        TrackKind::House => Voicing {
            wave: Wave::Sine,
            detune: vec![0.0],
            peak: ev.vel * 0.48,
            attack: 0.006,
            decay: 0.1,
            sustain: 0.4,
            release: 0.05,
            f_start: 200.0,
            f_peak: 800.0,
            f_end: 200.0,
            q: 0.6,
            f_attack: 0.02,
            wide: false,
            unison: 1,
            hold: Hold::AsGiven,
        },
    }
}

/// The house/deep **bass** has a second saw layer under the sine for harmonics.
/// Modelled here as a second voice the caller layers, since the engine owns voice
/// pooling.
///
/// Takes the stem rather than trusting the caller to check it. This is called from
/// inside a `for stem in Stem::TUNED` loop, and without the guard it layered the saw
/// onto the stab, lead, pad and arp as well — on the house pad that phantom voice is
/// `vel * 0.28` against the pad's own `vel * 0.075`, arriving instantly against the
/// pad's 0.4 s attack, which is a resonant transient roughly 300x the level of the
/// note it was supposed to be reinforcing.
pub fn bass_sub_layer(
    stem: Stem,
    kind: TrackKind,
    ev: &NoteEvent,
    freq: f32,
) -> Option<Voicing> {
    if stem != Stem::Bass {
        return None;
    }
    match kind {
        TrackKind::House | TrackKind::Deep => {
            let deep = kind == TrackKind::Deep;
            Some(Voicing {
                wave: Wave::Saw,
                detune: vec![0.0],
                peak: ev.vel * if deep { 0.16 } else { 0.28 },
                attack: 0.006,
                decay: if deep { 0.2 } else { 0.12 },
                sustain: if deep { 0.55 } else { 0.28 },
                release: 0.06,
                f_start: if deep { 140.0 } else { 180.0 },
                f_peak: if deep { 340.0 } else { 780.0 },
                f_end: if deep { 120.0 } else { 170.0 },
                q: if deep { 3.0 } else { 7.0 },
                f_attack: 0.03,
                wide: false,
                unison: 1,
                hold: Hold::AsGiven,
            })
        }
        _ => {
            let _ = freq;
            None
        }
    }
}

fn stab_voicing(kind: TrackKind, ev: &NoteEvent) -> Voicing {
    match kind {
        TrackKind::Lofi => Voicing {
            wave: Wave::Sine,
            detune: vec![-6.0, 5.0],
            peak: ev.vel * 0.24,
            attack: 0.02,
            decay: 0.22,
            sustain: 0.28,
            release: 0.22,
            f_start: 280.0,
            f_peak: 720.0,
            f_end: 240.0,
            q: 0.6,
            f_attack: 0.04,
            wide: true,
            unison: 1,
            hold: Hold::AsGiven,
        },
        TrackKind::Deep => Voicing {
            wave: Wave::Triangle,
            detune: vec![0.0],
            peak: ev.vel * 0.22,
            attack: 0.012,
            decay: 0.18,
            sustain: 0.2,
            release: 0.16,
            f_start: 360.0,
            f_peak: 980.0,
            f_end: 280.0,
            q: 0.8,
            f_attack: 0.03,
            wide: true,
            unison: 1,
            hold: Hold::AsGiven,
        },
        TrackKind::Acid => Voicing {
            wave: Wave::Saw,
            detune: vec![-6.0, 5.0],
            peak: ev.vel * 0.14,
            attack: 0.004,
            decay: 0.08,
            sustain: 0.08,
            release: 0.07,
            f_start: 420.0,
            f_peak: if ev.accent { 2400.0 } else { 1700.0 },
            f_end: 380.0,
            q: 5.0,
            f_attack: 0.012,
            wide: true,
            unison: 1,
            hold: Hold::Capped(0.08),
        },
        TrackKind::House => Voicing {
            wave: Wave::Saw,
            detune: vec![-6.0, 5.0],
            peak: ev.vel * 0.26,
            attack: 0.004,
            decay: 0.13,
            sustain: 0.08,
            release: 0.07,
            f_start: 420.0,
            f_peak: 2400.0,
            f_end: 380.0,
            q: 2.4,
            f_attack: 0.012,
            wide: true,
            unison: 1,
            hold: Hold::Capped(0.14),
        },
    }
}

fn lead_voicing(kind: TrackKind, ev: &NoteEvent, freq: f32) -> Voicing {
    match kind {
        TrackKind::Lofi => Voicing {
            wave: Wave::Sine,
            detune: vec![0.0],
            peak: ev.vel * 0.2,
            attack: 0.04,
            decay: 0.2,
            sustain: 0.62,
            release: 0.28,
            f_start: 280.0,
            f_peak: 640.0,
            f_end: 320.0,
            q: 0.5,
            f_attack: 0.06,
            wide: false,
            unison: 1,
            hold: Hold::AsGiven,
        },
        TrackKind::Deep => Voicing {
            wave: Wave::Triangle,
            detune: vec![0.0],
            peak: ev.vel * 0.2,
            attack: 0.06,
            decay: 0.22,
            sustain: 0.6,
            release: 0.24,
            f_start: 300.0,
            f_peak: 880.0,
            f_end: 420.0,
            q: 0.6,
            f_attack: 0.1,
            wide: false,
            unison: 1,
            hold: Hold::AsGiven,
        },
        TrackKind::Acid => Voicing {
            wave: Wave::Saw,
            detune: vec![3.0],
            peak: ev.vel * 0.12,
            attack: 0.008,
            decay: 0.1,
            sustain: 0.16,
            release: 0.08,
            f_start: freq.max(180.0),
            f_peak: 980.0,
            f_end: 360.0,
            q: 3.2,
            f_attack: 0.04,
            wide: false,
            unison: 1,
            hold: Hold::Capped(0.4),
        },
        TrackKind::House => Voicing {
            wave: Wave::Triangle,
            detune: vec![-5.0, 6.0],
            peak: ev.vel * 0.16,
            attack: 0.016,
            decay: 0.18,
            sustain: 0.38,
            release: 0.16,
            f_start: 280.0,
            f_peak: 980.0,
            f_end: 420.0,
            q: 0.7,
            f_attack: 0.05,
            wide: true,
            unison: 2,
            hold: Hold::AsGiven,
        },
    }
}

fn pad_voicing(kind: TrackKind, ev: &NoteEvent) -> Voicing {
    let wave = if kind == TrackKind::Acid || kind == TrackKind::Lofi {
        Wave::Sine
    } else {
        Wave::Saw
    };
    Voicing {
        wave,
        // The original passes `notes.flatMap(() => [-9, 11])`, so the cents
        // alternate down the whole bank: 2N entries for an N-note chord, with
        // anything past the end of the list falling back to its last value.
        detune: (0..ev.notes.len())
            .flat_map(|_| [-9.0_f32, 11.0])
            .collect(),
        // Lo-fi and acid pads sit at 0.1; the brighter flavours pull back so the
        // pad does not fight the lead for space.
        peak: ev.vel
            * if matches!(kind, TrackKind::Lofi | TrackKind::Acid) {
                0.1
            } else {
                0.075
            },
        attack: match kind {
            TrackKind::Lofi => 0.7,
            TrackKind::Deep => 0.55,
            _ => 0.4,
        },
        decay: 0.35,
        sustain: 0.85,
        release: 0.55,
        f_start: 280.0,
        f_peak: match kind {
            TrackKind::Lofi => 520.0,
            TrackKind::Acid => 420.0,
            TrackKind::Deep => 760.0,
            TrackKind::House => 900.0,
        },
        f_end: 360.0,
        q: 0.5,
        f_attack: 0.4,
        wide: true,
        unison: 2,
        hold: Hold::AsGiven,
    }
}

fn arp_voicing(kind: TrackKind, ev: &NoteEvent) -> Voicing {
    let wave = match kind {
        TrackKind::Lofi => Wave::Sine,
        TrackKind::Deep => Wave::Triangle,
        TrackKind::Acid => Wave::Square,
        TrackKind::House => Wave::Square,
    };
    Voicing {
        wave,
        detune: vec![0.0],
        peak: ev.vel
            * if kind == TrackKind::Lofi {
                0.22
            } else if kind == TrackKind::Acid {
                0.14
            } else {
                0.24
            },
        attack: if kind == TrackKind::Lofi { 0.02 } else { 0.004 },
        decay: match kind {
            TrackKind::Lofi => 0.18,
            TrackKind::Deep => 0.12,
            _ => 0.07,
        },
        sustain: 0.12,
        release: 0.05,
        f_start: 500.0,
        f_peak: if kind == TrackKind::Lofi {
            880.0
        } else if ev.accent {
            2400.0
        } else {
            1600.0
        },
        f_end: 480.0,
        q: if kind == TrackKind::Acid { 3.0 } else { 1.0 },
        f_attack: 0.012,
        wide: false,
        unison: 1,
        hold: Hold::Shortened { floor: 0.05, scale: 1.0 },
    }
}

/// Shift an oscillator by a detune in cents, on a phase unrelated to its
/// neighbours.
///
/// Two oscillators a few cents apart beat against each other. If they also start at
/// the same phase they comb — a tone that swells and thins at the beat rate instead of
/// just sounding wide. Offsetting the phase by an irrational fraction of a cycle keeps
/// the beating without the cancellation.
fn detuned(wave: Wave, freq: f32, cents: f32, sample_rate: f32) -> Osc {
    let mut osc = Osc::new(wave, freq * 2f32.powf(cents / 1200.0), sample_rate);
    osc.advance_phase(0.37);
    osc
}

/// A single sounding pitch in a voice.
struct Partial {
    osc: Osc,
    /// Pan position, -1 (hard left) to 1 (hard right).
    pan: f32,
}

/// A pitched voice: detuned partials through an enveloped resonant lowpass into an
/// amplitude envelope.
pub struct ToneVoice {
    /// Which stem bus this voice feeds.
    stem: Stem,
    partials: Vec<Partial>,
    filter: StereoBiquad,
    env: Adsr,
    voicing: Voicing,
    /// Filter envelope position, in samples, and its stage durations.
    filt_stage: u8,
    filt_t: f32,
    /// Length of the closing sweep, in samples, computed when the sweep begins.
    filt_ramp: f32,
    sample_rate: f32,
    done: bool,
}

impl ToneVoice {
    /// Index of the stem bus this voice feeds, for the mixer's routing.
    pub fn stem_index(&self) -> usize {
        self.stem.index()
    }
}

impl ToneVoice {
    /// Build a voice on an explicit stem bus and voicing. The engine uses this so a
    /// bass note can layer a second voice with its own voicing but the same stem.
    pub fn with_stem(
        stem: Stem,
        ev: &NoteEvent,
        freq: f32,
        hold: f32,
        sample_rate: f32,
        v: Voicing,
    ) -> Self {
        // `freq` is only a fallback for an event with no notes; every caller derives
        // it from the event's first note, so an empty list stays a defensive case.
        let fallback = freq;
        let notes = if ev.notes.is_empty() {
            vec![fallback]
        } else {
            ev.notes.iter().map(|n| midi_hz(*n)).collect()
        };

        // One oscillator per entry in `freqs`, panned across the field.
        //
        // The original builds exactly as many oscillators as its `freqs` array holds,
        // and when the voice is wide with more than one it hangs a stereo panner on
        // each: entry `i` sits at `(i / (n - 1)) * 1.1 - 0.55`, so a chord spreads
        // evenly left to right. Most stems pass their notes straight through, one
        // oscillator each; `unison` is how a voicing asks for more than that, which is
        // what the pad does for every note and what the house lead does for its single
        // note.
        //
        // An earlier version doubled every note into a ±detune pair and mirrored the
        // pans. That put the lowest and highest notes at the extremes at the same time,
        // left the middle note dead centre, and added a chorus the original does not
        // have.
        let freqs: Vec<f32> = if v.unison > 1 && notes.len() == 1 {
            vec![notes[0]; v.unison]
        } else {
            notes
                .iter()
                .flat_map(|f| std::iter::repeat_n(*f, v.unison.max(1)))
                .collect()
        };
        let last = v.detune.len().saturating_sub(1);
        let partials: Vec<Partial> = freqs
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let cents = v.detune.get(i).copied().unwrap_or_else(|| v.detune[last]);
                let pan = if v.wide && freqs.len() > 1 {
                    (i as f32 / (freqs.len() - 1) as f32) * 1.1 - 0.55
                } else {
                    0.0
                };
                Partial {
                    osc: detuned(v.wave, *f, cents, sample_rate),
                    pan,
                }
            })
            .collect();
        let mut filter = StereoBiquad::new();
        filter.lowpass(sample_rate, v.f_start.max(30.0), v.q);
        Self {
            stem,
            partials,
            filter,
            env: Adsr::new(
                v.peak,
                v.attack,
                v.decay,
                v.sustain,
                // The gate the engine computed from the note's length, adjusted the way
                // this voicing asks for — a stab caps it so it cannot ring into the next
                // bar, the acid bass and the arp shorten it.
                v.hold.apply(hold),
                v.release,
                sample_rate,
            ),
            voicing: v,
            filt_stage: 0,
            filt_t: 0.0,
            filt_ramp: 1.0,
            sample_rate,
            done: false,
        }
    }

    /// Render one sample into `(left, right)`; `false` once the tail has finished.
    ///
    /// The signal path is `oscillators -> panners -> one filter -> envelope`, which is
    /// the reference's graph: every oscillator (through its panner, when the voice is
    /// wide) connects into a *single* `BiquadFilterNode`, so the filter sees the summed
    /// stereo signal once per sample and Web Audio gives each of its channels its own
    /// delay line.
    ///
    /// Running one mono biquad once per partial instead — as this did — breaks it twice
    /// over. The filter's state advances once per partial rather than once per sample,
    /// so its effective cutoff climbs with the size of the chord; and because every
    /// partial is pushed through the same delay line in sequence, each one comes out
    /// smeared with the others' history. Near-identical partials panned apart produce
    /// no width at all, because the stereo difference is what the panning was for: the
    /// pad and the stab, the two widest voicings in the engine, measured narrower than
    /// the hats.
    pub fn process(&mut self) -> (f32, f32, bool) {
        if self.done {
            return (0.0, 0.0, true);
        }
        let env = self.env.process();
        self.advance_filter();

        let mut left = 0.0f32;
        let mut right = 0.0f32;
        for p in &mut self.partials {
            let s = p.osc.next();
            // Equal-power pan, so widening a voice doesn't raise its peak level.
            let angle = (p.pan.clamp(-1.0, 1.0) + 1.0) * 0.25 * core::f32::consts::PI;
            left += s * angle.cos();
            right += s * angle.sin();
        }

        // One filter pass over the summed pair, then the amplitude envelope — the
        // reference wires `filter.connect(gain)`, not the other way round.
        let (l, r) = self.filter.process(left, right);
        if self.env.is_done() {
            self.done = true;
        }
        (l * env, r * env, self.done)
    }

    /// Drive the filter envelope: start → peak over `f_attack`, then peak → end
    /// across the gate. Matches the original's two-stage ramp.
    /// Advance the filter envelope: start → peak over `f_attack`, then peak → end
    /// across the gate. Matches the original's two-stage ramp, and only resamples
    /// the coefficients while the envelope is actually moving.
    fn advance_filter(&mut self) {
        let v = &self.voicing;
        let start_f = v.f_start.max(30.0);
        let peak_f = (start_f + 8.0).max(v.f_peak);
        let end_f = v.f_end.max(30.0);
        let attack = v.f_attack.max(0.008) * self.sample_rate;
        match self.filt_stage {
            0 => {
                self.filter.lowpass(self.sample_rate, start_f, v.q);
                self.filt_t = 0.0;
                self.filt_stage = 1;
            }
            1 => {
                self.filt_t += 1.0;
                let t = (self.filt_t / attack).min(1.0);
                self.filter
                    .lowpass(self.sample_rate, exp_between(start_f, peak_f, t), v.q);
                if self.filt_t >= attack {
                    // How long the closing sweep should take: from the end of the
                    // attack to the point the amplitude envelope releases.
                    self.filt_ramp =
                        (self.env.release_starts_at() - self.filt_t).max(1.0);
                    self.filt_t = 0.0;
                    self.filt_stage = 2;
                }
            }
            2 => {
                if !v.sweeps() {
                    // A flat filter gesture: park at the peak.
                    self.filter.lowpass(self.sample_rate, peak_f, v.q);
                    self.filt_stage = 3;
                    return;
                }
                // Close the filter exponentially across the note's gate, matching the
                // original's `exponentialRampToValueAtTime(endF, time + hold)`. A jump
                // here instead of a ramp leaves long pads bright and clicking at the
                // end, which is most of why a port of this reads as "thin and harsh".
                self.filt_t += 1.0;
                let t = (self.filt_t / self.filt_ramp).min(1.0);
                self.filter
                    .lowpass(self.sample_rate, exp_between(peak_f, end_f, t), v.q);
                if self.filt_t >= self.filt_ramp {
                    self.filt_t = 0.0;
                    self.filt_stage = 3;
                }
            }
            _ => {}
        }
    }

    pub fn release_now(&mut self) {
        self.env.release_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bass_voicing_matches_accent_brightness() {
        let plain = NoteEvent::new(vec![45.0], 1.0, 0.9, false);
        let accent = NoteEvent::new(vec![45.0], 1.0, 0.9, true);
        let a = voicing(Stem::Bass, TrackKind::Acid, &accent, 110.0);
        let b = voicing(Stem::Bass, TrackKind::Acid, &plain, 110.0);
        assert!(a.f_peak > b.f_peak);
        assert!(a.q > b.q);
    }

    #[test]
    fn house_bass_has_a_saw_layer_but_acid_does_not() {
        let ev = NoteEvent::new(vec![45.0], 1.0, 0.9, false);
        assert!(bass_sub_layer(Stem::Bass, TrackKind::House, &ev, 110.0).is_some());
        assert!(bass_sub_layer(Stem::Bass, TrackKind::Acid, &ev, 110.0).is_none());
    }

    /// The saw layer belongs to the bass and nothing else.
    ///
    /// It is called from inside a `for stem in Stem::TUNED` loop, and without the
    /// guard every melodic stem got a `vel * 0.28` resonant saw bolted under it —
    /// against the house pad's own `vel * 0.075` and 0.4 s attack, a transient some
    /// 300x too loud arriving instantly. Nothing in the suite could see it, because
    /// it is a voice that should not exist rather than a wrong value on one that should.
    #[test]
    fn only_the_bass_gets_the_saw_layer() {
        let ev = NoteEvent::new(vec![57.0, 60.0, 64.0], 8.0, 0.5, false);
        for kind in [TrackKind::House, TrackKind::Deep] {
            assert!(
                bass_sub_layer(Stem::Bass, kind, &ev, 110.0).is_some(),
                "{kind:?}: the bass should still get its saw layer"
            );
            for stem in Stem::TUNED {
                if stem == Stem::Bass {
                    continue;
                }
                assert!(
                    bass_sub_layer(stem, kind, &ev, 110.0).is_none(),
                    "{kind:?}: {stem:?} must not get the bass's saw layer"
                );
            }
        }
    }

    /// Velocity has to reach the lead, as it does every other tuned stem.
    #[test]
    fn the_lead_responds_to_velocity() {
        for kind in [
            TrackKind::Lofi,
            TrackKind::Deep,
            TrackKind::Acid,
            TrackKind::House,
        ] {
            let soft = NoteEvent::new(vec![69.0], 2.0, 0.3, false);
            let hard = NoteEvent::new(vec![69.0], 2.0, 0.9, false);
            let a = voicing(Stem::Lead, kind, &soft, 440.0);
            let b = voicing(Stem::Lead, kind, &hard, 440.0);
            assert!(
                b.peak > a.peak * 2.0,
                "{kind:?}: lead peak ignored velocity ({} vs {})",
                a.peak,
                b.peak
            );
        }
    }

    #[test]
    fn pad_and_house_stabs_are_wide_bass_is_not() {
        let ev = NoteEvent::new(vec![57.0, 60.0, 64.0], 8.0, 0.5, false);
        assert!(voicing(Stem::Pad, TrackKind::House, &ev, 220.0).wide);
        assert!(voicing(Stem::Stab, TrackKind::House, &ev, 220.0).wide);
        // Bass is mono in every flavour, so it never spreads.
        for kind in [
            TrackKind::House,
            TrackKind::Deep,
            TrackKind::Acid,
            TrackKind::Lofi,
        ] {
            assert!(!voicing(Stem::Bass, kind, &ev, 220.0).wide);
        }
    }

    #[test]
    fn tone_voice_finishes_after_release() {
        let sr = 48_000.0;
        let ev = NoteEvent::new(vec![57.0], 0.05, 0.6, false);
        let lead = voicing(Stem::Lead, TrackKind::House, &ev, 220.0);
        let mut v = ToneVoice::with_stem(Stem::Lead, &ev, 220.0, 0.05, sr, lead);
        let mut done = false;
        for _ in 0..(sr as usize) {
            if v.process().2 {
                done = true;
                break;
            }
        }
        assert!(done);
    }

    #[test]
    fn a_chord_spreads_left_to_right() {
        // The original hangs a stereo panner on each oscillator of a wide chord at
        // `(i / (n - 1)) * 1.1 - 0.55` — one oscillator per note, spread monotonically.
        let sr = 48_000.0;
        let ev = NoteEvent::new(vec![60.0, 64.0, 67.0], 0.05, 0.5, false);
        let stab = voicing(Stem::Stab, TrackKind::House, &ev, 440.0);
        let v = ToneVoice::with_stem(Stem::Stab, &ev, 440.0, 0.05, sr, stab);

        assert_eq!(v.partials.len(), 3, "one oscillator per note, not a pair");
        assert!((v.partials[0].pan + 0.55).abs() < 1e-6, "{:?}", pans(&v));
        assert!((v.partials[2].pan - 0.55).abs() < 1e-6, "{:?}", pans(&v));
        // Monotonic across the chord, so the stereo image matches the note order.
        assert!(v.partials[0].pan < v.partials[1].pan);
        assert!(v.partials[1].pan < v.partials[2].pan);
    }

    #[test]
    fn the_pad_doubles_every_note() {
        // `notes.flatMap(n => [hz, hz])` — the pad is a 2N-wide spread, not N.
        let sr = 48_000.0;
        let ev = NoteEvent::new(vec![48.0, 55.0, 60.0], 8.0, 0.5, false);
        let pad = voicing(Stem::Pad, TrackKind::House, &ev, 440.0);
        let v = ToneVoice::with_stem(Stem::Pad, &ev, 440.0, 0.05, sr, pad);

        assert_eq!(v.partials.len(), 6, "3 notes doubled");
        assert!((v.partials[0].pan + 0.55).abs() < 1e-6);
        assert!((v.partials[5].pan - 0.55).abs() < 1e-6, "{:?}", pans(&v));
    }

    #[test]
    fn the_house_lead_is_a_stereo_unison() {
        // `freqs: [freq, freq]` — one note, two oscillators, hard-ish left and right.
        // This is the whole character of the sound; a single centred oscillator is not
        // the same instrument.
        let sr = 48_000.0;
        let ev = NoteEvent::new(vec![64.0], 0.25, 0.5, false);
        let lead = voicing(Stem::Lead, TrackKind::House, &ev, 440.0);
        let v = ToneVoice::with_stem(Stem::Lead, &ev, 440.0, 0.05, sr, lead);

        assert_eq!(v.partials.len(), 2, "the lead doubles its single note");
        assert!((v.partials[0].pan + 0.55).abs() < 1e-6, "{:?}", pans(&v));
        assert!((v.partials[1].pan - 0.55).abs() < 1e-6, "{:?}", pans(&v));
    }

    #[test]
    fn a_single_note_stays_centred() {
        // Wide, but with one oscillator there is nothing to spread, so the original
        // hangs no panner at all.
        let sr = 48_000.0;
        let ev = NoteEvent::new(vec![60.0], 0.05, 0.5, false);
        let stab = voicing(Stem::Stab, TrackKind::Deep, &ev, 440.0);
        let v = ToneVoice::with_stem(Stem::Stab, &ev, 440.0, 0.05, sr, stab);
        assert_eq!(v.partials.len(), 1);
        assert_eq!(v.partials[0].pan, 0.0);
    }

    #[test]
    fn a_stab_caps_its_gate_but_the_pad_does_not() {
        // The original caps a house stab at 0.14 s and an acid stab at 0.08 s, so a
        // long note cannot ring into the next bar. The pad is left alone.
        let ev = NoteEvent::new(vec![60.0], 4.0, 0.8, false);
        let house_stab = voicing(Stem::Stab, TrackKind::House, &ev, 440.0);
        assert!((house_stab.hold.apply(4.0) - 0.14).abs() < 1e-6);
        let acid_stab = voicing(Stem::Stab, TrackKind::Acid, &ev, 440.0);
        assert!((acid_stab.hold.apply(4.0) - 0.08).abs() < 1e-6);
        let pad = voicing(Stem::Pad, TrackKind::House, &ev, 440.0);
        assert!((pad.hold.apply(4.0) - 4.0).abs() < 1e-6);
        // The acid bass shortens rather than caps, with a legibility floor.
        let bass = voicing(Stem::Bass, TrackKind::Acid, &ev, 440.0);
        assert!((bass.hold.apply(1.0) - 0.85).abs() < 1e-6);
        assert!((bass.hold.apply(0.0) - 0.05).abs() < 1e-6);
    }

    fn pans(v: &ToneVoice) -> Vec<f32> {
        v.partials.iter().map(|p| p.pan).collect()
    }

    #[test]
    fn sweeps_detects_flat_filter_gestures() {
        let v = voicing(
            Stem::Pad,
            TrackKind::House,
            &NoteEvent::new(vec![60.0], 8.0, 0.5, false),
            440.0,
        );
        // House pad sweeps 900 -> 360, so it should report a sweep.
        assert!(v.sweeps());
    }
}
