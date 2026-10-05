//! Bus mixing: per-stem faders, ducking, delay send, and master processing.
//!
//! Each stem accumulates into its own stereo buffer so a cut or solo takes effect
//! instantly at the fader without touching the voices, and so send levels stay
//! independent of fader position.

use crate::dsp::{soft_clip, Compressor, Delay, Limiter, Reverb, StereoBiquad};
use crate::track::{Stem, TrackKind};

/// Stereo accumulators for one stem.
#[derive(Clone, Copy, Default)]
pub struct Bus {
    pub left: f32,
    pub right: f32,
}

/// Mutable runtime state for one stem's channel strip.
pub struct Channel {
    pub bus: Bus,
    /// Fader target, 0..1, from the track's mix.
    pub vol: f32,
    /// Duck gain, multiplied by `vol` — this is the "pump".
    pub duck: f32,
    pub muted: bool,
    pub solo: bool,
    pub send: f32,
    /// Post-fader metering level, smoothed for display.
    pub level: f32,
}

impl Default for Channel {
    fn default() -> Self {
        Self {
            bus: Bus::default(),
            vol: 0.8,
            duck: 1.0,
            muted: false,
            solo: false,
            send: 0.0,
            level: 0.0,
        }
    }
}

impl Channel {
    #[inline]
    pub fn audible(&self, any_solo: bool) -> bool {
        !self.muted && (!any_solo || self.solo)
    }

    #[inline]
    pub fn gain(&self, any_solo: bool) -> f32 {
        if self.audible(any_solo) {
            self.vol * self.duck
        } else {
            0.0
        }
    }

    /// Post-fader peak for metering, decayed between blocks so meters fall smoothly.
    #[inline]
    pub fn meter(&mut self) {
        let peak = self.bus.left.abs().max(self.bus.right.abs()).min(1.0);
        self.level = if peak > self.level {
            peak
        } else {
            self.level * 0.8
        };
    }

    #[inline]
    pub fn clear(&mut self) {
        self.bus.left = 0.0;
        self.bus.right = 0.0;
    }
}

/// Master chain, wired in the same order and with the same stages as the Web Audio
/// engine it replaces:
///
/// ```text
/// stems ─┬─────────────────────────────────────────────► hp 28 Hz
///        ├─ pre 380 Hz ─► room ─► wet 0.07 ─────────────┤
///        ├─ echo hp 240 Hz ─► throw ─► ping-pong ─► wet ┤
///        └─ per-stem sends ─────────────────► ping-pong ┘
///                                                       ▼
///              hp 28 Hz ─► compressor ─► saturator ─► dry ─► low ─► mid
///                    ─► high ─► tape sweep ─► recorder ─► master gain ─► limiter
/// ```
///
/// The order matters and was wrong here before. Saturation and compression have to
/// happen *before* the EQ: the compressor is what stops the kick and bass from stacking
/// into the clipper, and it can only do that on the summed signal. Running the EQ first
/// and saturating last meant the low end arrived at the clipper already summed, with
/// nothing holding it down — which is what made the bass sound thin and the whole mix
/// feel harsh.
pub struct Master {
    pub low: StereoBiquad,
    pub mid: StereoBiquad,
    pub high: StereoBiquad,
    pub sweep: StereoBiquad,
    pub delay: Delay,
    pub gain: f32,
    /// Where the output sits between the two channels, 0 = mono-left, 0.5 = stereo,
    /// 1 = mono-right.
    ///
    /// Continuous rather than a three-way switch so the UI can offer a fader. The
    /// three old positions are exactly its 0, 0.5 and 1, so `set_stereo_mode` still
    /// means what it did.
    pub balance: f32,
    pub scope: [u8; 256],
    sample_rate: f32,
    scope_t: f32,
    sweep_open: f32,
    sweep_target: f32,
    filter_gain: f32,
    /// Rumble filter on the sum, before the dynamics stage.
    hp: StereoBiquad,
    comp: Compressor,
    /// Pre-filter on the reverb send, so the room does not amplify infrasonic content.
    /// Stereo: a lone `Biquad` run left-then-right shares one delay line between the
    /// channels, which is the contamination `StereoBiquad` exists to prevent. This
    /// filter and `echo_hp` were the two that the original conversion missed.
    verb_pre: StereoBiquad,
    verb: Reverb,
    verb_wet: f32,
    /// Highpass on the echo throw, keeping the delay out of the sub band. Stereo for
    /// the same reason as `verb_pre`.
    echo_hp: StereoBiquad,
    dry: f32,
    wet: f32,
    /// Extra send into the delay when the echo throw is engaged. Zero when off, so
    /// the per-stem sends pass straight through untouched.
    throw: f32,
    echo_on: bool,
    /// Previous input to the saturator, for the 2x oversampled curve, one per
    /// channel. A single shared value (as this was) built the right channel's
    /// interpolated midpoint from the current *left* sample, leaking left into right.
    shaper_prev: [f32; 2],
    /// Per-stem sends accumulated for the current sample, drained by `process`.
    send_acc: f32,
    /// Output safety ceiling, the very last stage. The EQ, tape filter and master gain
    /// all sit after the compressor and can lift the sum past full scale.
    limiter: Limiter,
}

/// The reverb's wet level, and the highpasses either side of the send.
const VERB_WET: f32 = 0.07;
const VERB_PRE_HZ: f32 = 380.0;
const ECHO_HP_HZ: f32 = 240.0;
const RUMBLE_HP_HZ: f32 = 28.0;
/// Equal-power makeup for the ping-pong returns, each repeat being on one side only.
const PING_PONG_GAIN: f32 = core::f32::consts::SQRT_2;
/// The output limiter: untouched below the knee, never past the ceiling.
const LIMIT_KNEE_DB: f32 = -3.0;
const LIMIT_CEILING_DB: f32 = -0.3;
const LIMIT_RELEASE: f32 = 0.08;

impl Master {
    pub fn new(sample_rate: f32) -> Self {
        let mut low = StereoBiquad::new();
        low.low_shelf(sample_rate, 180.0, 0.0);
        let mut mid = StereoBiquad::new();
        mid.peaking(sample_rate, 1000.0, 0.7, 0.0);
        let mut high = StereoBiquad::new();
        high.high_shelf(sample_rate, 3200.0, 0.0);
        let mut sweep = StereoBiquad::new();
        sweep.lowpass(sample_rate, 18_000.0, 0.45);
        let mut delay = Delay::new(sample_rate, 1.5);
        delay.set_feedback(0.3);

        let mut hp = StereoBiquad::new();
        hp.highpass(sample_rate, RUMBLE_HP_HZ, 0.7);
        let mut verb_pre = StereoBiquad::new();
        verb_pre.highpass(sample_rate, VERB_PRE_HZ, 0.7);
        let mut echo_hp = StereoBiquad::new();
        echo_hp.highpass(sample_rate, ECHO_HP_HZ, 0.7);

        Self {
            low,
            mid,
            high,
            sweep,
            delay,
            gain: 0.78,
            balance: 0.5,
            scope: [128; 256],
            sample_rate,
            scope_t: 0.0,
            sweep_open: 1.0,
            sweep_target: 1.0,
            filter_gain: 1.0,
            hp,
            // The dynamics stage's settings are the load-bearing part of this chain, so
            // they are named once here rather than spread through the process method.
            comp: Compressor::new(sample_rate, -12.0, 8.0, 2.6, 0.008, 0.2),
            verb_pre,
            verb: Reverb::new(sample_rate),
            verb_wet: VERB_WET,
            echo_hp,
            dry: 1.0,
            wet: 0.24,
            throw: 0.0,
            echo_on: false,
            shaper_prev: [0.0; 2],
            send_acc: 0.0,
            limiter: Limiter::new(sample_rate, LIMIT_KNEE_DB, LIMIT_CEILING_DB, LIMIT_RELEASE),
        }
    }

    pub fn reset(&mut self) {
        self.delay.reset();
        self.low.reset();
        self.mid.reset();
        self.high.reset();
        self.sweep.reset();
        self.hp.reset();
        self.verb_pre.reset();
        self.echo_hp.reset();
        self.verb.reset();
        self.comp.reset();
        self.shaper_prev = [0.0; 2];
        self.limiter.reset();
    }

    /// Accumulate a stem's send for this sample. The line itself is written exactly
    /// once per sample, in [`Master::process`].
    ///
    /// Accumulating rather than writing is load-bearing. [`Delay::write_input`]
    /// advances the write pointer, so calling it per send ran the line at the number
    /// of sends: six sending stems x two channels is twelve pointer advances per
    /// audio sample, which put the dotted-eighth echo at 20 ms instead of 357 ms and
    /// made the delay time change when the echo throw added a thirteenth write. It
    /// also stepped the time and feedback glides twelve times per sample. The echo
    /// was not an echo, it was a 20 ms metallic comb.
    ///
    /// Takes both channels so the two-call pattern that caused this cannot recur.
    /// The send is mono into the ping-pong's left line, so the pair is averaged,
    /// matching the echo throw's own `0.5 * (l + r)`.
    #[inline]
    pub fn feed_send(&mut self, left: f32, right: f32, amount: f32) {
        if amount > 0.0 {
            self.send_acc += 0.5 * (left + right) * amount;
        }
    }

    pub fn echo_on(&self) -> bool {
        self.echo_on
    }

    /// Multiplier applied to a stem's delay send. The throw is not folded in here; it
    /// is a separate send off the sum.
    #[inline]
    pub fn send_gain(&self) -> f32 {
        1.0
    }

    pub fn mix_dry(&self) -> f32 {
        self.dry
    }

    pub fn mix_wet(&self) -> f32 {
        self.wet
    }

    /// Convert a 0..1 filter position to a cutoff, exponentially from 240 Hz to
    /// 18 kHz so the useful range is spread evenly under the finger.
    pub fn filter_freq(open: f32) -> f32 {
        let a = open.clamp(0.0, 1.0);
        240.0 * (18_000.0_f32 / 240.0).powf(a)
    }

    pub fn set_filter(&mut self, open: f32) {
        self.sweep_target = open.clamp(0.0, 1.0);
    }

    pub fn set_eq(&mut self, low_db: f32, mid_db: f32, high_db: f32) {
        self.low.low_shelf(self.sample_rate, 180.0, low_db);
        self.mid.peaking(self.sample_rate, 1000.0, 0.7, mid_db);
        self.high.high_shelf(self.sample_rate, 3200.0, high_db);
    }

    /// Beat-synced dotted-eighth delay.
    pub fn set_delay_time(&mut self, bpm: f32, rate: f32) {
        let dotted = (60.0 / (bpm * rate.max(0.2))).clamp(0.05, 1.2) * 0.75;
        self.delay.set_time(dotted);
    }

    /// The echo throw: the summed bus, high-passed, fed into the delay line, plus a
    /// wet/dry swap and longer feedback so repeats sustain.
    ///
    /// The direct sound never routes through the delay — the line is fed by the
    /// per-stem sends plus this throw — so the echo is purely additive and the dry
    /// signal keeps its own level. Turning it on pulls the mix wetter and opens the
    /// feedback up.
    pub fn set_echo(&mut self, on: bool) {
        self.echo_on = on;
        if on {
            self.throw = 0.9;
            self.dry = 0.55;
            self.wet = 0.95;
            self.delay.set_feedback(0.78);
        } else {
            self.throw = 0.0;
            self.dry = 1.0;
            self.wet = 0.24;
            self.delay.set_feedback(0.3);
        }
    }

    /// The glue saturator, run at twice the sample rate.
    ///
    /// `tanh` is a memoryless nonlinearity, so at 1x every harmonic it generates above
    /// Nyquist folds straight back into the audible band as aliasing — audible as grit
    /// on the bass and hats right where the signal is hottest. Interpolating up one
    /// octave, saturating both interpolated points and averaging them back down puts an
    /// anti-image filter in front of the fold, which is what the Web Audio waveshaper's
    /// `oversample = "2x"` does.
    ///
    /// `ch` is 0 for left and 1 for right: the interpolation reads the previous sample
    /// of the *same* channel.
    #[inline]
    fn saturate(&mut self, ch: usize, x: f32) -> f32 {
        const AMOUNT: f32 = 1.35;
        let prev = &mut self.shaper_prev[ch & 1];
        let up = 0.5 * (x + *prev);
        *prev = x;
        0.5 * (soft_clip(up, AMOUNT) + soft_clip(x, AMOUNT))
    }

    /// Render one stereo sample through the master chain. `left`/`right` are the
    /// summed stem buses. Per-stem sends must already have been pushed via
    /// [`Master::feed_send`] for this sample; the wet taps are read once here.
    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        // Glide the tape filter toward its target rather than jumping.
        self.sweep_open += (self.sweep_target - self.sweep_open) * 0.0008;
        let freq = Self::filter_freq(self.sweep_open);
        let q = if self.sweep_open > 0.97 { 0.45 } else { 0.85 };
        self.sweep.lowpass(self.sample_rate, freq, q);

        // --- The delay line: exactly one write per sample, carrying the per-stem
        // sends accumulated for this sample plus the echo throw off the summed bus.
        // Read the tap before writing, so the line delays rather than feeding this
        // sample straight back out.
        //
        // Stereo ping-pong: each repeat lands on one side only, so the returns are
        // lifted by sqrt(2) to keep the echo's power where the mono return had it
        // (the mono line put every repeat on both sides at full level).
        let (wet_l, wet_r) = self.delay.tap_stereo();
        let (wet_l, wet_r) = (wet_l * PING_PONG_GAIN, wet_r * PING_PONG_GAIN);
        let throw = if self.throw > 0.0 {
            let (t_l, t_r) = self.echo_hp.process(left, right);
            0.5 * (t_l + t_r) * self.throw
        } else {
            0.0
        };
        self.delay.write_input(self.send_acc + throw);
        self.send_acc = 0.0;

        // --- Reverb send, tapped off the summed buses before any master processing.
        let (send_l, send_r) = self.verb_pre.process(left, right);
        let (verb_l, verb_r) = self.verb.process(send_l, send_r);

        // --- Rumble filter, taking the sum and every wet return together.
        let (mut l, mut r) = self.hp.process(
            left + verb_l * self.verb_wet + wet_l * self.wet,
            right + verb_r * self.verb_wet + wet_r * self.wet,
        );

        // --- Dynamics, then the saturator, then the dry trim. Both sit *before* the EQ
        // so the low end is controlled on the summed signal rather than after it has
        // already been shaped.
        // Stereo-linked: one detector step per sample, one gain for both sides.
        (l, r) = self.comp.process_stereo(l, r);
        l *= self.dry;
        r *= self.dry;

        l = self.saturate(0, l);
        r = self.saturate(1, r);

        // --- EQ and the tape filter, after the glue.
        (l, r) = self.low.process(l, r);
        (l, r) = self.mid.process(l, r);
        (l, r) = self.high.process(l, r);
        (l, r) = self.sweep.process(l, r);

        l *= self.gain;
        r *= self.gain;

        // Collapse toward one channel or the other. Below centre the right channel is
        // pulled toward the left, above it the left is pulled toward the right, so the
        // ends are mono and the middle is untouched stereo.
        let b = self.balance.clamp(0.0, 1.0);
        let (mut out_l, mut out_r) = if b < 0.5 {
            (l, l + (r - l) * (b * 2.0))
        } else {
            (l + (r - l) * ((b - 0.5) * 2.0), r)
        };
        out_l *= self.filter_gain;
        out_r *= self.filter_gain;

        // --- The safety ceiling, last of all, so nothing upstream can clip the output.
        (out_l, out_r) = self.limiter.process(out_l, out_r);

        self.scope_t += 1.0;
        if self.scope_t >= self.sample_rate / 60.0 {
            self.scope_t = 0.0;
            self.push_scope((out_l + out_r) * 0.5);
        }

        (out_l, out_r)
    }

    /// Advance the oscilloscope trace one pixel per frame at a fixed 60 Hz.
    fn push_scope(&mut self, sample: f32) {
        let v = (sample.clamp(-1.0, 1.0) * 127.0 + 128.0) as u8;
        self.scope.rotate_right(1);
        self.scope[0] = v;
    }

    pub fn set_master(&mut self, gain: f32) {
        self.gain = gain.clamp(0.0, 1.0);
    }
}

/// Per-stem duck automation driven by the kick.
pub struct Ducker {
    /// Gain the ducked stems fall to at the moment of the hit.
    floor: f32,
    /// Recovery length in beats, from the track flavour. Kept so the recovery time
    /// can be *recomputed* at each tempo rather than derived from its own last value.
    beats: f32,
    /// Seconds for the stems to recover back to unity.
    recovery: f32,
    stems: Vec<usize>,
    /// Phase through the duck, 0 at the hit and 1 when fully recovered.
    phase: f32,
    active: bool,
}

impl Ducker {
    /// Recovery time at a tempo. Matches the reference's
    /// `min(0.48, (60 / bpm) * beats)` — the cap is the reference's, and it binds
    /// below about 73 bpm for `deep`.
    fn recovery_for(beats: f32, bpm: f32, sample_rate: f32) -> f32 {
        let back = ((60.0 / bpm.max(40.0)) * beats).min(0.48);
        back.max(1.0 / sample_rate.max(1.0))
    }

    pub fn new(kind: TrackKind, bpm: f32, sample_rate: f32) -> Self {
        let (floor, beats) = Stem::duck_shape(kind);
        Self {
            floor,
            beats,
            recovery: Self::recovery_for(beats, bpm, sample_rate),
            stems: Stem::ducks_under(kind).iter().map(|s| s.index()).collect(),
            phase: 1.0,
            active: false,
        }
    }

    /// Trigger a duck at the current tempo.
    ///
    /// Recomputed from `beats`, not from the previous `recovery`. Multiplying the
    /// stored value by `60 / bpm` again on every hit (as this did) decays it
    /// geometrically: at 126 bpm the house pump went 0.262 s, 0.125, 0.059, ... and
    /// was under a millisecond — inaudible — eight kicks in. The duck still reached
    /// its floor, so no level test caught it; the four-on-the-floor breathing just
    /// vanished a bar into every track.
    pub fn trigger(&mut self, bpm: f32, sample_rate: f32) {
        self.recovery = Self::recovery_for(self.beats, bpm, sample_rate);
        self.phase = 0.0;
        self.active = true;
    }

    /// How many samples a full recovery takes at this tempo, for the engine to
    /// schedule against.
    pub fn recovery_samples(&self, sample_rate: f32) -> u32 {
        (self.recovery * sample_rate).ceil() as u32
    }

    /// Advance one sample and write the current duck gain into the affected channels.
    ///
    /// The drop is instantaneous and the return to unity is linear across `recovery`,
    /// matching the reference's `setValueAtTime(floor, t)` followed by
    /// `linearRampToValueAtTime(1, t + back)`. An earlier version glided *into* the
    /// floor over the first 15% of the recovery, which at 126 bpm is a 39 ms fade
    /// where the kick wants a step, and squeezed the ramp back into the other 85%.
    pub fn apply(&mut self, channels: &mut [Channel; 8], sample_rate: f32) {
        for &i in &self.stems {
            if let Some(c) = channels.get_mut(i) {
                c.duck = 1.0;
            }
        }
        if !self.active {
            return;
        }
        self.phase += 1.0 / (self.recovery * sample_rate).max(1.0);
        if self.phase >= 1.0 {
            self.phase = 1.0;
            self.active = false;
        }
        let g = self.floor + (1.0 - self.floor) * self.phase;
        for &i in &self.stems {
            if let Some(c) = channels.get_mut(i) {
                c.duck = g;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The echo has to arrive where the tempo says it does.
    ///
    /// This is measured through the real call pattern — several stems feeding sends
    /// before each `process` — because that pattern is what broke. A test that calls
    /// `Delay::process` once per sample cannot see it: the fault was one pointer
    /// advance per *send*, so the error scaled with how many stems were sending.
    #[test]
    fn the_echo_lands_on_the_dotted_eighth_whatever_is_sending() {
        let sr = 48_000.0;
        let bpm = 126.0;
        // A dotted eighth at 126 bpm: (60 / 126) * 0.75.
        let expected = (60.0 / bpm) * 0.75;

        for sending_stems in [1usize, 6] {
            let mut m = Master::new(sr);
            m.set_delay_time(bpm, 1.0);
            // Let the time glide settle off its 0.25 s default before measuring.
            for _ in 0..(sr as usize) {
                m.process(0.0, 0.0);
            }

            // A short burst through the sends, then silence, watching for the repeat.
            let mut onset = None;
            for i in 0..(sr as usize) {
                let drive = if i < (sr * 0.01) as usize { 0.6 } else { 0.0 };
                for _ in 0..sending_stems {
                    m.feed_send(drive, drive, 0.3);
                }
                m.process(0.0, 0.0);
                if onset.is_none() && i > (sr * 0.02) as usize && m.delay.tap().abs() > 0.02 {
                    onset = Some(i as f32 / sr);
                }
            }

            let onset = onset.expect("the delay never returned anything");
            assert!(
                (onset - expected).abs() < 0.02,
                "{sending_stems} sending stem(s): echo arrived at {onset:.4} s, \
                 expected {expected:.4} s"
            );
        }
    }

    /// The echo is a ping-pong: the first repeat on the left, the second on the right,
    /// and so on, each at the dotted eighth after the last.
    #[test]
    fn successive_repeats_alternate_sides() {
        let sr = 48_000.0;
        let bpm = 126.0;
        let step = (60.0 / bpm) * 0.75;
        let mut m = Master::new(sr);
        m.set_delay_time(bpm, 1.0);
        m.set_echo(true);
        for _ in 0..(sr as usize) {
            m.process(0.0, 0.0);
        }
        // A short burst into the sends only, so nothing but the echo reaches the output.
        let total = (sr * step * 4.6) as usize;
        let mut out = Vec::with_capacity(total);
        for i in 0..total {
            let drive = if i < (sr * 0.01) as usize { 0.6 } else { 0.0 };
            m.feed_send(drive, drive, 0.3);
            out.push(m.process(0.0, 0.0));
        }
        for k in 1..=4usize {
            let at = (k as f32 * step * sr) as usize;
            let (mut el, mut er) = (0.0f32, 0.0f32);
            for (l, r) in &out[at.saturating_sub(480)..(at + 1440).min(total)] {
                el += l * l;
                er += r * r;
            }
            assert!(el + er > 1e-6, "repeat {k} is missing");
            if k % 2 == 1 {
                assert!(
                    el > er * 20.0,
                    "repeat {k} should be on the left: L {el} R {er}"
                );
            } else {
                assert!(
                    er > el * 20.0,
                    "repeat {k} should be on the right: L {el} R {er}"
                );
            }
        }
    }

    /// Engaging the echo must not move the delay time.
    #[test]
    fn the_echo_throw_does_not_retune_the_delay() {
        let sr = 48_000.0;
        let onset = |echo: bool| -> f32 {
            let mut m = Master::new(sr);
            m.set_delay_time(126.0, 1.0);
            m.set_echo(echo);
            for _ in 0..(sr as usize) {
                m.process(0.0, 0.0);
            }
            for i in 0..(sr as usize) {
                let drive = if i < (sr * 0.01) as usize { 0.6 } else { 0.0 };
                m.feed_send(drive, drive, 0.3);
                m.process(drive, drive);
                if i > (sr * 0.02) as usize && m.delay.tap().abs() > 0.02 {
                    return i as f32 / sr;
                }
            }
            f32::NAN
        };
        let (off, on) = (onset(false), onset(true));
        assert!(
            (off - on).abs() < 0.02,
            "echo moved the delay time: {off:.4} s off vs {on:.4} s on"
        );
    }

    /// The pump has to still be there after a few bars.
    ///
    /// `trigger` used to fold `60 / bpm` into the previous recovery value, so the
    /// duck shortened geometrically and the breathing was gone within two bars while
    /// still passing any test that only asked whether the gain reached its floor.
    #[test]
    fn the_duck_recovery_does_not_shrink_across_hits() {
        let sr = 48_000.0;
        let bpm = 126.0;
        let mut d = Ducker::new(TrackKind::House, bpm, sr);
        let mut chans: [Channel; 8] = std::array::from_fn(|_| Channel::default());

        let mut lengths = Vec::new();
        for _ in 0..16 {
            d.trigger(bpm, sr);
            // Count the samples until the duck has recovered to unity.
            let mut n = 0usize;
            loop {
                d.apply(&mut chans, sr);
                n += 1;
                if !d.active || n > (sr as usize) {
                    break;
                }
            }
            lengths.push(n as f32 / sr);
        }

        let first = lengths[0];
        let expected = ((60.0 / bpm) * 0.55f32).min(0.48);
        assert!(
            (first - expected).abs() < 0.005,
            "first duck was {first:.4} s, expected {expected:.4} s"
        );
        for (i, l) in lengths.iter().enumerate() {
            assert!(
                (l - first).abs() < 0.005,
                "duck {i} lasted {l:.4} s against the first at {first:.4} s: {lengths:?}"
            );
        }
    }

    #[test]
    fn solo_isolates_the_soloed_stems() {
        let mut chans: [Channel; 8] = std::array::from_fn(|_| Channel::default());
        chans[0].solo = true;
        let any_solo = true;
        assert!(chans[0].gain(any_solo) > 0.0);
        for c in chans.iter().skip(1) {
            assert_eq!(c.gain(any_solo), 0.0);
        }
    }

    #[test]
    fn mute_zeroes_gain_even_when_soloed() {
        let c = Channel {
            muted: true,
            solo: true,
            ..Channel::default()
        };
        assert_eq!(c.gain(true), 0.0);
    }

    #[test]
    fn filter_position_is_exponential_and_clamped() {
        assert!((Master::filter_freq(0.0) - 240.0).abs() < 1.0);
        assert!(Master::filter_freq(1.0) > 17_000.0);
        assert_eq!(Master::filter_freq(2.0), Master::filter_freq(1.0));
        assert_eq!(Master::filter_freq(-1.0), Master::filter_freq(0.0));
    }

    #[test]
    fn echo_engages_and_disengages_the_send() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        assert!(!m.echo_on());
        // A stem's own send is never scaled by the throw: the throw is a separate
        // input to the line, taken off the summed bus rather than off each stem.
        assert_eq!(m.send_gain(), 1.0, "stems send at unity regardless of echo");
        m.set_echo(true);
        assert!(m.echo_on());
        assert_eq!(m.send_gain(), 1.0, "echo does not rescale the stem sends");
        assert!(m.mix_wet() > m.mix_dry(), "echo pulls the mix wetter");
        m.set_echo(false);
        assert!(!m.echo_on());
        assert_eq!(m.send_gain(), 1.0);
        assert_eq!(m.mix_dry(), 1.0, "dry signal untouched with echo off");
    }

    #[test]
    fn the_room_still_rings_after_the_input_stops() {
        // The chain ends in a 0.32 s room. Tapping a short burst and then feeding
        // silence must produce a decaying tail, not a hard cut — this is the send
        // that makes the mix sound like a recording rather than a sum of oscillators.
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        let hit = (sr * 0.05) as usize / 128;
        for i in 0..hit {
            let t = i as f32 * 128.0 / sr;
            m.process(0.5 * (t * 220.0 * std::f32::consts::TAU).sin(), 0.0);
        }

        let mut peaks = Vec::new();
        for _ in 0..12 {
            let (l, _) = m.process(0.0, 0.0);
            peaks.push(l.abs());
        }
        assert!(
            peaks[0] > 1e-4,
            "the room should still be sounding after the input stops: {peaks:?}"
        );
        assert!(peaks[11] < peaks[0], "the tail should decay: {peaks:?}");
    }

    #[test]
    fn echo_lengthens_the_delay_tail() {
        // Measured on the delay line itself rather than on the master output. The echo
        // configuration deliberately pulls the dry signal down to 0.55, so any
        // end-to-end comparison is dominated by that duck rather than by the repeats,
        // and the room on the master bus decays over a comparable time again. The line
        // is the thing the echo actually changes.
        let sr = 48_000.0;
        let tail = |echo: bool| -> f32 {
            let mut m = Master::new(sr);
            m.set_delay_time(150.0, 1.0);
            m.set_echo(echo);
            // A short burst, then silence.
            for _ in 0..(sr as usize) / 8 {
                let (l, r) = m.process(0.5, 0.0);
                let _ = l + r;
            }
            let mut energy = 0.0;
            for _ in 0..(sr as usize) * 2 {
                let (l, _) = m.process(0.0, 0.0);
                let tap = m.delay.tap();
                energy += tap * tap + l * l * 0.01;
            }
            energy
        };

        let off = tail(false);
        let on = tail(true);
        assert!(off > 0.0, "the dry delay send should still ring a little");
        assert!(
            on > off * 5.0,
            "echo should sustain the line: off {off:.5} on {on:.5}"
        );
    }

    #[test]
    fn the_compressor_holds_the_sum_down() {
        // A loud, continuous low tone is the case the dynamics stage exists for. With
        // no compressor the sum reaches the clipper and the saturator distorts it; the
        // compressor's job is to pull it back first. Threshold is -12 dB at 2.6:1, so a
        // 0.8 tone should come out meaningfully lower than the same chain would pass
        // it uncompressed.
        //
        // The bound is relative to that uncompressed level rather than an absolute
        // number. It used to be `< 0.45`, which was calibrated on a detector whose
        // one-pole weights were swapped: it followed the waveform sample by sample and
        // squashed each peak like a waveshaper. With real 8 ms / 200 ms ballistics the
        // detector sits a little under the sine's crest, so the reduction is a few dB
        // rather than six, and it is gain riding rather than distortion.
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        let uncompressed = m.gain * soft_clip(0.8, 1.35);
        let mut peak = 0.0f32;
        for i in 0..(sr as usize) {
            let t = i as f32 / sr;
            let (l, _) = m.process(0.8 * (t * 220.0 * std::f32::consts::TAU).sin(), 0.0);
            if i > 4800 {
                // Past the 8 ms attack, so the measurement is of steady state.
                peak = peak.max(l.abs());
            }
        }
        // At least 2.5 dB of reduction, and no more than about 9 dB.
        assert!(
            peak < uncompressed * 0.75,
            "the sum is not being held down: {uncompressed:.3} uncompressed, {peak:.3} out"
        );
        assert!(
            peak > uncompressed * 0.35,
            "the compressor is over-reducing: {uncompressed:.3} uncompressed, {peak:.3} out"
        );
    }

    /// A hard-panned source has to stay on its own side through the whole chain.
    ///
    /// The saturator's 2x interpolation used one `shaper_prev` for both channels, so
    /// the right channel's midpoint was built from the current left sample and a
    /// hard-left source leaked audibly into the right.
    #[test]
    fn a_hard_left_source_stays_off_the_right_channel() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        let mut left_peak = 0.0f32;
        let mut right_peak = 0.0f32;
        for i in 0..(sr as usize) {
            let t = i as f32 / sr;
            let (l, r) = m.process(0.7 * (t * 110.0 * std::f32::consts::TAU).sin(), 0.0);
            left_peak = left_peak.max(l.abs());
            right_peak = right_peak.max(r.abs());
        }
        assert!(
            left_peak > 0.1,
            "the left side should carry the tone: {left_peak}"
        );
        assert!(
            right_peak < 1e-6,
            "left leaked into the right channel at {right_peak}"
        );
    }

    /// The master's compressor has to release over the time it was configured with.
    ///
    /// Two faults hid this. The detector's one-pole had its weights swapped, so the
    /// envelope followed the signal sample by sample with no release at all; and the
    /// master ran one mono compressor left-then-right, stepping it twice per sample.
    /// After a drop the detector must close 63% of the gap in one release time
    /// constant, 0.2 s, not instantly and not in 0.1 s.
    #[test]
    fn the_compressor_releases_over_its_configured_time() {
        let sr = 48_000.0;
        let release = 0.2;
        let mut c = Compressor::new(sr, -12.0, 8.0, 2.6, 0.008, release);
        // Settle on a loud level, on the left only: the link has to see it anyway.
        for _ in 0..(sr as usize) {
            c.process_stereo(0.5, 0.0);
        }
        let loud = c.envelope_db();
        let quiet_db = 20.0 * 0.05f32.log10();
        let target = quiet_db + (loud - quiet_db) * (-1.0f32).exp();
        let mut crossed = None;
        for i in 0..(sr as usize) {
            c.process_stereo(0.0, 0.05);
            if crossed.is_none() && c.envelope_db() <= target {
                crossed = Some(i as f32 / sr);
            }
        }
        let t = crossed.expect("the detector never released");
        assert!(
            (t - release).abs() < release * 0.05,
            "released in {t:.4} s, configured {release} s"
        );
    }

    /// Linked: both channels take the same gain, whichever side is loud.
    #[test]
    fn the_compressor_applies_one_gain_to_both_channels() {
        let mut c = Compressor::new(48_000.0, -12.0, 8.0, 2.6, 0.008, 0.2);
        let mut last = (0.0, 0.0);
        for _ in 0..4_800 {
            last = c.process_stereo(0.9, 0.1);
        }
        let (gl, gr) = (last.0 / 0.9, last.1 / 0.1);
        assert!(gl < 0.8, "a 0.9 peak should be reduced, gain {gl}");
        assert!((gl - gr).abs() < 1e-6, "gains differ: {gl} vs {gr}");
    }

    /// Normal levels leave the limiter idle: unity gain the whole way through.
    #[test]
    fn the_limiter_is_idle_at_normal_levels() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        for i in 0..(sr as usize) {
            let t = i as f32 / sr;
            let v = 0.25 * (t * 220.0 * std::f32::consts::TAU).sin();
            m.process(v, v);
            assert_eq!(m.limiter.gain(), 1.0, "limiter engaged at sample {i}");
        }
    }

    #[test]
    fn stereo_modes_collapse_channels() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        m.balance = 0.0;
        let (l, r) = m.process(0.5, -0.5);
        assert!((l - r).abs() < 1e-6, "left mode not mono {l} {r}");
        m.balance = 1.0;
        let (l, r) = m.process(0.5, -0.5);
        assert!((l - r).abs() < 1e-6, "right mode not mono");
    }

    #[test]
    fn scope_tracks_the_signal() {
        let sr = 48_000.0;
        let mut m = Master::new(sr);
        // A sine, not a constant: the chain opens with a 28 Hz highpass, which removes
        // a DC level almost entirely, so a steady input would correctly draw a flat
        // centre line.
        // The trace advances one pixel per frame at 60 Hz, so run long enough for
        // the whole 256-pixel window to be written before inspecting it.
        for i in 0..(sr as usize * 5) {
            let t = i as f32 / sr;
            let v = 0.8 * (t * 440.0 * std::f32::consts::TAU).sin();
            m.process(v, v);
        }
        // The trace samples one point per frame at 60 Hz, so it aliases any musical
        // pitch — a 440 Hz tone read at 60 Hz lands wherever the fold puts it. What the
        // trace has to do is move off the centre line when there is signal and come
        // back to it when there is not, which is what this checks.
        let off_centre = m.scope.iter().filter(|b| **b != 128).count();
        assert!(
            off_centre > m.scope.len() / 2,
            "trace did not follow the signal: only {off_centre} of {} pixels moved",
            m.scope.len()
        );

        // Silence should settle back to the centre line.
        m.reset();
        for _ in 0..(sr as usize * 5) {
            m.process(0.0, 0.0);
        }
        let off_centre = m.scope.iter().filter(|b| **b != 128).count();
        assert!(off_centre < m.scope.len() / 4, "trace should recentre");
    }
}
