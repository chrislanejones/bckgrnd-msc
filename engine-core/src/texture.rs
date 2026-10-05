//! The lo-fi medium: vinyl crackle and tape hiss under the music.
//!
//! Lo-fi tracks only. It is summed into the master outside the stems, so the tape
//! filter and EQ shape it but no stem cut does: it is the record, not a part on it.
//! It fades in with Play and out with Stop, and plays only while the transport runs.
//!
//! - **Hiss**: white noise band-limited to roughly 1.2..9 kHz, the shape of tape hiss,
//!   around -43 dBFS at the output.
//! - **Crackle**: sparse clicks at a density that wanders slowly between about two and
//!   fourteen a second, each one a single impulse rung through a short bandpass at a
//!   random pitch and placed somewhere across the stereo field. Most are small ticks;
//!   one in twenty or so is a bigger, duller pop. Peaks stay far under the music.
//!
//! No allocation, no per-sample filter design: a click's filter is set up only on the
//! sample the click lands, a few times a second.

use core::f32::consts::FRAC_1_SQRT_2;

use crate::dsp::{noise, Biquad};

/// Hiss level before the master, tuned for about -43 dBFS RMS at the output (the
/// saturator's small-signal gain and the master trim sit between here and there).
const HISS_LEVEL: f32 = 0.0195;
/// A tick's impulse size before its filter; a pop is several times this.
const TICK_LEVEL: f32 = 0.3;
const POP_LEVEL: f32 = 0.55;
/// Fade in on Play, out on Stop.
const FADE_SECONDS: f32 = 0.25;
/// Clicks per second, the bounds of the slow wander.
const DENSITY_MIN: f32 = 2.0;
const DENSITY_MAX: f32 = 14.0;

/// Uniform 0..1 from the shared noise source.
#[inline]
fn unit() -> f32 {
    noise() * 0.5 + 0.5
}

pub struct Texture {
    sample_rate: f32,
    enabled: bool,
    /// Current level 0..1, gliding toward `target`.
    gain: f32,
    target: f32,
    fade_step: f32,
    hiss_hp: [Biquad; 2],
    hiss_lp: [Biquad; 2],
    /// One ringing filter per channel for the clicks, retuned per click.
    click: [Biquad; 2],
    /// Clicks per second right now, and where it is wandering to.
    density: f32,
    density_target: f32,
    /// Samples until the wander picks a new target.
    wander_in: f32,
    /// Off only in tests that measure the hiss alone.
    pub(crate) crackle: bool,
    /// Samples the click filters have left to ring. Once a click has died away
    /// the filters are cleared and skipped: left running on silence their state
    /// decays into subnormal floats, which are many times slower to compute.
    ringing: u32,
}

impl Texture {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate;
        let mut hiss_hp = [Biquad::new(); 2];
        let mut hiss_lp = [Biquad::new(); 2];
        for ch in 0..2 {
            hiss_hp[ch].highpass(sr, 1_200.0, FRAC_1_SQRT_2);
            hiss_lp[ch].lowpass(sr, 9_000.0, FRAC_1_SQRT_2);
        }
        Self {
            sample_rate: sr,
            enabled: false,
            gain: 0.0,
            target: 0.0,
            fade_step: 1.0 / (FADE_SECONDS * sr).max(1.0),
            hiss_hp,
            hiss_lp,
            click: [Biquad::new(); 2],
            density: 6.0,
            density_target: 6.0,
            wander_in: 0.0,
            crackle: true,
            ringing: 0,
        }
    }

    /// On for lo-fi tracks, off (immediately silent) for everything else.
    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        if !on {
            self.gain = 0.0;
            self.target = 0.0;
            for f in self.hiss_hp.iter_mut().chain(self.hiss_lp.iter_mut()) {
                f.reset();
            }
            for f in self.click.iter_mut() {
                f.reset();
            }
        }
    }

    /// Fade in (the transport started) or out (it stopped).
    pub fn set_running(&mut self, running: bool) {
        self.target = if running && self.enabled { 1.0 } else { 0.0 };
    }

    pub fn audible(&self) -> bool {
        self.enabled && (self.gain > 0.0 || self.target > 0.0)
    }

    #[inline]
    pub fn process(&mut self) -> (f32, f32) {
        if !self.audible() {
            return (0.0, 0.0);
        }
        if self.gain < self.target {
            self.gain = (self.gain + self.fade_step).min(self.target);
        } else if self.gain > self.target {
            self.gain = (self.gain - self.fade_step).max(self.target);
        }

        // Hiss.
        let hl = self.hiss_lp[0].process(self.hiss_hp[0].process(noise()));
        let hr = self.hiss_lp[1].process(self.hiss_hp[1].process(noise()));

        // The crackle's density wanders: every second or two, a new target, glided to.
        self.wander_in -= 1.0;
        if self.wander_in <= 0.0 {
            self.wander_in = (0.8 + 1.6 * unit()) * self.sample_rate;
            self.density_target = DENSITY_MIN + (DENSITY_MAX - DENSITY_MIN) * unit() * unit();
        }
        self.density += (self.density_target - self.density) * (2.0 / self.sample_rate);

        // A click lands with probability density / sample rate on any sample.
        let (mut il, mut ir) = (0.0, 0.0);
        if self.crackle && unit() < self.density / self.sample_rate {
            let pop = unit() < 0.05;
            let (amp, hz, q) = if pop {
                (
                    POP_LEVEL * (0.5 + 0.5 * unit()),
                    600.0 + 900.0 * unit(),
                    0.9,
                )
            } else {
                // Squared, so most ticks are small and a few stand out.
                let u = unit();
                (
                    TICK_LEVEL * (0.15 + 0.85 * u * u),
                    1_800.0 + 3_500.0 * unit(),
                    1.4,
                )
            };
            for f in self.click.iter_mut() {
                f.bandpass(self.sample_rate, hz, q);
            }
            // A Q under 1.5 rings down 120 dB well inside 50 ms at these pitches.
            self.ringing = (0.05 * self.sample_rate) as u32;
            let pan = unit();
            let sign = if noise() < 0.0 { -1.0 } else { 1.0 };
            il = amp * sign * (1.0 - pan).sqrt();
            ir = amp * sign * pan.sqrt();
        }
        let (cl, cr) = if self.ringing > 0 {
            self.ringing -= 1;
            if self.ringing == 0 {
                self.click[0].reset();
                self.click[1].reset();
            }
            (self.click[0].process(il), self.click[1].process(ir))
        } else {
            (0.0, 0.0)
        };

        let g = self.gain;
        ((hl * HISS_LEVEL + cl) * g, (hr * HISS_LEVEL + cr) * g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    #[test]
    fn silent_until_enabled_and_running() {
        let mut t = Texture::new(SR);
        t.set_running(true);
        for _ in 0..4_800 {
            assert_eq!(t.process(), (0.0, 0.0), "sounded while disabled");
        }
        t.set_enabled(true);
        for _ in 0..4_800 {
            assert_eq!(t.process(), (0.0, 0.0), "sounded before Play");
        }
        t.set_running(true);
        let energy: f32 = (0..48_000).map(|_| t.process().0.abs()).sum();
        assert!(energy > 0.0);
    }

    #[test]
    fn it_fades_out_with_stop() {
        let mut t = Texture::new(SR);
        t.set_enabled(true);
        t.set_running(true);
        for _ in 0..48_000 {
            t.process();
        }
        t.set_running(false);
        for _ in 0..((FADE_SECONDS * SR) as usize + 10) {
            let (l, r) = t.process();
            assert!(l.is_finite() && r.is_finite());
        }
        assert!(!t.audible());
        assert_eq!(t.process(), (0.0, 0.0));
    }

    #[test]
    fn crackle_and_hiss_stay_bounded_and_finite() {
        let mut t = Texture::new(SR);
        t.set_enabled(true);
        t.set_running(true);
        let mut peak = 0.0f32;
        for _ in 0..(SR as usize * 30) {
            let (l, r) = t.process();
            assert!(l.is_finite() && r.is_finite());
            peak = peak.max(l.abs()).max(r.abs());
        }
        assert!(peak < 0.15, "crackle peak {peak}");
    }
}
