//! Transition effects: the sounds that mark the song's parts.
//!
//! The song is 256 steps in four four-bar parts, Intro (0..64), Groove (64..128),
//! Break (128..192) and Drop (192..256). Three engine-made sounds mark the two seams
//! that matter:
//!
//! - a **riser** of filtered noise over the bar or two before the Drop, sweeping up and
//!   swelling, ending exactly on step 192;
//! - a **crash** on the Drop's downbeat, the 808 metal bank over noise with a low thump;
//! - a **downsweep** into the Break, falling filtered noise across its first bar.
//!
//! They are played outside the stems, the way the backspin is: summed straight into the
//! master, so the tape filter, EQ, echo throw and limiter all act on them, but no stem
//! fader, cut or solo does. They are the song's form, not a part.
//!
//! ## When they fire
//!
//! Only on a **contiguous crossing**: the step before the boundary fired, and then the
//! boundary fired, in ordinary playback. Concretely:
//!
//! - A loop that contains the seam crosses it every pass, so an eight-bar loop over
//!   Break and Drop rises and crashes every time round. A loop that only *wraps back*
//!   to a boundary does not: a one-bar loop on the Drop's first bar never re-crashes,
//!   and a loop on the Break never rises, since it never reaches the Drop to pay the
//!   riser off. If a loop is engaged mid-riser so that the Drop will not come, the
//!   riser fades away instead of building to nothing.
//! - A jump (cue, scratch release, a loop snapping the playhead) is not a crossing.
//!   Jumping to 191 plays no riser at all, then crashes on 192, since 191 -> 192 is an
//!   ordinary crossing. A riser in flight is faded out by any jump.
//! - Nothing is fired while the transport is stopped, held under a scratch, braking or
//!   spinning back. The brake and backspin fade out whatever is sounding: a riser tied
//!   to a clock that is racing or grinding to a halt sounds broken, not tense.
//!
//! The riser and downsweep are positioned by the transport, not by a timer: their
//! progress is the playhead's position inside their window, so a tempo change mid-way
//! retimes them, and the riser lands on the Drop at any bpm or swing. The crash decays
//! over about a bar at the tempo it fired at.
//!
//! No allocation: every voice is a fixed field, rendered in place.

use core::f32::consts::FRAC_1_SQRT_2;

use crate::dsp::{exp_between, noise, Biquad, Osc, Wave};
use crate::track::{TrackKind, STEPS};
use crate::transport::Transport;

/// The first step of the Break.
pub const BREAK_STEP: usize = 128;
/// The first step of the Drop.
pub const DROP_STEP: usize = 192;
/// How long the downsweep lasts, in steps: one bar.
const SWEEP_STEPS: usize = 16;
/// Filter coefficients are recomputed every this many samples, not every sample.
const CONTROL_EVERY: u32 = 16;
/// Fade for a sound being got out of the way: a jump, a brake, a stop.
const RELEASE_SECONDS: f32 = 0.06;
/// Fade at the end of the riser, on the Drop's downbeat, only to avoid a click.
const RISER_END_SECONDS: f32 = 0.003;

/// How the transitions sound for one flavor of track.
#[derive(Clone, Copy)]
struct Character {
    riser_bars: usize,
    riser_level: f32,
    riser_low_hz: f32,
    riser_top_hz: f32,
    riser_q: f32,
    crash_level: f32,
    crash_bp_hz: f32,
    crash_hp_hz: f32,
    sub_level: f32,
    sweep_level: f32,
    sweep_top_hz: f32,
    sweep_low_hz: f32,
}

/// Full on the club flavors; subtle and dark on lo-fi, where a white-noise riser
/// would be out of place, so it keeps to one bar, low and under 2.4 kHz.
fn character(kind: TrackKind) -> Character {
    match kind {
        TrackKind::House => Character {
            riser_bars: 2,
            riser_level: 0.093,
            riser_low_hz: 300.0,
            riser_top_hz: 9_000.0,
            riser_q: 1.6,
            crash_level: 0.031,
            crash_bp_hz: 7_500.0,
            crash_hp_hz: 3_800.0,
            sub_level: 0.043,
            sweep_level: 0.081,
            sweep_top_hz: 7_000.0,
            sweep_low_hz: 250.0,
        },
        TrackKind::Deep => Character {
            riser_bars: 2,
            riser_level: 0.068,
            riser_low_hz: 250.0,
            riser_top_hz: 6_000.0,
            riser_q: 1.3,
            crash_level: 0.025,
            crash_bp_hz: 6_000.0,
            crash_hp_hz: 3_000.0,
            sub_level: 0.043,
            sweep_level: 0.062,
            sweep_top_hz: 5_000.0,
            sweep_low_hz: 200.0,
        },
        TrackKind::Acid => Character {
            riser_bars: 2,
            riser_level: 0.093,
            riser_low_hz: 350.0,
            riser_top_hz: 11_000.0,
            riser_q: 2.2,
            crash_level: 0.031,
            crash_bp_hz: 8_000.0,
            crash_hp_hz: 4_200.0,
            sub_level: 0.037,
            sweep_level: 0.081,
            sweep_top_hz: 8_000.0,
            sweep_low_hz: 300.0,
        },
        TrackKind::Lofi => Character {
            riser_bars: 1,
            riser_level: 0.031,
            riser_low_hz: 250.0,
            riser_top_hz: 2_400.0,
            riser_q: 1.0,
            crash_level: 0.011,
            crash_bp_hz: 3_200.0,
            crash_hp_hz: 1_400.0,
            sub_level: 0.022,
            sweep_level: 0.028,
            sweep_top_hz: 2_600.0,
            sweep_low_hz: 200.0,
        },
    }
}

/// Where the playhead is, in steps, with the fraction of the sounding step elapsed.
/// `None` straight after a jump, before the new position has fired.
fn playhead(t: &Transport) -> Option<f32> {
    if t.visual_step < 0 {
        return None;
    }
    let frac = if t.step_len > 0.0 {
        (1.0 - t.to_next / t.step_len).clamp(0.0, 1.0)
    } else {
        0.0
    };
    Some(t.visual_step as f32 + frac as f32)
}

/// Noise through a swept bandpass and highpass, in stereo from two noise draws, its
/// position read off the playhead. The riser sweeps up and swells; the downsweep
/// falls and fades.
struct NoiseSweep {
    active: bool,
    rising: bool,
    start: usize,
    steps: usize,
    level: f32,
    low_hz: f32,
    top_hz: f32,
    q: f32,
    bp: [Biquad; 2],
    hp: [Biquad; 2],
    control: u32,
    /// Progress through the window, 0..1, held where it was while the playhead is
    /// between a jump and its first step, so the fade-out does not lurch.
    p: f32,
    /// Samples since the start, for the downsweep's 10 ms attack.
    age: f32,
    attack: f32,
    /// Fade-out multiplier, 1 while playing, ramping to 0 once released.
    fade: f32,
    fade_step: f32,
}

impl NoiseSweep {
    fn new() -> Self {
        Self {
            active: false,
            rising: true,
            start: 0,
            steps: 1,
            level: 0.0,
            low_hz: 200.0,
            top_hz: 2_000.0,
            q: 1.0,
            bp: [Biquad::new(); 2],
            hp: [Biquad::new(); 2],
            control: 0,
            p: 0.0,
            age: 0.0,
            attack: 1.0,
            fade: 1.0,
            fade_step: 0.0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn start(
        &mut self,
        rising: bool,
        start: usize,
        steps: usize,
        level: f32,
        low_hz: f32,
        top_hz: f32,
        q: f32,
        sr: f32,
    ) {
        if level <= 0.0 {
            return;
        }
        *self = Self {
            active: true,
            rising,
            start,
            steps: steps.max(1),
            level,
            low_hz,
            top_hz,
            q,
            attack: (0.01 * sr).max(1.0),
            ..Self::new()
        };
    }

    /// Fade out over `seconds`, unless already fading faster.
    fn release(&mut self, seconds: f32, sr: f32) {
        if !self.active {
            return;
        }
        let step = 1.0 / (seconds * sr).max(1.0);
        if self.fade_step == 0.0 || step > self.fade_step {
            self.fade_step = step;
        }
    }

    fn releasing(&self) -> bool {
        self.fade_step > 0.0
    }

    #[inline]
    fn process(&mut self, at: Option<f32>, sr: f32) -> (f32, f32) {
        if !self.active {
            return (0.0, 0.0);
        }
        if let Some(at) = at {
            self.p = ((at - self.start as f32) / self.steps as f32).clamp(0.0, 1.0);
        }
        let p = self.p;
        if self.control == 0 {
            let (bp_hz, hp_hz) = if self.rising {
                let f = exp_between(self.low_hz, self.top_hz, p.powf(1.4));
                (f, f * 0.35)
            } else {
                let f = exp_between(self.top_hz, self.low_hz, p.sqrt());
                (f, (f * 0.3).max(40.0))
            };
            for ch in 0..2 {
                self.bp[ch].bandpass(sr, bp_hz, self.q);
                self.hp[ch].highpass(sr, hp_hz, FRAC_1_SQRT_2);
            }
            self.control = CONTROL_EVERY;
        }
        self.control -= 1;

        // The riser swells from nothing; the downsweep hits and falls away to nothing
        // by the end of its bar.
        let shape = if self.rising {
            p * p
        } else {
            self.age += 1.0;
            let q = 1.0 - p;
            (self.age / self.attack).min(1.0) * q * q
        };
        if self.fade_step > 0.0 {
            self.fade -= self.fade_step;
            if self.fade <= 0.0 {
                self.active = false;
                return (0.0, 0.0);
            }
        }
        if !self.rising && p >= 1.0 {
            self.active = false;
            return (0.0, 0.0);
        }
        let g = self.level * shape * self.fade;
        let l = self.hp[0].process(self.bp[0].process(noise()));
        let r = self.hp[1].process(self.bp[1].process(noise()));
        (l * g, r * g)
    }
}

/// The 808 metal bank's frequencies, as the hats use.
const METAL_HZ: [f32; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

/// Crash and impact: the metal bank and noise, band- and high-passed, with a fast
/// bright transient and a decay of about a bar, over a sine thump falling 80 -> 44 Hz.
struct Crash {
    active: bool,
    metal: [Osc; 6],
    bp: Biquad,
    hp: Biquad,
    noise_hp: [Biquad; 2],
    env: f32,
    decay: f32,
    /// The first 40 ms are brighter and louder, the stick hitting the cymbal.
    hit: f32,
    hit_decay: f32,
    level: f32,
    attack_left: f32,
    attack_len: f32,
    sub: Osc,
    sub_env: f32,
    sub_decay: f32,
    sub_level: f32,
    sub_t: f32,
    control: u32,
}

/// Envelope floor below which the crash is considered over.
const CRASH_FLOOR: f32 = 1e-4;

/// Per-sample multiplier for a decay of 60 dB over `seconds`.
fn t60(seconds: f32, sr: f32) -> f32 {
    10f32.powf(-3.0 / (seconds * sr).max(1.0))
}

impl Crash {
    fn new(sr: f32) -> Self {
        Self {
            active: false,
            metal: core::array::from_fn(|i| Osc::new(Wave::Square, METAL_HZ[i], sr)),
            bp: Biquad::new(),
            hp: Biquad::new(),
            noise_hp: [Biquad::new(); 2],
            env: 0.0,
            decay: 0.0,
            hit: 0.0,
            hit_decay: 0.0,
            level: 0.0,
            attack_left: 0.0,
            attack_len: 1.0,
            sub: Osc::new(Wave::Sine, 80.0, sr),
            sub_env: 0.0,
            sub_decay: 0.0,
            sub_level: 0.0,
            sub_t: 0.0,
            control: 0,
        }
    }

    fn fire(&mut self, ch: &Character, bpm: f32, sr: f32) {
        if ch.crash_level <= 0.0 && ch.sub_level <= 0.0 {
            return;
        }
        // About a bar to fade by 60 dB, kept between 1.2 s and 2.6 s so a slow tempo
        // does not wash over the whole Drop and a fast one still reads as a crash.
        let bar = 240.0 / bpm.max(40.0);
        // Free-running on the hardware, so each crash catches the bank somewhere new.
        let metal = core::array::from_fn(|i| {
            let mut osc = Osc::new(Wave::Square, METAL_HZ[i], sr);
            osc.advance_phase(noise() * 0.5 + 0.5);
            osc
        });
        let mut bp = Biquad::new();
        bp.bandpass(sr, ch.crash_bp_hz, 0.6);
        let mut hp = Biquad::new();
        hp.highpass(sr, ch.crash_hp_hz, FRAC_1_SQRT_2);
        let mut noise_hp = [Biquad::new(); 2];
        for f in noise_hp.iter_mut() {
            f.highpass(sr, ch.crash_hp_hz * 1.2, FRAC_1_SQRT_2);
        }
        let attack_len = (0.002 * sr).max(1.0);
        *self = Self {
            active: true,
            metal,
            bp,
            hp,
            noise_hp,
            env: 1.0,
            decay: t60(bar.clamp(1.2, 2.6), sr),
            hit: 1.0,
            hit_decay: t60(0.12, sr),
            level: ch.crash_level,
            attack_left: attack_len,
            attack_len,
            sub: Osc::new(Wave::Sine, 80.0, sr),
            sub_env: if ch.sub_level > 0.0 { 1.0 } else { 0.0 },
            sub_decay: t60(0.45, sr),
            sub_level: ch.sub_level,
            sub_t: 0.0,
            control: 0,
        };
    }

    fn release(&mut self, seconds: f32, sr: f32) {
        if self.active {
            let fast = t60(seconds, sr);
            self.decay = self.decay.min(fast);
            self.hit_decay = self.hit_decay.min(fast);
            self.sub_decay = self.sub_decay.min(fast);
        }
    }

    #[inline]
    fn process(&mut self, sr: f32) -> (f32, f32) {
        if !self.active {
            return (0.0, 0.0);
        }
        if self.control == 0 {
            // The thump's pitch falls 80 -> 44 Hz over 0.2 s.
            let f = exp_between(80.0, 44.0, (self.sub_t / (0.2 * sr)).min(1.0));
            self.sub.set_frequency(f, sr);
            self.control = CONTROL_EVERY;
        }
        self.control -= 1;
        self.sub_t += 1.0;

        let attack = if self.attack_left > 0.0 {
            self.attack_left -= 1.0;
            1.0 - self.attack_left / self.attack_len
        } else {
            1.0
        };

        let mut metal = 0.0;
        for osc in &mut self.metal {
            metal += osc.next();
        }
        // Six unit squares, normalized to roughly the RMS of the uniform noise.
        let metal = self.hp.process(self.bp.process(metal * 0.235)) * 2.4;
        let nl = self.noise_hp[0].process(noise());
        let nr = self.noise_hp[1].process(noise());
        let body = self.env * (1.0 + 1.5 * self.hit) * self.level * attack;
        let thump = self.sub.next() * self.sub_env * self.sub_level * attack;

        self.env *= self.decay;
        self.hit *= self.hit_decay;
        self.sub_env *= self.sub_decay;
        if self.env < CRASH_FLOOR && self.sub_env < CRASH_FLOOR {
            self.active = false;
        }
        (
            (metal + nl * 0.6) * body + thump,
            (metal + nr * 0.6) * body + thump,
        )
    }
}

/// The three transition voices and the bookkeeping that decides when they fire.
pub struct Transitions {
    sample_rate: f32,
    ch: Character,
    riser: NoiseSweep,
    sweep: NoiseSweep,
    crash: Crash,
    /// The step that fired last in ordinary playback, or `None` after anything that
    /// was not (a jump into place is caught by the step not following it).
    last: Option<usize>,
}

impl Transitions {
    pub fn new(kind: TrackKind, sample_rate: f32) -> Self {
        Self {
            sample_rate,
            ch: character(kind),
            riser: NoiseSweep::new(),
            sweep: NoiseSweep::new(),
            crash: Crash::new(sample_rate),
            last: None,
        }
    }

    /// Change flavor for a newly loaded track, silencing anything in flight.
    pub fn set_kind(&mut self, kind: TrackKind) {
        self.ch = character(kind);
        self.reset();
    }

    /// Hard silence, for when the music has already faded out around it.
    pub fn reset(&mut self) {
        self.riser.active = false;
        self.sweep.active = false;
        self.crash.active = false;
        self.last = None;
    }

    /// Fade out whatever is sounding, quickly: stop, brake, backspin.
    pub fn release(&mut self) {
        let sr = self.sample_rate;
        self.riser.release(RELEASE_SECONDS, sr);
        self.sweep.release(RELEASE_SECONDS, sr);
        self.crash.release(RELEASE_SECONDS * 2.0, sr);
        self.last = None;
    }

    /// A step went by unheard (under a backspin or a brake), so the next one heard is
    /// not a crossing.
    pub fn forget(&mut self) {
        self.last = None;
    }

    /// Whether ordinary playback from 191 will land on the Drop.
    fn will_reach_drop(t: &Transport) -> bool {
        t.loop_steps == 0 || (t.loop_start < DROP_STEP && t.loop_start + t.loop_steps > DROP_STEP)
    }

    /// A step has just fired in ordinary playback.
    pub fn on_step(&mut self, step: usize, t: &Transport) {
        let sr = self.sample_rate;
        let crossing = self.last.is_some_and(|p| (p + 1) % STEPS == step);
        self.last = Some(step);

        // The clock-driven sounds follow the playhead, or get out of the way.
        if self.riser.active && !self.riser.releasing() {
            if crossing && step == DROP_STEP {
                self.riser.release(RISER_END_SECONDS, sr);
            } else if !crossing || !Self::will_reach_drop(t) {
                self.riser.release(RELEASE_SECONDS, sr);
            }
        }
        if self.sweep.active && !crossing {
            self.sweep.release(RELEASE_SECONDS, sr);
        }
        if !crossing {
            return;
        }

        let ch = self.ch;
        let riser_steps = ch.riser_bars * 16;
        if step == DROP_STEP - riser_steps && Self::will_reach_drop(t) {
            self.riser.start(
                true,
                step,
                riser_steps,
                ch.riser_level,
                ch.riser_low_hz,
                ch.riser_top_hz,
                ch.riser_q,
                sr,
            );
        } else if step == DROP_STEP {
            self.crash.fire(&ch, t.bpm * t.rate, sr);
        } else if step == BREAK_STEP {
            self.sweep.start(
                false,
                step,
                SWEEP_STEPS,
                ch.sweep_level,
                ch.sweep_low_hz,
                ch.sweep_top_hz,
                1.1,
                sr,
            );
        }
    }

    pub fn active(&self) -> bool {
        self.riser.active || self.sweep.active || self.crash.active
    }

    /// One stereo sample of every transition sound, for the master sum.
    #[inline]
    pub fn process(&mut self, t: &Transport) -> (f32, f32) {
        if !self.active() {
            return (0.0, 0.0);
        }
        let sr = self.sample_rate;
        let at = playhead(t);
        let (rl, rr) = self.riser.process(at, sr);
        let (sl, sr_) = self.sweep.process(at, sr);
        let (cl, cr) = self.crash.process(sr);
        (rl + sl + cl, rr + sr_ + cr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    /// Drive a transport and the transitions together, as the engine does, and
    /// collect per-sample output with the step that was sounding.
    struct Rig {
        t: Transport,
        fx: Transitions,
    }

    impl Rig {
        fn new(kind: TrackKind, bpm: f32) -> Self {
            let mut t = Transport::new(bpm, 0.0, SR);
            t.start();
            Self {
                t,
                fx: Transitions::new(kind, SR),
            }
        }

        /// One sample. Returns the step that fired on it, if any, and the output.
        fn tick(&mut self) -> (Option<usize>, f32, f32) {
            let fired = self.t.tick();
            if let Some(s) = fired {
                self.fx.on_step(s, &self.t);
            }
            let (l, r) = self.fx.process(&self.t);
            assert!(
                l.is_finite() && r.is_finite(),
                "non-finite transition output"
            );
            (fired, l, r)
        }

        /// Run until `step` has fired, returning the summed |output| on the way.
        fn run_to(&mut self, step: usize) -> f32 {
            let mut total = 0.0;
            for _ in 0..(SR as usize * 60) {
                let (fired, l, r) = self.tick();
                total += l.abs() + r.abs();
                if fired == Some(step) {
                    return total;
                }
            }
            panic!("never reached step {step}");
        }

        fn run(&mut self, samples: usize) -> f32 {
            (0..samples)
                .map(|_| {
                    let (_, l, r) = self.tick();
                    l.abs() + r.abs()
                })
                .sum()
        }
    }

    #[test]
    fn the_riser_ends_on_the_drop_and_is_silent_outside_its_window() {
        for kind in [TrackKind::House, TrackKind::Lofi] {
            let mut rig = Rig::new(kind, 174.0);
            let start = DROP_STEP - character(kind).riser_bars * 16;
            rig.t.jump(start - 20);
            rig.run_to(start - 20);
            // Silent before the window.
            let before = rig.run_to(start - 1);
            assert_eq!(before, 0.0, "{kind:?}: sound before the riser window");
            rig.run_to(start);
            assert!(rig.fx.riser.active, "{kind:?}: no riser at {start}");
            // It swells: the last bar is louder than the first.
            let first_bar = rig.run_to(start + 4);
            rig.run_to(DROP_STEP - 5);
            let last_bar = rig.run_to(DROP_STEP - 1);
            assert!(last_bar > first_bar * 4.0, "{kind:?}: not rising");
            // Still sounding on the last sample before the Drop.
            let mut tail = 0.0;
            let mut fired_drop = false;
            while !fired_drop {
                let (fired, l, _) = rig.tick();
                fired_drop = fired == Some(DROP_STEP);
                if !fired_drop {
                    tail = l;
                }
            }
            assert!(tail != 0.0, "{kind:?}: the riser stopped short of the Drop");
            // Gone 4 ms after the Drop's downbeat.
            rig.run((0.004 * SR) as usize);
            assert!(!rig.fx.riser.active, "{kind:?}: riser outlived the Drop");
        }
    }

    #[test]
    fn the_crash_fires_once_on_the_drop_per_pass() {
        let mut rig = Rig::new(TrackKind::House, 200.0);
        rig.t.jump(180);
        let mut crashes = 0;
        let mut fresh = 0;
        let mut was_fresh = false;
        // Two passes of the song.
        for _ in 0..(SR as usize * 30) {
            let (fired, _, _) = rig.tick();
            // A crash that has just fired is at full level, a sample into its decay.
            let is_fresh = rig.fx.crash.active && rig.fx.crash.env > 0.999;
            if is_fresh && !was_fresh {
                fresh += 1;
            }
            was_fresh = is_fresh;
            if fired == Some(DROP_STEP) {
                assert!(is_fresh, "the crash did not fire on the Drop");
                crashes += 1;
            }
        }
        assert_eq!(fresh, crashes, "a crash fired off the Drop");
        // 180 -> 192 is the first, 0.9 s in, and a full lap of 256 steps at 200 bpm
        // is 19.2 s, so 30 s holds the second and not a third.
        assert_eq!(crashes, 2, "crash count");
    }

    #[test]
    fn the_downsweep_starts_on_the_break_and_lasts_a_bar() {
        let mut rig = Rig::new(TrackKind::Acid, 160.0);
        rig.t.jump(120);
        let quiet = rig.run_to(BREAK_STEP - 1);
        assert_eq!(quiet, 0.0);
        rig.run_to(BREAK_STEP);
        assert!(rig.fx.sweep.active, "no downsweep at the Break");
        let early = rig.run_to(BREAK_STEP + 2);
        assert!(early > 0.0);
        rig.run_to(BREAK_STEP + SWEEP_STEPS + 1);
        assert!(!rig.fx.sweep.active, "downsweep outlasted its bar");
    }

    #[test]
    fn a_jump_to_191_plays_no_riser_but_still_crashes() {
        let mut rig = Rig::new(TrackKind::House, 126.0);
        rig.run(1000);
        rig.t.jump(191);
        let before = rig.run_to(191);
        assert_eq!(before, 0.0);
        assert!(!rig.fx.riser.active, "a jump started a riser");
        rig.run_to(DROP_STEP);
        assert!(rig.fx.crash.active, "191 -> 192 is a crossing");
    }

    #[test]
    fn a_jump_mid_riser_fades_it_out() {
        let mut rig = Rig::new(TrackKind::House, 174.0);
        rig.t.jump(158);
        rig.run_to(170);
        assert!(rig.fx.riser.active);
        rig.t.jump(20);
        rig.run_to(20);
        rig.run((RELEASE_SECONDS * SR) as usize + 10);
        assert!(!rig.fx.riser.active, "riser survived a jump");
    }

    #[test]
    fn loops_fire_only_when_they_cross_the_seam() {
        // A four-bar loop on the Break: it never reaches the Drop, so no riser, no crash.
        let mut rig = Rig::new(TrackKind::House, 200.0);
        rig.t.jump(130);
        rig.run_to(130);
        rig.t.set_loop(4);
        assert_eq!(rig.t.loop_start, BREAK_STEP);
        for _ in 0..(SR as usize * 12) {
            rig.tick();
            assert!(!rig.fx.riser.active || rig.fx.riser.releasing());
            assert!(!rig.fx.crash.active, "a Break loop crashed");
        }

        // A one-bar loop on the Drop's first bar wraps back to 192, which is not a
        // crossing, so it crashes once on the way in and never again.
        let mut rig = Rig::new(TrackKind::House, 200.0);
        rig.t.jump(186);
        rig.run_to(193);
        rig.t.set_loop(1);
        assert_eq!(rig.t.loop_start, DROP_STEP);
        rig.run(SR as usize * 3);
        let mut refired = false;
        for _ in 0..(SR as usize * 6) {
            let (fired, _, _) = rig.tick();
            if fired == Some(DROP_STEP) && rig.fx.crash.active {
                refired = true;
            }
        }
        assert!(!refired, "a one-bar loop on the Drop re-crashed");

        // An eight-bar loop over Break and Drop crosses 191 -> 192 every pass.
        let mut rig = Rig::new(TrackKind::House, 200.0);
        rig.t.jump(140);
        rig.run_to(141);
        rig.t.set_loop(8);
        assert_eq!(rig.t.loop_start, BREAK_STEP);
        rig.run_to(DROP_STEP);
        assert!(rig.fx.crash.active);
        rig.run_to(BREAK_STEP);
        // 255 -> 128 is a wrap, not a crossing: no downsweep.
        assert!(!rig.fx.sweep.active, "a loop wrap fired the downsweep");
        rig.run_to(DROP_STEP - 32);
        assert!(rig.fx.riser.active, "second pass has no riser");
    }

    #[test]
    fn a_loop_engaged_mid_riser_fades_it() {
        let mut rig = Rig::new(TrackKind::House, 174.0);
        rig.t.jump(158);
        rig.run_to(178);
        assert!(rig.fx.riser.active);
        // One bar at 176..192: wraps from 191 to 176, never reaching the Drop.
        rig.t.set_loop(1);
        rig.run_to(179);
        rig.run((RELEASE_SECONDS * SR) as usize + 10);
        assert!(!rig.fx.riser.active, "riser kept building into a loop");
    }

    #[test]
    fn nothing_fires_while_stopped_or_held() {
        let mut rig = Rig::new(TrackKind::House, 200.0);
        rig.t.jump(186);
        rig.run_to(188);
        rig.t.hold();
        // Held across where the Drop would be: no steps fire, so no crash.
        rig.run(SR as usize * 3);
        assert!(!rig.fx.crash.active);
        rig.t.unhold();
        rig.t.stop();
        rig.fx.release();
        rig.run(SR as usize);
        assert!(!rig.fx.active());
        assert_eq!(rig.run(SR as usize), 0.0, "sound while stopped");
    }

    #[test]
    fn the_riser_follows_a_tempo_change_to_the_drop() {
        let mut rig = Rig::new(TrackKind::Deep, 100.0);
        rig.t.jump(DROP_STEP - 34);
        rig.run_to(DROP_STEP - 20);
        assert!(rig.fx.riser.active);
        // Nearly double the tempo mid-riser: it still builds to the Drop, not past it
        // and not short of it.
        rig.t.bpm = 190.0;
        let mut last = 0.0;
        loop {
            let (fired, l, _) = rig.tick();
            if fired == Some(DROP_STEP) {
                break;
            }
            last = l;
        }
        assert!(last != 0.0, "riser ended early after a tempo change");
        rig.run((0.004 * SR) as usize);
        assert!(!rig.fx.riser.active);
    }
}
