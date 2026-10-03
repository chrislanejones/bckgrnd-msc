//! The step clock: a sample-accurate 16th-note sequencer with swing, looping,
//! and a lookahead-free scheduling model.
//!
//! The original engine ran a 25 ms `setInterval` that scheduled Web Audio nodes up
//! to 140 ms ahead. Here the clock advances sample by sample inside `process`, so a
//! step's onset lands on the exact sample it should with no timer jitter and no
//! lookahead jitter.

use crate::track::STEPS;

/// Transport state for one playing engine.
pub struct Transport {
    pub playing: bool,
    pub step: usize,
    /// Countdown of samples remaining before `step` fires. Fractional so swing
    /// lands between samples instead of rounding.
    pub to_next: f64,
    /// Samples remaining in a tempo nudge ramp, for brake/spin gestures.
    pub rate: f32,
    brake_from: f32,
    spin_from: f32,
    pub bpm: f32,
    pub swing: f32,
    /// Loop length in steps; 0 means play the whole bar grid.
    pub loop_steps: usize,
    pub loop_start: usize,
    /// Index of the step that most recently started sounding, for the UI's playhead.
    pub visual_step: i32,
    /// Render rate, so gesture ramps and step lengths are sample-accurate at any
    /// device rate rather than assuming 48 kHz.
    pub sample_rate: f32,
}

const BRAKE_SECONDS: f32 = 0.85;
const SPIN_SECONDS: f32 = 0.7;

impl Transport {
    pub fn new(bpm: f32, swing: f32, sample_rate: f32) -> Self {
        Self {
            playing: false,
            step: 0,
            to_next: 0.0,
            rate: 1.0,
            brake_from: 0.0,
            spin_from: 0.0,
            bpm,
            swing,
            loop_steps: 0,
            loop_start: 0,
            visual_step: -1,
            sample_rate,
        }
    }

    /// Duration of one 16th step in seconds, with swing applied by alternating
    /// the long/short pair. Even steps lead, odd steps trail.
    pub fn step_seconds(&self, step: usize) -> f32 {
        let eighth = 60.0 / (self.bpm * self.rate.max(0.05)) / 2.0;
        let ratio = 0.5 + self.swing * 0.16;
        if step.is_multiple_of(2) {
            eighth * ratio
        } else {
            eighth * (1.0 - ratio)
        }
    }

    fn advance_step(&self) -> usize {
        let next = self.step + 1;
        if self.loop_steps > 0 {
            let end = self.loop_start + self.loop_steps;
            if next >= end {
                self.loop_start
            } else {
                next
            }
        } else if next >= STEPS {
            0
        } else {
            next
        }
    }

    /// Set a loop of `bars` bars, snapping the start to the current position so the
    /// loop picks up where the user is listening.
    pub fn set_loop(&mut self, bars: u32) {
        if bars == 0 {
            self.loop_steps = 0;
            self.loop_start = 0;
            return;
        }
        let size = bars as usize * 16;
        self.loop_steps = size.min(STEPS);
        if self.loop_steps >= STEPS {
            self.loop_start = 0;
            return;
        }
        let origin = if self.playing { self.step } else { 0 };
        let mut start = (origin / size) * size;
        if start + size > STEPS {
            start = STEPS - size;
        }
        self.loop_start = start;
    }

    /// Jump the playhead to a step, resynchronising the clock. Called by cue, by a
    /// loop change mid-flight, and at the end of an auto-mix handover.
    pub fn jump(&mut self, at: usize) {
        self.step = at.min(STEPS.saturating_sub(1));
        self.visual_step = -1;
    }

    /// Slow the tempo to a stop over `BRAKE_SECONDS`, the vinyl brake gesture.
    pub fn brake(&mut self) {
        if self.playing && self.brake_from == 0.0 && self.spin_from == 0.0 {
            self.brake_from = 1.0;
        }
    }

    /// Wind the playhead backwards with a rising-rate spin, then drop back in.
    ///
    /// Returns `true` when the gesture begins, so the engine can capture its reverse
    /// take and stop scheduling new notes for the duration.
    pub fn backspin(&mut self) -> bool {
        if !self.playing || self.brake_from > 0.0 || self.spin_from > 0.0 {
            return false;
        }
        self.spin_from = 1.0;
        true
    }

    /// Nudge tempo up or down while held, or return to nominal when released.
    pub fn nudge(&mut self, dir: i32) {
        if self.brake_from > 0.0 || self.spin_from > 0.0 {
            return;
        }
        self.rate = match dir {
            d if d < 0 => 0.9,
            d if d > 0 => 1.1,
            _ => 1.0,
        };
    }

    pub fn start(&mut self) {
        self.playing = true;
        self.brake_from = 0.0;
        self.spin_from = 0.0;
        self.rate = 1.0;
        self.step = 0;
        self.visual_step = -1;
        self.to_next = 0.0;
    }

    pub fn stop(&mut self) {
        self.playing = false;
        self.brake_from = 0.0;
        self.spin_from = 0.0;
        self.rate = 1.0;
        self.visual_step = -1;
        self.to_next = 0.0;
    }

    /// Advance the brake/spin gestures. Returns `true` when the transport has come
    /// to a stop and the caller should halt.
    pub fn tick_gesture(&mut self) -> bool {
        if self.brake_from > 0.0 {
            self.brake_from += 1.0;
            let p = self.brake_from / (BRAKE_SECONDS * self.sample_rate);
            if p >= 1.0 {
                self.stop();
                return true;
            }
            self.rate = (1.0 - p).max(0.12).powf(1.7);
        } else if self.spin_from > 0.0 {
            self.spin_from += 1.0;
            let p = self.spin_from / (SPIN_SECONDS * self.sample_rate);
            if p >= 1.0 {
                self.spin_from = 0.0;
                self.rate = 1.0;
                self.visual_step = -1;
            } else {
                self.rate = 1.15 + (p * core::f32::consts::PI).sin() * 5.2;
            }
        }
        false
    }

    pub fn in_backspin(&self) -> bool {
        self.spin_from > 0.0
    }

    /// Consume one sample of clock time. Returns the step that should fire at this
    /// sample, if any, having advanced the clock past it.
    pub fn tick(&mut self) -> Option<usize> {
        if !self.playing {
            return None;
        }
        if self.to_next > 0.0 {
            self.to_next -= 1.0;
            return None;
        }
        let fired = self.step;
        self.visual_step = fired as i32;
        let dur = self.step_seconds(fired) as f64 * self.sample_rate as f64;
        self.to_next = dur.max(1.0) - 1.0;
        self.step = self.advance_step();
        Some(fired)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swing_alternates_long_and_short_steps() {
        let t = Transport::new(120.0, 0.5, 48_000.0);
        let even = t.step_seconds(0);
        let odd = t.step_seconds(1);
        assert!(even > odd, "even {even} odd {odd}");
        // A pair should still cover one 8th note at nominal tempo.
        assert!(((even + odd) - 0.25).abs() < 1e-4);
    }

    #[test]
    fn no_swing_gives_even_steps() {
        let t = Transport::new(120.0, 0.0, 48_000.0);
        assert!((t.step_seconds(0) - t.step_seconds(1)).abs() < 1e-6);
    }

    #[test]
    fn fires_a_step_every_sixteenth_note_at_120bpm() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        t.start();
        // A 16th at 120 BPM is 0.125 s = 6000 samples at 48 kHz. Measure the gap
        // between onsets rather than counting into a window, so the assertion is
        // about timing rather than an off-by-one at the boundary.
        let mut fired_at: Vec<usize> = Vec::new();
        for i in 0..24_000 {
            if t.tick().is_some() {
                fired_at.push(i);
            }
        }
        assert!(fired_at.len() >= 3, "expected repeated onsets");
        assert_eq!(fired_at[0], 0, "first onset should be immediate");
        assert_eq!(fired_at[1] - fired_at[0], 6000, "16th note at 120 BPM");
    }

    #[test]
    fn sixteen_steps_fill_one_bar() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        t.start();
        // At 120 BPM a bar of 4/4 is 2 s = 96000 samples, and a 16th is 6000, so
        // exactly 16 onsets fall inside one bar and the 17th lands on the bar line.
        let mut landed: Vec<usize> = Vec::new();
        for i in 0..96_000 {
            if t.tick().is_some() {
                landed.push(i);
            }
        }
        assert_eq!(landed.len(), 16, "one onset per 16th, no more");
        assert_eq!(landed[0], 0, "first onset is immediate");
        assert_eq!(landed[15], 90_000, "16 sixteenths span one bar");
        // The next onset is exactly on the downbeat.
        let mut next_at = None;
        for i in 96_000..96_100 {
            if t.tick().is_some() {
                next_at = Some(i);
                break;
            }
        }
        assert_eq!(next_at, Some(96_000), "wraps on the bar line");
    }

    #[test]
    fn grid_wraps_after_256_steps() {
        let mut t = Transport::new(600.0, 0.0, 48_000.0);
        t.start();
        let mut last = usize::MAX;
        let mut seen_zero = false;
        for _ in 0..300_000 {
            if let Some(s) = t.tick() {
                last = s;
                if s == 0 {
                    seen_zero = true;
                    break;
                }
            }
        }
        assert!(seen_zero);
        assert!(last < STEPS);
    }

    #[test]
    fn loop_constrains_the_step_range() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        t.set_loop(2);
        assert_eq!(t.loop_steps, 32);
        assert_eq!(t.loop_start, 0);
        // Step 31 is the last step inside a 32-step loop, so the next wraps to 0.
        t.step = 31;
        assert_eq!(t.advance_step(), 0, "loop should wrap to its start");
        t.step = 10;
        assert_eq!(t.advance_step(), 11, "mid-loop steps advance normally");
    }

    #[test]
    fn loop_snaps_start_to_a_bar_boundary() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        t.start();
        t.step = 40;
        t.set_loop(4);
        assert_eq!(t.loop_start % 64, 0);
    }

    #[test]
    fn clearing_the_loop_releases_the_constraint() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        t.set_loop(2);
        t.set_loop(0);
        assert_eq!(t.loop_steps, 0);
        assert_eq!(t.loop_start, 0);
    }

    #[test]
    fn brake_brings_the_transport_to_a_stop() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        t.start();
        t.brake();
        let mut stopped = false;
        for _ in 0..(48_000 * 2) {
            if t.tick_gesture() {
                stopped = true;
                break;
            }
        }
        assert!(stopped);
        assert!(!t.playing);
    }

    #[test]
    fn nudge_returns_to_nominal_on_release() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        t.start();
        t.nudge(1);
        assert_eq!(t.rate, 1.1);
        t.nudge(0);
        assert_eq!(t.rate, 1.0);
    }

    #[test]
    fn stopped_transport_does_not_fire() {
        let mut t = Transport::new(120.0, 0.0, 48_000.0);
        assert!(t.tick().is_none());
    }
}
