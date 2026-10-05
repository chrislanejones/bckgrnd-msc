//! The scratch reader: a platter laid over the engine's own recent output.
//!
//! The engine synthesizes from a step sequence, so there is no record to drag. What
//! there is, is the ring of everything it has just played. A scratch freezes that
//! ring and reads it with a cursor whose speed the pointer sets, the way DJ software
//! scratches a deck: forward toward "now", backward into the past, held still.
//!
//! The reader owns no audio. It is handed the ring's two channels on every sample and
//! only keeps a window into them (where the oldest captured sample sits, and how many
//! there are), so starting a scratch copies nothing and allocates nothing.
//!
//! Everything here is per-sample arithmetic on plain fields: no allocation, no
//! transcendental calls on the audio path. The two exponentials are worked out once
//! at construction.

/// How long the reader takes to fade in on grab and out on release, in seconds. Also
/// how long the sequenced music takes to fade out under it.
pub(crate) const FADE_SECONDS: f32 = 0.015;

/// Platter inertia: the time constant of the one-pole that glides the read rate
/// toward the pointer's target. Long enough to iron out jittery pointer input, short
/// enough that a flick still reads as a flick.
const GLIDE_SECONDS: f32 = 0.02;

/// Gain ramp at either end of the captured window, so running into an edge fades
/// rather than stops dead.
const EDGE_SECONDS: f32 = 0.004;

/// Fastest the platter can be thrown, either way, in multiples of normal speed.
pub(crate) const MAX_RATE: f32 = 4.0;

/// Below this speed the output fades toward silence. A stylus that is not moving
/// across the groove makes no sound, and the fade keeps a held cursor from sitting
/// on a DC value.
const MOTION_FULL: f32 = 0.05;

/// The one-pole lowpass coefficient at a standstill, at 48 kHz: about 300 Hz. It
/// opens with speed and is fully open at normal speed and above, so slow drags sound
/// muffled the way a hand-turned platter does.
const LP_FLOOR_48K: f32 = 0.04;

/// Samples kept free at the old end of the window, so the ring can resume recording
/// during the release fade without overwriting anything the reader can still reach.
const GUARD_EXTRA: usize = 256;

pub(crate) struct Scratch {
    /// Gestures are live: the transport is paused and the ring is frozen.
    held: bool,
    /// The reader is producing output, which outlasts `held` by the release fade.
    active: bool,
    /// Ring index of the oldest sample in the window.
    origin: usize,
    /// Samples in the window.
    len: usize,
    /// Cursor, 0 at the oldest captured sample and `len - 1` at "now".
    pos: f32,
    rate: f32,
    target: f32,
    glide: f32,
    gain: f32,
    gain_target: f32,
    gain_step: f32,
    edge: f32,
    lp_floor: f32,
    lp_l: f32,
    lp_r: f32,
    guard: usize,
}

impl Scratch {
    pub(crate) fn new(sample_rate: f32) -> Self {
        let fade = (FADE_SECONDS * sample_rate).max(1.0);
        Self {
            held: false,
            active: false,
            origin: 0,
            len: 0,
            pos: 0.0,
            rate: 0.0,
            target: 0.0,
            glide: 1.0 - (-1.0 / (GLIDE_SECONDS * sample_rate).max(1.0)).exp(),
            gain: 0.0,
            gain_target: 0.0,
            gain_step: 1.0 / fade,
            edge: (EDGE_SECONDS * sample_rate).max(1.0),
            lp_floor: (LP_FLOOR_48K * 48_000.0 / sample_rate).clamp(0.001, 1.0),
            lp_l: 0.0,
            lp_r: 0.0,
            guard: fade as usize + GUARD_EXTRA,
        }
    }

    #[inline]
    pub(crate) fn held(&self) -> bool {
        self.held
    }

    #[inline]
    pub(crate) fn active(&self) -> bool {
        self.active
    }

    /// Grab the platter over a ring of `ring_len` samples whose next write goes to
    /// `write`, with `filled` of them holding real output.
    ///
    /// The cursor starts at "now", standing still. A fresh grab during the release
    /// fade of the last one recaptures; the reader's fade carries on from wherever it
    /// had got to, so there is no jump in level.
    pub(crate) fn capture(&mut self, ring_len: usize, write: usize, filled: usize) {
        let len = filled.min(ring_len.saturating_sub(self.guard));
        self.held = true;
        self.len = len;
        self.origin = if ring_len == 0 {
            0
        } else {
            (write % ring_len + ring_len - len) % ring_len
        };
        self.pos = len.saturating_sub(1) as f32;
        self.rate = 0.0;
        self.target = 0.0;
        self.gain_target = 1.0;
        self.active = len >= 2;
        if !self.active {
            self.gain = 0.0;
        }
    }

    /// Signed target speed: 1 forward at normal speed, -1 backward, 0 held still.
    /// Not finite reads as 0.
    pub(crate) fn set_target(&mut self, rate: f32) {
        self.target = if rate.is_finite() {
            rate.clamp(-MAX_RATE, MAX_RATE)
        } else {
            0.0
        };
    }

    /// Let go: fade the reader out. The ring may resume recording at once.
    pub(crate) fn release(&mut self) {
        self.held = false;
        self.gain_target = 0.0;
        self.target = 0.0;
    }

    /// One stereo sample from the frozen ring.
    #[inline]
    pub(crate) fn process(&mut self, left: &[f32], right: &[f32]) -> (f32, f32) {
        if !self.active {
            return (0.0, 0.0);
        }
        if self.gain < self.gain_target {
            self.gain = (self.gain + self.gain_step).min(self.gain_target);
        } else if self.gain > self.gain_target {
            self.gain = (self.gain - self.gain_step).max(self.gain_target);
        }
        let n = left.len().min(right.len());
        if (!self.held && self.gain <= 0.0) || n == 0 || self.len < 2 {
            self.active = false;
            self.gain = 0.0;
            self.lp_l = 0.0;
            self.lp_r = 0.0;
            return (0.0, 0.0);
        }

        // Platter inertia.
        self.rate += (self.target - self.rate) * self.glide;

        // Read at the cursor, linearly interpolated.
        let last = (self.len - 1) as f32;
        let pos = self.pos.clamp(0.0, last);
        let base = pos.floor();
        let f = pos - base;
        let i0 = base as usize;
        let i1 = (i0 + 1).min(self.len - 1);
        let a = (self.origin + i0) % n;
        let b = (self.origin + i1) % n;
        let l = left[a] + (left[b] - left[a]) * f;
        let r = right[a] + (right[b] - right[a]) * f;

        // Vinyl: slow drags are muffled. Fully open at normal speed and above.
        let speed = self.rate.abs();
        let x = speed.min(1.0);
        let k = self.lp_floor + (1.0 - self.lp_floor) * x * x;
        self.lp_l += (l - self.lp_l) * k;
        self.lp_r += (r - self.lp_r) * k;

        // Fades: release, standstill, and the two ends of the window.
        let motion = (speed / MOTION_FULL).min(1.0);
        let edge = (pos.min(last - pos) / self.edge).min(1.0);
        let g = self.gain * motion * edge;

        // Advance, stopping dead at either edge: no wraparound, and pushing against
        // an end holds the rate at zero there.
        let next = pos + self.rate;
        if next <= 0.0 {
            self.pos = 0.0;
            if self.rate < 0.0 {
                self.rate = 0.0;
            }
        } else if next >= last {
            self.pos = last;
            if self.rate > 0.0 {
                self.rate = 0.0;
            }
        } else {
            self.pos = next;
        }

        (self.lp_l * g, self.lp_r * g)
    }

    #[cfg(test)]
    pub(crate) fn pos(&self) -> f32 {
        self.pos
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    #[cfg(test)]
    pub(crate) fn force_rate(&mut self, rate: f32) {
        self.rate = rate;
        self.target = rate;
        self.gain = 1.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A chronological ramp in a ring of `n` samples, written from index 0, plus the
    /// next write index.
    fn ramp(n: usize, written: usize) -> (Vec<f32>, Vec<f32>, usize) {
        let mut l = vec![0.0; n];
        let mut r = vec![0.0; n];
        for i in 0..written {
            let at = i % n;
            l[at] = (i as f32 * 0.37).sin();
            r[at] = (i as f32 * 0.21).cos();
        }
        (l, r, written % n)
    }

    #[test]
    fn rate_minus_one_plays_the_capture_reversed() {
        let sr = 48_000.0;
        let n = 4_000;
        // Wrapped twice, so the window straddles the ring's seam.
        let (l, r, write) = ramp(n, 9_000);
        let mut s = Scratch::new(sr);
        s.capture(n, write, n);
        assert!(s.len() > 2_500, "window {}", s.len());
        s.force_rate(-1.0);
        // Out of the edge fade and fully open (rate 1 bypasses the lowpass).
        let skip = 400;
        for _ in 0..skip {
            s.process(&l, &r);
        }
        for k in 0..2_000 {
            let (ol, or) = s.process(&l, &r);
            // Call `skip + k` reads `skip + k` samples back from the newest, which
            // was the 9000th written.
            let at = (9_000 - 1 - skip - k) % n;
            let el = l[at];
            let er = r[at];
            assert!(
                (ol - el).abs() < 1e-4 && (or - er).abs() < 1e-4,
                "sample {k}: got ({ol}, {or}), want ({el}, {er})"
            );
        }
    }

    #[test]
    fn a_held_platter_is_silent_and_finite() {
        let sr = 48_000.0;
        let n = 4_000;
        let (l, r, write) = ramp(n, 4_000);
        let mut s = Scratch::new(sr);
        s.capture(n, write, n);
        s.set_target(-1.0);
        for _ in 0..2_000 {
            s.process(&l, &r);
        }
        s.set_target(0.0);
        // Let the glide settle to a standstill.
        for _ in 0..20_000 {
            let (a, b) = s.process(&l, &r);
            assert!(a.is_finite() && b.is_finite());
        }
        let p = s.pos();
        for _ in 0..1_000 {
            let (a, b) = s.process(&l, &r);
            assert!(
                a.abs() < 1e-3 && b.abs() < 1e-3,
                "held but sounding {a} {b}"
            );
        }
        assert!((s.pos() - p).abs() < 1.0, "a held cursor drifted");
    }

    #[test]
    fn the_cursor_stays_in_the_window_at_full_throw() {
        let sr = 48_000.0;
        let n = 4_000;
        let (l, r, write) = ramp(n, 6_000);
        let mut s = Scratch::new(sr);
        s.capture(n, write, n);
        let last = (s.len() - 1) as f32;
        for &target in &[
            -MAX_RATE * 10.0,
            MAX_RATE * 10.0,
            -MAX_RATE,
            f32::NAN,
            MAX_RATE,
        ] {
            s.set_target(target);
            for _ in 0..10_000 {
                let (a, b) = s.process(&l, &r);
                assert!(a.is_finite() && b.is_finite());
                assert!(a.abs() <= 1.0 + 1e-3 && b.abs() <= 1.0 + 1e-3);
                assert!(s.pos() >= 0.0 && s.pos() <= last, "cursor at {}", s.pos());
            }
        }
    }

    #[test]
    fn release_fades_out_then_stops_reading() {
        let sr = 48_000.0;
        let n = 4_000;
        let (l, r, write) = ramp(n, 4_000);
        let mut s = Scratch::new(sr);
        s.capture(n, write, n);
        s.force_rate(-1.0);
        for _ in 0..500 {
            s.process(&l, &r);
        }
        s.release();
        assert!(!s.held());
        for _ in 0..(FADE_SECONDS * sr) as usize + 2 {
            s.process(&l, &r);
        }
        assert!(!s.active());
        assert_eq!(s.process(&l, &r), (0.0, 0.0));
    }

    #[test]
    fn an_empty_ring_is_safe() {
        let mut s = Scratch::new(48_000.0);
        s.capture(0, 0, 0);
        s.set_target(-1.0);
        assert_eq!(s.process(&[], &[]), (0.0, 0.0));
        s.release();
        assert_eq!(s.process(&[], &[]), (0.0, 0.0));
    }
}
