//! DSP primitives: noise, oscillators, envelopes, filters, delay lines.
//!
//! Filter coefficients follow the Audio EQ Cookbook (Robert Bristow-Johnson) so the
//! resulting curves match the Web Audio graph this engine replaces.

use core::f32::consts::FRAC_1_SQRT_2;

/// Highest phase increment per sample, just under Nyquist.
const MAX_INC: f32 = 0.49;

/// Gain floor, matching Web Audio's convention of ramping to a near-zero rather than true zero.
const EPS: f32 = 0.0001;

/// Shared free-running white-noise source for the percussion voices. A single
/// stream is cheaper than per-voice RNG state and perceptually identical for hats,
/// claps and kick clicks.
pub fn noise() -> f32 {
    use std::cell::Cell;
    thread_local! {
        static STATE: Cell<u32> = const { Cell::new(0x02f6_e2b1) };
    }
    STATE.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        s.set(x);
        (x as f32 * (1.0 / 2147483648.0)) - 1.0
    })
}

/// Geometric interpolation between two positive gains.
///
/// Web Audio's `exponentialRampToValueAtTime` moves linearly in the log domain, so
/// pitches and amplitudes decay on a curve the ear reads as natural rather than linear.
pub fn geom(from: f32, to: f32, t: f32) -> f32 {
    from * (to / from.max(1e-9)).powf(t.clamp(0.0, 1.0))
}

/// Exponential interpolation between two positive frequencies, for filter sweeps.
pub fn exp_between(from: f32, to: f32, t: f32) -> f32 {
    geom(from.max(20.0), to.max(20.0), t)
}

// ---------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wave {
    Sine,
    Saw,
    Square,
    Triangle,
}

/// Single-cycle correction for the discontinuity in a naive ramp.
///
/// Two-sample polynomial blep (Finke): zero away from the discontinuity, ±1 at it,
/// which is exactly the shape needed to cancel the step a naive ramp introduces at
/// the wrap point. Without this, saw and square alias audibly at the higher notes in
/// the arp and lead stems. Costs two comparisons per sample.
fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        x + x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + x + x + 1.0
    } else {
        0.0
    }
}

pub struct Osc {
    phase: f32,
    inc: f32,
    wave: Wave,
}

/// Cycles per sample for a frequency in Hz.
///
/// `phase` runs 0..1 over one cycle — `next` multiplies it by `TAU` for the sine and
/// wraps it at `1.0` — so this is just `freq / sample_rate`. There is no radian
/// conversion to apply here, and folding one in detunes every voice in the engine by
/// that factor.
#[inline]
fn phase_inc(freq: f32, sample_rate: f32) -> f32 {
    let sr = if sample_rate > 0.0 {
        sample_rate
    } else {
        48_000.0
    };
    (freq / sr).clamp(0.0, MAX_INC)
}

impl Osc {
    pub fn new(wave: Wave, freq: f32, sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            inc: phase_inc(freq, sample_rate),
            wave,
        }
    }

    /// Offset the read position, for spreading layered copies of a pitch apart in phase.
    pub fn advance_phase(&mut self, phase: f32) {
        self.phase = (self.phase + phase.fract()).fract();
    }

    /// Retune while running, used by pitch-enveloped voices like the kick body.
    /// Phase is preserved so the sweep is continuous rather than clicking.
    pub fn set_frequency(&mut self, freq: f32, sample_rate: f32) {
        self.inc = phase_inc(freq, sample_rate);
    }

    pub fn next(&mut self) -> f32 {
        let out = match self.wave {
            Wave::Sine => (self.phase * core::f32::consts::TAU).sin(),
            Wave::Saw => 2.0 * self.phase - 1.0 - poly_blep(self.phase, self.inc),
            Wave::Square => {
                let raw = if self.phase < 0.5 { 1.0 } else { -1.0 };
                raw + poly_blep(self.phase, self.inc)
                    - poly_blep((self.phase + 0.5).fract(), self.inc)
            }
            Wave::Triangle => 4.0 * (self.phase - 0.5).abs() - 1.0,
        };
        self.phase += self.inc;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Amplitude envelope
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EnvStage {
    Attack,
    Decay,
    Hold,
    Release,
    Done,
}

/// ADSR with exponential segments and an explicit hold, driven one sample at a time.
///
/// Mirrors the attack/decay/sustain/hold/release shape of the original Web Audio
/// `GainNode` automation so existing tuning carries over. Times are given in seconds
/// and converted to sample counts on construction, since the envelope advances one
/// sample per `process` call and has to stay correct at any render rate.
pub struct Adsr {
    stage: EnvStage,
    elapsed: f32,
    peak: f32,
    sustain: f32,
    /// Durations in samples.
    attack: f32,
    decay: f32,
    hold_end: f32,
    release: f32,
    level: f32,
}

impl Adsr {
    pub fn new(
        peak: f32,
        attack: f32,
        decay: f32,
        sustain: f32,
        hold: f32,
        release: f32,
        sample_rate: f32,
    ) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        let p = peak.max(0.001);
        let s = (p * sustain.clamp(0.0, 1.0)).max(0.001);
        let a = (attack.max(0.004) * sr).max(1.0);
        let d = (decay.max(0.004) * sr).max(1.0);
        let r = (release.max(0.012) * sr).max(1.0);
        let h = (hold.max(0.0) * sr).max(0.0);
        // Release begins once the envelope has both finished decaying and held long
        // enough for the note's gate length, whichever is later.
        let hold_end = (a + d).max(h.max(a));
        Self {
            stage: EnvStage::Attack,
            elapsed: 0.0,
            peak: p,
            sustain: s,
            attack: a,
            decay: d,
            hold_end,
            release: r,
            level: EPS,
        }
    }

    /// Skip straight to release, for voices cut off mid-flight (a loop jump, a
    /// track swap, or an explicit stem cut).
    pub fn release_now(&mut self) {
        if !matches!(self.stage, EnvStage::Done) {
            self.stage = EnvStage::Release;
            self.elapsed = 0.0;
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self.stage, EnvStage::Done)
    }

    /// When, in samples from note-on, the envelope will start releasing.
    ///
    /// The tone voice needs this to time its filter sweep, which in the original
    /// ramps across the whole note rather than jumping at the end.
    pub fn release_starts_at(&self) -> f32 {
        self.hold_end
    }

    pub fn process(&mut self) -> f32 {
        self.elapsed += 1.0;
        self.level = match self.stage {
            EnvStage::Attack => {
                let v = geom(EPS, self.peak, self.elapsed / self.attack);
                if self.elapsed >= self.attack {
                    self.stage = EnvStage::Decay;
                    self.elapsed -= self.attack;
                }
                v
            }
            EnvStage::Decay => {
                let v = geom(self.peak, self.sustain, self.elapsed / self.decay);
                if self.elapsed >= self.decay {
                    self.stage = EnvStage::Hold;
                }
                v
            }
            EnvStage::Hold => {
                if self.elapsed >= self.hold_end {
                    self.stage = EnvStage::Release;
                    self.elapsed = 0.0;
                }
                self.sustain
            }
            EnvStage::Release => {
                let v = geom(self.sustain, EPS, self.elapsed / self.release);
                if self.elapsed >= self.release {
                    self.stage = EnvStage::Done;
                    EPS
                } else {
                    v
                }
            }
            EnvStage::Done => return 0.0,
        };
        self.level
    }
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/// Transposed direct-form II biquad with runtime coefficient updates.
///
/// Coefficients are recomputed on demand rather than per sample; the caller updates
/// at control rate, which is inaudible for envelopes this fast and keeps the inner
/// loop to four multiply-adds.
#[derive(Default, Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    pub fn new() -> Self {
        Self {
            b0: 1.0,
            ..Self::default()
        }
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }

    fn assign(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        let inv = 1.0 / a0.max(1e-9);
        self.b0 = b0 * inv;
        self.b1 = b1 * inv;
        self.b2 = b2 * inv;
        self.a1 = a1 * inv;
        self.a2 = a2 * inv;
    }

    pub fn lowpass(&mut self, sr: f32, freq: f32, q: f32) {
        let (cw, alpha) = coeffs(sr, freq, q);
        let b = (1.0 - cw) * 0.5;
        self.assign(b, 1.0 - cw, b, 1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    pub fn highpass(&mut self, sr: f32, freq: f32, q: f32) {
        let (cw, alpha) = coeffs(sr, freq, q);
        let a = (1.0 + cw) * 0.5;
        self.assign(a, -(1.0 + cw), a, 1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    /// Constant-peak-gain bandpass — matches `BiquadFilterNode`'s default response.
    pub fn bandpass(&mut self, sr: f32, freq: f32, q: f32) {
        let (cw, alpha) = coeffs(sr, freq, q);
        self.assign(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cw, 1.0 - alpha);
    }

    pub fn peaking(&mut self, sr: f32, freq: f32, q: f32, db: f32) {
        let (cw, alpha) = coeffs(sr, freq, q);
        let amp = 10f32.powf(db / 40.0);
        self.assign(
            1.0 + alpha * amp,
            -2.0 * cw,
            1.0 - alpha * amp,
            1.0 + alpha / amp,
            -2.0 * cw,
            1.0 - alpha / amp,
        );
    }

    pub fn low_shelf(&mut self, sr: f32, freq: f32, db: f32) {
        let (cw, alpha) = coeffs(sr, freq, FRAC_1_SQRT_2);
        let amp = 10f32.powf(db / 40.0);
        let sqrt_a = amp.sqrt();
        let two_sqrt_a_alpha = 2.0 * sqrt_a * alpha;
        self.assign(
            amp * ((amp + 1.0) - (amp - 1.0) * cw + two_sqrt_a_alpha),
            2.0 * amp * ((amp - 1.0) - (amp + 1.0) * cw),
            amp * ((amp + 1.0) - (amp - 1.0) * cw - two_sqrt_a_alpha),
            (amp + 1.0) + (amp - 1.0) * cw + two_sqrt_a_alpha,
            -2.0 * ((amp - 1.0) + (amp + 1.0) * cw),
            (amp + 1.0) + (amp - 1.0) * cw - two_sqrt_a_alpha,
        );
    }

    pub fn high_shelf(&mut self, sr: f32, freq: f32, db: f32) {
        let (cw, alpha) = coeffs(sr, freq, FRAC_1_SQRT_2);
        let amp = 10f32.powf(db / 40.0);
        let sqrt_a = amp.sqrt();
        let two_sqrt_a_alpha = 2.0 * sqrt_a * alpha;
        self.assign(
            amp * ((amp + 1.0) + (amp - 1.0) * cw + two_sqrt_a_alpha),
            -2.0 * amp * ((amp - 1.0) + (amp + 1.0) * cw),
            amp * ((amp + 1.0) + (amp - 1.0) * cw - two_sqrt_a_alpha),
            (amp + 1.0) - (amp - 1.0) * cw + two_sqrt_a_alpha,
            2.0 * ((amp - 1.0) - (amp + 1.0) * cw),
            (amp + 1.0) - (amp - 1.0) * cw - two_sqrt_a_alpha,
        );
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0.mul_add(
            x,
            self.b1.mul_add(
                self.x1,
                self.b2
                    .mul_add(self.x2, -(self.a1.mul_add(self.y1, self.a2 * self.y2))),
            ),
        );
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// `cos(w0)` and `alpha = sin(w0) / 2Q` for a normalised frequency.
fn coeffs(sr: f32, freq: f32, q: f32) -> (f32, f32) {
    let f = freq.clamp(20.0, sr * 0.49);
    let w0 = 2.0 * core::f32::consts::PI * f / sr;
    (w0.cos(), w0.sin() / (2.0 * q.max(0.05)))
}

/// One-pole lowpass, used for damping the delay feedback path.
pub struct OnePole {
    coef: f32,
    z: f32,
}

impl OnePole {
    pub fn new(sr: f32, cutoff: f32) -> Self {
        Self {
            coef: 1.0 - (-2.0 * core::f32::consts::PI * cutoff / sr).exp(),
            z: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        self.z += self.coef * (x - self.z);
        self.z
    }

    pub fn reset(&mut self) {
        self.z = 0.0;
    }
}

/// Circular delay line with a damped feedback path.
///
/// Both delay time and feedback glide toward their targets, which is what makes the
/// tempo-synced echo slide rather than jump when the tempo or the echo throw changes.
pub struct Delay {
    buf: Vec<f32>,
    size: usize,
    write: usize,
    time: f32,
    target_time: f32,
    time_coef: f32,
    feedback: f32,
    target_feedback: f32,
    fb_coef: f32,
    damp: OnePole,
    sr: f32,
}

impl Delay {
    pub fn new(sr: f32, max_seconds: f32) -> Self {
        let size = (sr * max_seconds).ceil() as usize;
        Self {
            buf: vec![0.0; size],
            size,
            write: 0,
            time: 0.25,
            target_time: 0.25,
            time_coef: glide_coef(0.04, sr),
            feedback: 0.3,
            target_feedback: 0.3,
            fb_coef: glide_coef(0.03, sr),
            damp: OnePole::new(sr, 2400.0),
            sr,
        }
    }

    pub fn set_time(&mut self, seconds: f32) {
        // Leave a sample of headroom at each end so the fractional read never runs
        // off the buffer, which would wrap to the far end and click.
        let max_time = (self.size as f32 / self.sr) - 2.0 / self.sr;
        self.target_time = seconds.clamp(1.0 / self.sr, max_time.max(2.0 / self.sr));
    }

    pub fn set_feedback(&mut self, gain: f32) {
        self.target_feedback = gain.clamp(0.0, 0.95);
    }

    pub fn reset(&mut self) {
        self.buf.iter_mut().for_each(|v| *v = 0.0);
        self.damp.reset();
    }

    #[inline]
    pub fn process(&mut self, input: f32) -> f32 {
        let out = self.read();
        self.write_input(input);
        out
    }

    /// Push a sample in without reading the tap. Used for the per-stem sends, which
    /// write the line; the wet signal is taken once per sample via [`Delay::tap`]
    /// rather than per send, so eight sends share one tail instead of eight.
    #[inline]
    pub fn write_input(&mut self, input: f32) {
        self.time += (self.target_time - self.time) * self.time_coef;
        self.feedback += (self.target_feedback - self.feedback) * self.fb_coef;
        let damped = self.damp.process(self.read()) * self.feedback;
        let idx = self.write;
        self.buf[idx] = input + damped;
        self.write += 1;
        if self.write >= self.size {
            self.write = 0;
        }
    }

    /// Read the current wet tap without advancing the line.
    #[inline]
    pub fn tap(&self) -> f32 {
        self.read()
    }

    /// Fractional read, linearly interpolated.
    fn read(&self) -> f32 {
        let d = (self.time * self.sr).max(1.0);
        let mut pos = self.write as f32 - d;
        while pos < 0.0 {
            pos += self.size as f32;
        }
        let i0 = pos.floor() as usize % self.size;
        let i1 = (i0 + 1) % self.size;
        let frac = pos - pos.floor();
        self.buf[i0] * (1.0 - frac) + self.buf[i1] * frac
    }
}

/// Coefficient for a `setTargetAtTime`-style exponential approach.
fn glide_coef(time_constant: f32, sr: f32) -> f32 {
    1.0 - (-1.0 / (time_constant.max(1e-4) * sr)).exp()
}

/// Normalised `tanh` saturator, matching the waveshaper curve used for glue.
///
/// `amount` is *pre-drive*, not just a normalisation constant: the curve is
/// `tanh(x * amount) / tanh(amount)`, which is unity at zero and asymptotically
/// bounded by `1 / tanh(amount)`. Driving the input up before the curve is what makes
/// this a saturator rather than a limiter — it puts a knee into the low end, so the
/// bass compresses before it distorts. Leaving the input alone (as this function
/// used to) gives `tanh(x) / tanh(amount)`, which is near-linear and barely does
/// anything at all.
pub fn soft_clip(x: f32, amount: f32) -> f32 {
    let a = amount.max(0.01);
    (x * a).tanh() / a.tanh()
}

/// MIDI note number to frequency in Hz (A4 = 440).
pub fn midi_hz(note: f32) -> f32 {
    440.0 * 2f32.powf((note - 69.0) / 12.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn midi_hz_is_a440_at_69() {
        assert!((midi_hz(69.0) - 440.0).abs() < 1e-4);
    }

    #[test]
    fn geometric_interpolation_hits_endpoints() {
        assert!((geom(0.1, 1.0, 0.0) - 0.1).abs() < 1e-6);
        assert!((geom(0.1, 1.0, 1.0) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn adsr_reaches_peak_then_decays_to_silence() {
        let sr = 48_000.0;
        let mut env = Adsr::new(1.0, 0.01, 0.05, 0.5, 0.05, 0.05, sr);
        let mut peak_seen: f32 = 0.0;
        for _ in 0..(sr as usize) {
            peak_seen = peak_seen.max(env.process());
        }
        assert!(peak_seen > 0.9, "peak {peak_seen}");
        assert!(env.is_done());
    }

    #[test]
    fn adsr_release_now_shortens_the_tail() {
        let sr = 48_000.0;
        let mut env = Adsr::new(1.0, 0.01, 0.01, 0.9, 4.0, 0.02, sr);
        for _ in 0..200 {
            env.process();
        }
        env.release_now();
        for _ in 0..(sr as usize) / 4 {
            env.process();
        }
        assert!(env.is_done());
    }

    #[test]
    fn lowpass_attenuates_highs() {
        let sr = 48_000.0;
        let mut f = Biquad::new();
        f.lowpass(sr, 200.0, FRAC_1_SQRT_2);
        let mut hf = Biquad::new();
        hf.lowpass(sr, 8_000.0, FRAC_1_SQRT_2);
        let mut lp_energy: f32 = 0.0;
        let mut hf_energy: f32 = 0.0;
        for i in 0..4000 {
            let t = i as f32 / sr;
            let x = (t * 6_000.0 * core::f32::consts::TAU).sin();
            lp_energy += f.process(x).powi(2);
            hf_energy += hf.process(x).powi(2);
        }
        assert!(lp_energy < hf_energy * 0.2, "lp {lp_energy} hf {hf_energy}");
    }

    #[test]
    fn delay_returns_the_input_after_one_trip() {
        let sr = 48_000.0;
        let mut d = Delay::new(sr, 0.5);
        d.set_time(0.01);
        d.set_feedback(0.0);
        // Delay time glides toward its target, so let it settle before measuring,
        // otherwise the first trip lands at the old 0.25 s default.
        for _ in 0..(sr as usize) {
            d.process(0.0);
        }
        d.process(1.0);
        // The 10 ms trip should be audible right around its target time.
        let mut peak: f32 = 0.0;
        for _ in 0..(0.012 * sr) as usize {
            peak = peak.max(d.process(0.0).abs());
        }
        assert!(peak > 0.8, "peak {peak}");
    }

    #[test]
    fn delay_time_glides_toward_its_target() {
        let sr = 48_000.0;
        let mut d = Delay::new(sr, 0.5);
        assert_eq!(d.time, 0.25, "starts at the default");
        d.set_time(0.01);
        for _ in 0..(sr as usize) {
            d.process(0.0);
        }
        assert!(
            (d.time - 0.01).abs() < 0.001,
            "did not settle, time {}",
            d.time
        );
    }

    #[test]
    fn oscillators_stay_bounded() {
        let mut osc = Osc::new(Wave::Saw, 220.0, 48_000.0);
        for _ in 0..10_000 {
            assert!(osc.next().abs() <= 1.5);
        }
    }

    /// Count positive-going zero crossings over a known window: for a sine that is
    /// exactly one per cycle, so crossings / seconds is the fundamental in Hz.
    fn measured_hz(target: f32, sr: f32) -> f32 {
        let mut osc = Osc::new(Wave::Sine, target, sr);
        let seconds = 4.0;
        let mut prev = 0.0f32;
        let mut crossings = 0usize;
        for i in 0..(sr * seconds) as usize {
            let v = osc.next();
            if i > 0 && prev <= 0.0 && v > 0.0 {
                crossings += 1;
            }
            prev = v;
        }
        crossings as f32 / seconds
    }

    /// An oscillator has to play the pitch it was asked for.
    ///
    /// `inc` is a phase increment for a phase normalised to 0..1, where one cycle is
    /// `1.0` — so it is `freq / sample_rate`, with no radian conversion. Folding a
    /// `1 / TAU` into it (as this once did) detunes the entire engine down by a factor
    /// of 6.28, about two octaves and a eight semitones flat, which no band-energy or
    /// arrangement test can see because every stem moves together.
    #[test]
    fn oscillators_play_the_pitch_they_were_asked_for() {
        for target in [55.0f32, 110.0, 220.0, 440.0, 880.0] {
            let got = measured_hz(target, 48_000.0);
            let cents = 1200.0 * (got / target).log2();
            assert!(
                cents.abs() < 5.0,
                "asked for {target} Hz, got {got:.3} Hz ({cents:+.1} cents)"
            );
        }
    }

    /// Pitch must not depend on the render rate — the same note at 44.1 kHz and
    /// 48 kHz has to come out as the same frequency.
    #[test]
    fn pitch_is_independent_of_sample_rate() {
        for sr in [44_100.0f32, 48_000.0, 96_000.0] {
            let got = measured_hz(440.0, sr);
            assert!(
                (got - 440.0).abs() < 2.0,
                "A4 at {sr} Hz came out at {got:.3} Hz"
            );
        }
    }
}

/// Feed-forward peak compressor with a soft knee, matching the dynamics stage the
/// master bus carries before the saturator.
///
/// This is not optional polish. Without it the sum has no level control at all, so
/// the kick and the bass stack linearly, clip at the saturator, and the low end ends up
/// either muddy or gone, depending on the faders. The compressor is what keeps the
/// bottom end present while the loud parts are held down.
///
/// Follows the Web Audio `DynamicsCompressorNode` model: a dB-domain level detector
/// with separate attack and release one-poles, and a quadratic soft knee across
/// `knee_db` either side of the threshold.
#[derive(Clone, Debug)]
pub struct Compressor {
    threshold_db: f32,
    knee_db: f32,
    ratio: f32,
    attack_coef: f32,
    release_coef: f32,
    env_db: f32,
}

impl Compressor {
    pub fn new(
        sample_rate: f32,
        threshold_db: f32,
        knee_db: f32,
        ratio: f32,
        attack: f32,
        release: f32,
    ) -> Self {
        // One-pole coefficients from time constants: `exp(-1 / (t * sr))`.
        let coef = |t: f32| (-1.0 / (t.max(1e-6) * sample_rate)).exp();
        Self {
            threshold_db,
            knee_db: knee_db.max(0.0),
            ratio: ratio.max(1.0),
            attack_coef: coef(attack),
            release_coef: coef(release),
            env_db: -120.0,
        }
    }

    /// Gain reduction in dB for the current detector level.
    fn reduction_db(&self, level_db: f32) -> f32 {
        let over = level_db - self.threshold_db;
        let slope = 1.0 / self.ratio - 1.0;

        if 2.0 * over < -self.knee_db {
            0.0 // below the knee: untouched
        } else if 2.0 * over.abs() <= self.knee_db {
            slope * (over + self.knee_db / 2.0).powi(2) / (2.0 * self.knee_db)
        } else {
            slope * over
        }
    }

    /// Compress one stereo frame, stereo-linked.
    ///
    /// One detector step per sample, driven by the louder of the two channels, and
    /// the same gain applied to both. Running a mono compressor left-then-right (as
    /// the master did) stepped the envelope twice per sample, so attack and release
    /// ran at half their configured times, and the detector alternated between the
    /// channels, so a loud left pulled the right down on alternate samples only.
    /// Linking also keeps the stereo image still while the compressor works.
    #[inline]
    pub fn process_stereo(&mut self, left: f32, right: f32) -> (f32, f32) {
        let peak = left.abs().max(right.abs()).max(1e-9);
        let level_db = 20.0 * peak.log10();
        let coef = if level_db > self.env_db {
            self.attack_coef
        } else {
            self.release_coef
        };
        // One-pole smoothing: `coef` is `exp(-1 / (t * sr))`, the fraction of the
        // *previous* envelope kept each sample. This was written the other way round,
        // weighting the new level by ~0.99998, so the detector followed the signal
        // sample by sample and the compressor acted as a waveshaper with no attack or
        // release at all.
        self.env_db = level_db + coef * (self.env_db - level_db);

        let gain = (10.0f32).powf(self.reduction_db(self.env_db) / 20.0);
        (left * gain, right * gain)
    }

    /// The detector level in dB, for tests that pin the ballistics.
    #[cfg(test)]
    pub fn envelope_db(&self) -> f32 {
        self.env_db
    }

    pub fn reset(&mut self) {
        self.env_db = -120.0;
    }
}

/// Feedback comb filter: a delay line with a gain-controlled recirculation path.
#[derive(Clone, Debug)]
struct Comb {
    buf: Vec<f32>,
    size: usize,
    idx: usize,
    feedback: f32,
}

impl Comb {
    fn new(sample_rate: f32, ms: f32, feedback: f32, stereo_offset: usize) -> Self {
        let size = ((sample_rate * ms / 1000.0).round() as usize + stereo_offset).max(2);
        Self {
            buf: vec![0.0; size],
            size,
            idx: 0,
            feedback,
        }
    }

    /// Write the input plus a recirculated copy of what leaves the line, and return
    /// what leaves. That recirculation is what turns a single echo into a decay.
    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let out = self.buf[self.idx];
        self.buf[self.idx] = input + out * self.feedback;
        self.idx += 1;
        if self.idx >= self.size {
            self.idx = 0;
        }
        out
    }

    fn reset(&mut self) {
        self.buf.fill(0.0);
    }
}

/// Series allpass, used to flatten the comb bank into a diffuse tail.
#[derive(Clone, Debug)]
struct Allpass {
    buf: Vec<f32>,
    size: usize,
    idx: usize,
}

impl Allpass {
    fn new(sample_rate: f32, ms: f32, stereo_offset: usize) -> Self {
        let size = ((sample_rate * ms / 1000.0).round() as usize + stereo_offset).max(2);
        Self {
            buf: vec![0.0; size],
            size,
            idx: 0,
        }
    }

    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        // Schroeder allpass with g = 0.5: flat magnitude, phase scrambled.
        const G: f32 = 0.5;
        let buffered = self.buf[self.idx];
        let out = buffered - G * input;
        self.buf[self.idx] = input + G * out;
        self.idx += 1;
        if self.idx >= self.size {
            self.idx = 0;
        }
        out
    }

    fn reset(&mut self) {
        self.buf.fill(0.0);
    }
}

/// A short room: four parallel combs into two series allpasses, per channel.
///
/// The original loads a `ConvolverNode` with 0.35 s of exponentially-decaying noise at
/// 7% wet. That IR is spectrally flat with a smooth decay, which is precisely what a
/// comb-and-allpass network synthesises, so this is an equivalent model rather than a
/// sample-accurate copy — a real 16 800-tap convolution would cost roughly 800 M MACs
/// per second, which an audio thread cannot afford. The feedback is tuned to match the
/// original's decay length and the right-hand combs are offset so the room is wide
/// instead of centred.
pub struct Reverb {
    combs_l: Vec<Comb>,
    combs_r: Vec<Comb>,
    allpass_l: Vec<Allpass>,
    allpass_r: Vec<Allpass>,
}

/// RT60 of the original impulse response: `(1 - i/len)^2.8` reaches -60 dB about 91%
/// of the way through 0.35 s, so roughly 0.32 s.
const ROOM_RT60: f32 = 0.32;

impl Reverb {
    /// Comb delays in milliseconds. Prime-ish and mutually non-harmonic, so the
    /// recirculations land at different times and the tail does not ring as one pitch.
    const COMB_MS: [f32; 4] = [29.7, 37.1, 41.1, 43.7];
    const ALLPASS_MS: [f32; 2] = [5.0, 1.7];
    /// Fraction of a sample period by which the right channel is offset, decorrelating
    /// the two sides enough to be heard as width.
    const STEREO_OFFSET: f32 = 0.0117;

    pub fn new(sample_rate: f32) -> Self {
        let offset = (sample_rate * Self::STEREO_OFFSET) as usize;
        let mut combs_l = Vec::new();
        let mut combs_r = Vec::new();
        for ms in Self::COMB_MS {
            // Solve the comb's feedback for the target decay time.
            //
            // A comb recirculates its output every `seconds`, multiplying by `g` each
            // pass, so the time for the amplitude to fall 1000x is `3 * seconds /
            // ln(1/g)`. Inverting that for the target RT gives the expression below.
            // (Sample rate does not appear: `seconds` is already the delay in seconds,
            // and dividing by `sr` here would drive the gain to ~1.0 and the room would
            // never die.)
            let seconds = ms / 1000.0;
            let feedback = (-3.0 * seconds / ROOM_RT60).exp().clamp(0.0, 0.95);
            combs_l.push(Comb::new(sample_rate, ms, feedback, 0));
            combs_r.push(Comb::new(sample_rate, ms, feedback, offset));
        }

        let allpass_l = Self::ALLPASS_MS
            .iter()
            .map(|ms| Allpass::new(sample_rate, *ms, 0))
            .collect();
        let allpass_r = Self::ALLPASS_MS
            .iter()
            .map(|ms| Allpass::new(sample_rate, *ms, offset))
            .collect();

        Self {
            combs_l,
            combs_r,
            allpass_l,
            allpass_r,
        }
    }

    fn voice(combs: &mut [Comb], allpass: &mut [Allpass], input: f32) -> f32 {
        let mut acc = 0.0;
        for comb in combs.iter_mut() {
            acc += comb.process(input);
        }
        let mut out = acc * 0.25;
        for ap in allpass.iter_mut() {
            out = ap.process(out);
        }
        out
    }

    #[inline]
    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let l = Self::voice(&mut self.combs_l, &mut self.allpass_l, left);
        let r = Self::voice(&mut self.combs_r, &mut self.allpass_r, right);
        (l, r)
    }

    pub fn reset(&mut self) {
        for c in self.combs_l.iter_mut().chain(self.combs_r.iter_mut()) {
            c.reset();
        }
        for a in self.allpass_l.iter_mut().chain(self.allpass_r.iter_mut()) {
            a.reset();
        }
    }
}

/// A biquad with independent state for each channel.
///
/// The Web Audio filters this replaces are single nodes fed stereo, and Web Audio gives
/// every channel of a filter its own delay line while sharing coefficients. A lone
/// [`Biquad`] alternated left-then-right instead shares one delay line between the two,
/// so the channels contaminate each other's state — a low shelf at 180 Hz with a
/// ~9 ms memory feeds a ninth of the right channel's history into the left. On a mix
/// where the bass and the kick alternate between channels that is enough to hollow the
/// low end out, which is exactly what it sounds like.
#[derive(Clone, Default)]
pub struct StereoBiquad {
    l: Biquad,
    r: Biquad,
}

impl StereoBiquad {
    pub fn new() -> Self {
        Self::default()
    }

    /// Configure both channels identically. Coefficients are shared; state is not.
    pub fn configure(&mut self, f: impl Fn(&mut Biquad)) {
        f(&mut self.l);
        f(&mut self.r);
    }

    #[inline]
    pub fn lowpass(&mut self, sr: f32, freq: f32, q: f32) {
        self.configure(|b| b.lowpass(sr, freq, q));
    }

    #[inline]
    pub fn highpass(&mut self, sr: f32, freq: f32, q: f32) {
        self.configure(|b| b.highpass(sr, freq, q));
    }

    #[inline]
    pub fn low_shelf(&mut self, sr: f32, freq: f32, gain_db: f32) {
        self.configure(|b| b.low_shelf(sr, freq, gain_db));
    }

    #[inline]
    pub fn high_shelf(&mut self, sr: f32, freq: f32, gain_db: f32) {
        self.configure(|b| b.high_shelf(sr, freq, gain_db));
    }

    #[inline]
    pub fn peaking(&mut self, sr: f32, freq: f32, q: f32, gain_db: f32) {
        self.configure(|b| b.peaking(sr, freq, q, gain_db));
    }

    /// Filter one stereo frame, each channel through its own state.
    #[inline]
    pub fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        (self.l.process(left), self.r.process(right))
    }

    pub fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }
}
