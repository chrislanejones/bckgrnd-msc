//! Drum voices: kick, clap, hats.
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
    pub fn new(vel: f32, sample_rate: f32, lofi: bool) -> Self {
        // Body: 168 Hz snapping down to 49 Hz in 55 ms, then easing to 36 Hz.
        let start = if lofi { 108.0 } else { 168.0 };
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
            pitch: PitchEnv::new(start, 49.0, 36.0, 0.055, 0.22, sample_rate),
            sub_env: Adsr::new(
                if lofi { 0.32 } else { 0.55 } * vel,
                0.012,
                0.3,
                0.0,
                0.0,
                0.02,
                sample_rate,
            ),
            sub: Osc::new(Wave::Sine, 54.0, sample_rate),
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

/// Closed or open hat: filtered noise with a very short decay.
pub struct HatVoice {
    env: Adsr,
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
        let mut hp = Biquad::new();
        hp.highpass(sample_rate, hp_freq, FRAC_1_SQRT_2);
        Self {
            env: Adsr::new(amp, 0.001, decay, 0.0, 0.0, 0.01, sample_rate),
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
        let out = self.hp.process(noise()) * self.env.process();
        if self.env.is_done() {
            self.done = true;
        }
        (out, out, self.done)
    }

    fn release_now(&mut self) {
        self.env.release_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kick_finishes_and_stays_silent_afterwards() {
        let sr = 48_000.0;
        let mut k = KickVoice::new(1.0, sr, false);
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

    #[test]
    fn release_now_ends_the_voice() {
        let sr = 48_000.0;
        let mut k = KickVoice::new(1.0, sr, false);
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
}
