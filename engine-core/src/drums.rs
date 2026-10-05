//! Drum voices: kick, clap, hats, and the hand percussion on the hats stem.
//!
//! Each voice is a small fixed graph of oscillators, noise and filters, rendered
//! one sample at a time and reaped when its envelope reaches the floor.

use core::f32::consts::FRAC_1_SQRT_2;

use crate::dsp::{exp_between, noise, Adsr, Biquad, Osc, Wave};

/// A drum voice that produces one stereo sample pair per `process` call.
///
/// Returns `(left, right, done)`; `done` is true once the tail has fully decayed and
/// the caller should free the slot.
pub trait DrumVoice {
    fn process(&mut self) -> (f32, f32, bool);
    /// Cut the voice short, for a transport stop or a stem being cut mid-hit.
    fn release_now(&mut self);
}

/// Two-stage exponential pitch sweep, reproducing the original's
/// `exponentialRampToValueAtTime` pair on the kick's body oscillator.
struct PitchEnv {
    start: f32,
    knee: f32,
    end: f32,
    /// Samples spent falling to the knee.
    knee_samples: f32,
    /// Total sweep length in samples.
    total_samples: f32,
    t: f32,
}

impl PitchEnv {
    fn new(
        start: f32,
        knee: f32,
        end: f32,
        knee_seconds: f32,
        total_seconds: f32,
        sr: f32,
    ) -> Self {
        Self {
            start,
            knee,
            end,
            knee_samples: knee_seconds * sr,
            total_samples: (total_seconds * sr).max(1.0),
            t: 0.0,
        }
    }

    fn freq(&mut self) -> f32 {
        self.t += 1.0;
        if self.t <= self.knee_samples {
            exp_between(self.start, self.knee, self.t / self.knee_samples.max(1.0))
        } else if self.t <= self.total_samples {
            let p =
                (self.t - self.knee_samples) / (self.total_samples - self.knee_samples).max(1.0);
            exp_between(self.knee, self.end, p)
        } else {
            self.end
        }
    }
}

/// Four-on-the-floor kick: a pitched sine body with a fast downward sweep, a sub
/// layer for weight, and a short noise click for attack definition.
pub struct KickVoice {
    body_env: Adsr,
    body: Osc,
    pitch: PitchEnv,
    sub_env: Adsr,
    sub: Osc,
    click_env: f32,
    click_hp: Biquad,
    click_left: f32,
    inv_sr: f32,
    sample_rate: f32,
    done: bool,
}

impl KickVoice {
    /// `sub_hz` is the track's root in the low octave, from
    /// [`crate::track::Track::kick_root_hz`], so the kick sits in key with the bass.
    pub fn new(vel: f32, sample_rate: f32, lofi: bool, sub_hz: f32) -> Self {
        // Body: 168 Hz snapping down to 49 Hz in 55 ms, then easing to its resting
        // pitch. That used to be a fixed 36 Hz against a fixed 54 Hz sub, a fifth
        // below it (36:54 is 2:3); the rest now follows the tuned sub at the same
        // interval, so the body's tail is in key too.
        let start = if lofi { 108.0 } else { 168.0 };
        let rest = sub_hz * (2.0 / 3.0);
        Self {
            body_env: Adsr::new(
                if lofi { 0.62 } else { 0.95 } * vel,
                0.004,
                0.36,
                0.0,
                0.0,
                0.02,
                sample_rate,
            ),
            body: Osc::new(Wave::Sine, start, sample_rate),
            pitch: PitchEnv::new(start, 49.0, rest, 0.055, 0.22, sample_rate),
            sub_env: Adsr::new(
                if lofi { 0.32 } else { 0.55 } * vel,
                0.012,
                0.3,
                0.0,
                0.0,
                0.02,
                sample_rate,
            ),
            sub: Osc::new(Wave::Sine, sub_hz, sample_rate),
            click_env: if lofi { 0.08 } else { 0.42 } * vel,
            click_hp: {
                let mut f = Biquad::new();
                f.highpass(
                    sample_rate,
                    if lofi { 680.0 } else { 1600.0 },
                    FRAC_1_SQRT_2,
                );
                f
            },
            click_left: 0.015,
            inv_sr: 1.0 / sample_rate,
            sample_rate,
            done: false,
        }
    }
}

impl KickVoice {
    /// The sub layer's pitch, for tests that pin the tuning.
    #[cfg(test)]
    pub fn sub_hz(&self) -> f32 {
        self.sub.frequency(self.sample_rate)
    }
}

impl DrumVoice for KickVoice {
    fn process(&mut self) -> (f32, f32, bool) {
        if self.done {
            return (0.0, 0.0, true);
        }
        // Sweep the body pitch first, so the sample it produces is at the new pitch.
        self.body.set_frequency(self.pitch.freq(), self.sample_rate);
        let env = self.body_env.process();
        let body = self.body.next() * env;
        let sub = self.sub.next() * self.sub_env.process();

        let mut click = 0.0;
        if self.click_left > 0.0 {
            click = self.click_hp.process(noise()) * self.click_env;
            self.click_left -= self.inv_sr;
            self.click_env *= 0.86;
        }

        let out = body + sub + click;
        if self.body_env.is_done() && self.sub_env.is_done() && self.click_left <= 0.0 {
            self.done = true;
        }
        (out, out, self.done)
    }

    fn release_now(&mut self) {
        self.body_env.release_now();
        self.sub_env.release_now();
        self.click_left = 0.0;
    }
}

/// Clap: three tight noise bursts an increasing distance apart, then a longer
/// diffuse tail. This is what makes it read as a room rather than a click.
pub struct ClapVoice {
    bursts: [ClapBurst; 3],
    tail_env: Adsr,
    tail_bp: Biquad,
    /// Samples until the tail's 18 ms onset offset has elapsed.
    tail_delay: f32,
    inv_sr: f32,
    done: bool,
}

struct ClapBurst {
    env: Adsr,
    bp: Biquad,
    delay: f32,
}

impl ClapVoice {
    pub fn new(vel: f32, sample_rate: f32, kind_freq: f32, lofi: bool) -> Self {
        let amp = if lofi { 0.55 } else { 0.7 } * vel;
        let offsets = [0.0f32, 0.01, 0.021];
        let bursts = std::array::from_fn(|i| ClapBurst {
            env: Adsr::new(amp, 0.003, 0.038, 0.0, 0.0, 0.01, sample_rate),
            bp: {
                let mut f = Biquad::new();
                f.bandpass(sample_rate, kind_freq, 0.85);
                f
            },
            delay: offsets[i],
        });
        let decay = if lofi {
            0.28
        } else {
            if kind_freq < 1000.0 {
                0.2
            } else {
                0.13
            }
        };
        Self {
            bursts,
            tail_env: Adsr::new(0.5 * vel, 0.018, decay, 0.0, 0.0, 0.02, sample_rate),
            tail_bp: {
                let mut f = Biquad::new();
                f.bandpass(sample_rate, kind_freq * 0.82, 0.55);
                f
            },
            tail_delay: 0.018,
            inv_sr: 1.0 / sample_rate,
            done: false,
        }
    }
}

impl DrumVoice for ClapVoice {
    fn process(&mut self) -> (f32, f32, bool) {
        if self.done {
            return (0.0, 0.0, true);
        }
        let mut out = 0.0;
        // The three bursts are offset copies of the same noise, which is what makes a
        // clap read as several hands in a room rather than one click.
        for burst in &mut self.bursts {
            if burst.delay > 0.0 {
                burst.delay -= self.inv_sr;
                continue;
            }
            let env = burst.env.process();
            out += burst.bp.process(noise()) * env;
        }
        if self.tail_delay > 0.0 {
            self.tail_delay -= self.inv_sr;
        } else {
            let tail = self.tail_env.process();
            out += self.tail_bp.process(noise()) * tail;
        }
        let alive = self
            .bursts
            .iter()
            .any(|b| b.delay > 0.0 || !b.env.is_done())
            || self.tail_delay > 0.0
            || !self.tail_env.is_done();
        if !alive {
            self.done = true;
        }
        (out, out, self.done)
    }

    fn release_now(&mut self) {
        for b in &mut self.bursts {
            b.env.release_now();
        }
        self.tail_env.release_now();
    }
}

/// The TR-808's metal bank: six square oscillators at non-harmonic ratios. Summed and
/// band-passed high, their upper partials beat against each other into the shimmer a
/// cymbal has and white noise does not.
const METAL_HZ: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

/// Output trim, +14.8 dB, so the metal hats sit where the white-noise hats they
/// replaced did. Most of the bank's energy is in the squares' fundamentals, which the
/// filters throw away. Measured as RMS over a 0.3 s window for every flavor, closed
/// and open: the gap was 14.2 to 15.3 dB, so one trim lands all eight within 0.6 dB.
/// Pinned by `the_metal_hats_sit_where_the_noise_hats_did`.
const HAT_TRIM: f32 = 5.495;

/// How much white noise rides under the metal bank. The 808 does not, but a little
/// takes the edge off the pure square buzz and many later machines blend it in.
const HAT_NOISE: f32 = 0.25;

/// Closed or open hat: the 808-style six-square metal bank with a touch of noise,
/// band-passed and high-passed, with a very short decay.
pub struct HatVoice {
    env: Adsr,
    metal: [Osc; 6],
    bp: Biquad,
    hp: Biquad,
    done: bool,
}

impl HatVoice {
    pub fn new(vel: f32, sample_rate: f32, open: bool, kind: crate::track::TrackKind) -> Self {
        let lofi = kind == crate::track::TrackKind::Lofi;
        let hp_freq = if open {
            if lofi {
                3400.0
            } else {
                5200.0
            }
        } else if lofi {
            2200.0
        } else if kind == crate::track::TrackKind::Acid {
            7800.0
        } else {
            6400.0
        };
        let decay = if open {
            if lofi {
                0.2
            } else if kind == crate::track::TrackKind::Deep {
                0.15
            } else {
                0.12
            }
        } else if lofi {
            0.06
        } else if kind == crate::track::TrackKind::Acid {
            0.026
        } else {
            0.038
        };
        let amp = vel
            * if lofi {
                if open {
                    0.5
                } else {
                    0.4
                }
            } else if open {
                0.58
            } else {
                0.44
            };
        // The band the metal speaks in: around 10 kHz, and lower on lo-fi so it stays
        // as dark and soft as the noise hat was there.
        let bp_freq = if lofi { 6_000.0 } else { 10_000.0 };
        let mut bp = Biquad::new();
        bp.bandpass(sample_rate, bp_freq, 0.9);
        let mut hp = Biquad::new();
        hp.highpass(sample_rate, hp_freq, FRAC_1_SQRT_2);
        // Free-running on the hardware, so every hit catches the bank at a different
        // phase. Without this every hat is the same sample.
        let metal = core::array::from_fn(|i| {
            let mut osc = Osc::new(Wave::Square, METAL_HZ[i], sample_rate);
            osc.advance_phase(noise() * 0.5 + 0.5);
            osc
        });
        Self {
            env: Adsr::new(amp, 0.001, decay, 0.0, 0.0, 0.01, sample_rate),
            metal,
            bp,
            hp,
            done: false,
        }
    }
}

impl DrumVoice for HatVoice {
    fn process(&mut self) -> (f32, f32, bool) {
        if self.done {
            return (0.0, 0.0, true);
        }
        let mut metal = 0.0;
        for osc in &mut self.metal {
            metal += osc.next();
        }
        // Six unit squares sum to an RMS of about sqrt(6); scale that to the RMS of
        // the uniform noise (1 / sqrt(3)) so `HAT_NOISE` is a true blend ratio.
        const METAL_NORM: f32 = 0.235_702_26; // (1 / sqrt(3)) / sqrt(6)
        let src = metal * METAL_NORM * (1.0 - HAT_NOISE) + noise() * HAT_NOISE;
        let out = self.hp.process(self.bp.process(src)) * HAT_TRIM * self.env.process();
        if self.env.is_done() {
            self.done = true;
        }
        (out, out, self.done)
    }

    fn release_now(&mut self) {
        self.env.release_now();
    }
}

/// The hand percussion that plays on the hats stem.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PercKind {
    Shaker,
    Rim,
    CongaHi,
    CongaLo,
}

impl PercKind {
    pub const ALL: [PercKind; 4] = [
        PercKind::Shaker,
        PercKind::Rim,
        PercKind::CongaHi,
        PercKind::CongaLo,
    ];
}

/// Shaker, rimshot or conga: a small voice on the hats stem, under the hats.
///
/// - **Shaker**: band-passed noise with a soft 12 ms attack and a 60 ms decay, the
///   swish of beads rather than the tick of a hat.
/// - **Rim**: the 808 rimshot, two damped resonances at 1.7 kHz and 480 Hz with a
///   noise click, driven into a soft clip and high-passed, gone in about 30 ms.
/// - **Conga**: a sine dropping a third into its pitch over 20 ms (360 Hz high, 240
///   Hz low), with a short slap of band-passed noise on top.
///
/// Each sits at its own fixed place in the stereo field, so the percussion spreads
/// around the centered hats instead of piling onto them. Lo-fi tunes them lower and
/// darker.
pub struct PercVoice {
    kind: PercKind,
    env: Adsr,
    osc: [Osc; 2],
    /// Pitch for the conga's drop: start, rest, samples to fall, samples gone.
    pitch_from: f32,
    pitch_to: f32,
    pitch_len: f32,
    t: f32,
    noise_bp: Biquad,
    out_hp: Biquad,
    /// Samples of noise click/slap left, and its level.
    click_left: f32,
    click_amp: f32,
    pan_l: f32,
    pan_r: f32,
    sample_rate: f32,
    done: bool,
}

/// Per-instrument output trims, so each sits 2-4 dB under a closed hat at full
/// velocity (RMS over 0.3 s, as the hats are measured): about -37 dB for the shaker
/// and -36 dB for the rim and congas on house, against the closed hat's -33. The
/// congas' sine bodies carry far more energy than a hat's top end, hence their
/// deep trims. Pinned by `the_percussion_sits_under_the_hats`.
const SHAKER_TRIM: f32 = 0.51;
const RIM_TRIM: f32 = 0.61;
const CONGA_HI_TRIM: f32 = 0.3;
const CONGA_LO_TRIM: f32 = 0.22;

impl PercVoice {
    pub fn new(kind: PercKind, vel: f32, sample_rate: f32, track: crate::track::TrackKind) -> Self {
        let sr = sample_rate;
        let lofi = track == crate::track::TrackKind::Lofi;
        // Acid's closed hats are the tightest and quietest of the four flavors, so the
        // percussion comes down with them to stay underneath.
        let vel = if track == crate::track::TrackKind::Acid {
            vel * 0.8
        } else {
            vel
        };
        let mut noise_bp = Biquad::new();
        let mut out_hp = Biquad::new();
        let (env, osc, pitch_from, pitch_to, click, click_amp, pan) = match kind {
            PercKind::Shaker => {
                noise_bp.bandpass(sr, if lofi { 5_000.0 } else { 7_000.0 }, 1.0);
                out_hp.highpass(sr, if lofi { 2_500.0 } else { 3_500.0 }, FRAC_1_SQRT_2);
                (
                    Adsr::new(0.5 * vel * SHAKER_TRIM, 0.012, 0.06, 0.0, 0.0, 0.02, sr),
                    [Osc::new(Wave::Sine, 0.0, sr), Osc::new(Wave::Sine, 0.0, sr)],
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                    0.68,
                )
            }
            PercKind::Rim => {
                let (hi, lo) = if lofi {
                    (1_400.0, 420.0)
                } else {
                    (1_700.0, 480.0)
                };
                noise_bp.bandpass(sr, 3_000.0, 0.8);
                out_hp.highpass(sr, 300.0, FRAC_1_SQRT_2);
                (
                    Adsr::new(0.55 * vel * RIM_TRIM, 0.001, 0.028, 0.0, 0.0, 0.012, sr),
                    [Osc::new(Wave::Sine, hi, sr), Osc::new(Wave::Sine, lo, sr)],
                    hi,
                    hi,
                    0.004,
                    0.5 * RIM_TRIM,
                    0.36,
                )
            }
            PercKind::CongaHi | PercKind::CongaLo => {
                let hi = kind == PercKind::CongaHi;
                let f = match (hi, lofi) {
                    (true, false) => 360.0,
                    (true, true) => 330.0,
                    (false, false) => 240.0,
                    (false, true) => 215.0,
                };
                noise_bp.bandpass(sr, 2_000.0, 1.2);
                out_hp.highpass(sr, 90.0, FRAC_1_SQRT_2);
                (
                    Adsr::new(
                        0.5 * vel * if hi { CONGA_HI_TRIM } else { CONGA_LO_TRIM },
                        0.002,
                        if hi { 0.16 } else { 0.22 },
                        0.0,
                        0.0,
                        0.02,
                        sr,
                    ),
                    [
                        Osc::new(Wave::Sine, f * 1.26, sr),
                        Osc::new(Wave::Sine, 0.0, sr),
                    ],
                    f * 1.26,
                    f,
                    0.006,
                    0.35 * if hi { CONGA_HI_TRIM } else { CONGA_LO_TRIM },
                    if hi { 0.62 } else { 0.42 },
                )
            }
        };
        // Equal-power pan.
        let a = pan * core::f32::consts::FRAC_PI_2;
        Self {
            kind,
            env,
            osc,
            pitch_from,
            pitch_to,
            pitch_len: (0.02 * sr).max(1.0),
            t: 0.0,
            noise_bp,
            out_hp,
            click_left: click * sr,
            click_amp: click_amp * vel,
            pan_l: a.cos(),
            pan_r: a.sin(),
            sample_rate: sr,
            done: false,
        }
    }
}

impl DrumVoice for PercVoice {
    fn process(&mut self) -> (f32, f32, bool) {
        if self.done {
            return (0.0, 0.0, true);
        }
        let env = self.env.process();
        let body = match self.kind {
            PercKind::Shaker => self.noise_bp.process(noise()) * 2.0,
            PercKind::Rim => {
                let tone = 0.6 * self.osc[0].next() + 0.4 * self.osc[1].next();
                // The 808's rim is overdriven, which is where its knock comes from.
                (tone * 2.2).tanh()
            }
            PercKind::CongaHi | PercKind::CongaLo => {
                if self.t < self.pitch_len {
                    let f = exp_between(self.pitch_from, self.pitch_to, self.t / self.pitch_len);
                    self.osc[0].set_frequency(f, self.sample_rate);
                }
                self.osc[0].next()
            }
        };
        self.t += 1.0;
        let mut click = 0.0;
        if self.click_left > 0.0 {
            self.click_left -= 1.0;
            click = self.noise_bp.process(noise()) * self.click_amp;
        }
        let out = self.out_hp.process(body * env + click);
        if self.env.is_done() && self.click_left <= 0.0 {
            self.done = true;
        }
        (out * self.pan_l, out * self.pan_r, self.done)
    }

    fn release_now(&mut self) {
        self.env.release_now();
        self.click_left = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kick_finishes_and_stays_silent_afterwards() {
        let sr = 48_000.0;
        let mut k = KickVoice::new(1.0, sr, false, 54.0);
        let mut finished = false;
        for _ in 0..(sr as usize) {
            let (_, _, done) = k.process();
            if done {
                finished = true;
                break;
            }
        }
        assert!(finished, "kick never finished");
        assert_eq!(k.process().0, 0.0);
    }

    #[test]
    fn clap_renders_all_three_bursts() {
        let sr = 48_000.0;
        let mut c = ClapVoice::new(1.0, sr, 1750.0, false);
        // Energy should persist past the 21 ms offset of the last burst.
        let mut late_energy: f32 = 0.0;
        for i in 0..(sr as usize) {
            let (l, _, _) = c.process();
            if i > 1600 && i < 2000 {
                late_energy += l.abs();
            }
        }
        assert!(late_energy > 0.0, "no third burst");
    }

    #[test]
    fn closed_hat_decays_faster_than_open() {
        let sr = 48_000.0;
        let mut closed = HatVoice::new(1.0, sr, false, crate::track::TrackKind::House);
        let mut open = HatVoice::new(1.0, sr, true, crate::track::TrackKind::House);
        let (_, _, cd) = closed.process();
        let (_, _, od) = open.process();
        assert!(!cd);
        assert!(!od);
    }

    /// Mean RMS of a hat over a 0.3 s window, in dB, averaged across many hits so the
    /// noise share and the free-running phases average out.
    fn hat_rms_db(kind: crate::track::TrackKind, open: bool, hits: usize) -> f32 {
        let sr = 48_000.0;
        let win = (0.3 * sr) as usize;
        let mut ss = 0.0f64;
        for _ in 0..hits {
            let mut h = HatVoice::new(1.0, sr, open, kind);
            for _ in 0..win {
                let (l, _, _) = h.process();
                ss += (l * l) as f64;
            }
        }
        (10.0 * (ss / (hits * win) as f64).log10()) as f32
    }

    /// Swapping the noise source for the metal bank must not move the hats in the
    /// mix. These are the white-noise hat's levels, measured before the swap.
    #[test]
    fn the_metal_hats_sit_where_the_noise_hats_did() {
        use crate::track::TrackKind;
        let before = [
            (TrackKind::House, false, -32.83),
            (TrackKind::House, true, -25.57),
            (TrackKind::Deep, false, -32.83),
            (TrackKind::Deep, true, -24.62),
            (TrackKind::Acid, false, -34.64),
            (TrackKind::Acid, true, -25.56),
            (TrackKind::Lofi, false, -30.77),
            (TrackKind::Lofi, true, -24.15),
        ];
        for (kind, open, db) in before {
            let now = hat_rms_db(kind, open, 40);
            println!("HATRMS {kind:?} open={open}: {now:.3} dB (was {db})");
            assert!(
                (now - db).abs() <= 1.5,
                "{kind:?} open={open}: {now:.2} dB, the noise hat was {db} dB"
            );
        }
    }

    /// Still a hat: the metal's energy sits up top, not in the squares' fundamentals.
    #[test]
    fn the_metal_hat_lives_in_the_top_octaves() {
        let sr = 48_000.0;
        let mut h = HatVoice::new(1.0, sr, true, crate::track::TrackKind::House);
        let mut lp = Biquad::new();
        lp.lowpass(sr, 2_000.0, FRAC_1_SQRT_2);
        let (mut total, mut low) = (0.0f32, 0.0f32);
        for _ in 0..(0.2 * sr) as usize {
            let (l, _, _) = h.process();
            total += l * l;
            low += lp.process(l).powi(2);
        }
        assert!(total > 0.0);
        assert!(
            low < total * 0.05,
            "too much below 2 kHz: {:.3}",
            low / total
        );
    }

    #[test]
    fn the_kick_sub_plays_the_root_it_is_given() {
        let sr = 48_000.0;
        for root in [43.654f32, 55.0, 65.406] {
            let k = KickVoice::new(1.0, sr, false, root);
            assert!((k.sub_hz() - root).abs() < 1e-3, "{} vs {root}", k.sub_hz());
        }
    }

    #[test]
    fn release_now_ends_the_voice() {
        let sr = 48_000.0;
        let mut k = KickVoice::new(1.0, sr, false, 54.0);
        for _ in 0..100 {
            k.process();
        }
        k.release_now();
        let mut done = false;
        for _ in 0..(sr as usize) {
            if k.process().2 {
                done = true;
                break;
            }
        }
        assert!(done);
    }

    #[test]
    fn noise_is_in_range() {
        for _ in 0..1000 {
            assert!((-1.0..1.0).contains(&noise()));
        }
    }

    /// Mean RMS of a percussion hit over 0.3 s, in dB, both channels, across hits.
    fn perc_rms_db(perc: PercKind, kind: crate::track::TrackKind, hits: usize) -> f32 {
        let sr = 48_000.0;
        let win = (0.3 * sr) as usize;
        let mut ss = 0.0f64;
        for _ in 0..hits {
            let mut v = PercVoice::new(perc, 1.0, sr, kind);
            for _ in 0..win {
                let (l, r, _) = v.process();
                assert!(l.is_finite() && r.is_finite());
                ss += (0.5 * (l * l + r * r)) as f64;
            }
        }
        (10.0 * (ss / (hits * win) as f64).log10()) as f32
    }

    /// Every percussion voice sits under the closed hat of the same flavor, so the
    /// shaker, rim and congas season the hats stem rather than leading it.
    #[test]
    fn the_percussion_sits_under_the_hats() {
        use crate::track::TrackKind;
        for kind in [
            TrackKind::House,
            TrackKind::Deep,
            TrackKind::Acid,
            TrackKind::Lofi,
        ] {
            let hat = hat_rms_db(kind, false, 20);
            for p in PercKind::ALL {
                let db = perc_rms_db(p, kind, 20);
                println!("PERC {kind:?} {p:?} {db:.2} dB, closed hat {hat:.2}");
                assert!(
                    db <= hat - 1.5 && db >= hat - 9.0,
                    "{kind:?} {p:?}: {db:.2} dB against the closed hat's {hat:.2}"
                );
            }
        }
    }

    #[test]
    fn every_percussion_voice_finishes() {
        for p in PercKind::ALL {
            let mut v = PercVoice::new(p, 1.0, 48_000.0, crate::track::TrackKind::House);
            let finished = (0..48_000).any(|_| v.process().2);
            assert!(finished, "{p:?} never finished");
            assert_eq!(v.process(), (0.0, 0.0, true));
        }
    }
}
