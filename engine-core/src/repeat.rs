//! Beat Repeat: gesture kind 3, a momentary stutter (`docs/NIGHT10_PROTOCOL.md`).
//!
//! While a Beat Repeat gesture is held, the next grid line of the division (from the
//! transport's own onsets, so it is sample-accurate) starts a capture: one slice of the
//! pre-master signal plays through live and is recorded. From the end of that slice the
//! recording loops, and the live signal is muted under it. The transport, the scheduler
//! and every voice keep running underneath, so letting go lands back in time.
//!
//! What is captured is everything the master chain is fed for a sample: the dry sum,
//! the returns feed (the same as the dry sum unless a stem is soloed) and the per-stem
//! echo sends. Looping all five keeps the master filter, the echo, the reverb and their
//! held overrides acting on the stutter as they would on live audio, and the tails stay
//! natural.
//!
//! - **Slice length.** A division `d` (4, 8 or 16) is `8 / d` of the eighth the
//!   transport is actually playing: the transport fires each step on the sample after
//!   its length runs out, so an eighth is the two steps' lengths, each rounded up. With
//!   swing the eighth is still exact (swing only moves the sixteenth inside it). Slice
//!   `j` starts on sample `ceil(j * period)` after the grid line, so a fractional
//!   period (1/16) never drifts, and every eighth of repeats lines up with the
//!   transport's eighths exactly. The length is fixed when the slice is captured.
//! - **Seams.** Every looped slice fades in over its first [`SEAM_SECONDS`] and out over
//!   its last, and the live first pass fades out over its last, so each seam is a short
//!   linear dip and never a step.
//! - **Release.** Immediate: the repeat keeps looping under an equal-power crossfade
//!   back to live over [`RELEASE_SECONDS`].
//! - **A division change while engaged** re-captures on the next grid line of the new
//!   division, crossfading the old slice out over one seam time as the new live pass
//!   comes in.
//!
//! The buffer is allocated once, at construction, for a quarter note at the slowest
//! tempo the engine can run at its own sample rate. Nothing here allocates afterwards.

/// Channels captured per sample: dry left and right, returns left and right, echo send.
pub const CHANNELS: usize = 5;

/// The divisions, as note values: 4 is a quarter, 16 a sixteenth.
pub const DIVISIONS: [u8; 3] = [4, 8, 16];

/// The division a new engine starts with: eighths.
pub const DEFAULT_DIVISION: u8 = 8;

/// Seam ramp, each side of a loop seam.
pub const SEAM_SECONDS: f32 = 0.0025;

/// The equal-power crossfade back to live on release.
pub const RELEASE_SECONDS: f32 = 0.008;

/// The slowest tempo a slice can be captured at: the 40 BPM floor under the 0.9 tempo
/// bend. (Brake and backspin end a repeat, so their slower rates never capture.)
const MIN_TEMPO: f64 = 36.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// Not held, or released and faded out: the engine does not call in at all.
    Idle,
    /// Held, waiting for the next grid line. Live passes through unchanged.
    Armed,
    /// The first pass: live plays and is recorded.
    Capture,
    /// The recording loops; live is muted.
    Loop,
}

/// The fading-out voice a re-capture leaves behind.
#[derive(Clone, Copy, Debug)]
struct Tail {
    /// The live first pass (its fade-out still applies) rather than the recording.
    live: bool,
    /// Position inside the slice it was playing, and that slice's length.
    at: usize,
    len: usize,
    /// Samples of crossfade left.
    left: u32,
}

/// The Beat Repeat state. One per engine.
pub struct Repeat {
    buf: Vec<[f32; CHANNELS]>,
    division: u8,
    held: bool,
    phase: Phase,
    /// The division changed (or the transport restarted) while engaged: capture again on
    /// the next grid line.
    regrid: bool,
    /// Slice length in samples (fractional), and the slice playing now.
    period: f64,
    slice: u64,
    /// Samples since the grid line, and the current slice's span in those samples.
    clock: u64,
    start: u64,
    end: u64,
    /// Samples recorded in this capture.
    written: usize,
    tail: Option<Tail>,
    /// Seam ramp, in samples.
    seam: f32,
    /// Release crossfade, in samples, and how much of it is left.
    release_len: u32,
    release_left: u32,
}

impl Repeat {
    pub fn new(sample_rate: f32) -> Self {
        let sr = sample_rate.max(1.0) as f64;
        let cap = (sr * 60.0 / MIN_TEMPO).ceil() as usize + 2;
        Self {
            buf: vec![[0.0; CHANNELS]; cap],
            division: DEFAULT_DIVISION,
            held: false,
            phase: Phase::Idle,
            regrid: false,
            period: 1.0,
            slice: 0,
            clock: 0,
            start: 0,
            end: 0,
            written: 0,
            tail: None,
            seam: (SEAM_SECONDS * sample_rate).max(1.0),
            release_len: (RELEASE_SECONDS * sample_rate).max(1.0) as u32,
            release_left: 0,
        }
    }

    /// Set the division (4, 8 or 16). False, and nothing changed, for any other
    /// value. While engaged, the new division re-captures on its next grid line.
    pub fn set_division(&mut self, division: u8) -> bool {
        if !DIVISIONS.contains(&division) {
            return false;
        }
        if division != self.division {
            self.division = division;
            self.restart();
        }
        true
    }

    pub fn division(&self) -> u8 {
        self.division
    }

    /// Whether a Beat Repeat is held (armed or engaged).
    #[inline]
    pub fn held(&self) -> bool {
        self.held
    }

    /// Whether the engine must route the pre-master signal through [`Repeat::process`].
    /// False means a true bypass.
    #[inline]
    pub fn active(&self) -> bool {
        self.phase != Phase::Idle
    }

    /// Whether the recording is looping (not armed, not on the live first pass).
    pub fn looping(&self) -> bool {
        self.held && self.phase == Phase::Loop
    }

    /// The slice length in samples, as last captured.
    #[cfg(test)]
    pub(crate) fn period(&self) -> f64 {
        self.period
    }

    /// Slices begun since the grid line (0 on the live pass), and whether it is on the
    /// live pass: what the tests watch for seams.
    #[cfg(test)]
    pub(crate) fn position(&self) -> (u64, bool) {
        (self.slice, self.phase == Phase::Capture)
    }

    /// Engage: wait for the next grid line.
    pub fn hold(&mut self) {
        if self.held {
            return;
        }
        self.held = true;
        // Still fading out from a release: the fade finishes first, then this arms.
        if self.release_left == 0 {
            self.phase = Phase::Armed;
            self.tail = None;
        }
    }

    /// Let go: crossfade back to live, or stop at once if nothing was captured yet.
    pub fn release(&mut self) {
        if !self.held {
            return;
        }
        self.held = false;
        self.regrid = false;
        if self.release_left > 0 {
            // Held again and let go again inside one fade: the fade carries on.
            return;
        }
        match self.phase {
            Phase::Capture | Phase::Loop => self.release_left = self.release_len,
            Phase::Idle | Phase::Armed => {
                self.phase = Phase::Idle;
                self.tail = None;
            }
        }
    }

    /// Capture again on the next grid line (a division change, or the transport
    /// restarting from the top while engaged).
    pub fn restart(&mut self) {
        if self.held && matches!(self.phase, Phase::Capture | Phase::Loop) {
            self.regrid = true;
        }
    }

    /// Sixteenth steps between grid lines of the division.
    fn grid_steps(&self) -> usize {
        match self.division {
            4 => 4,
            8 => 2,
            _ => 1,
        }
    }

    /// A transport onset of `step`. `eighth` is the length in samples of the eighth the
    /// transport is playing now. Engages (or re-captures) on a grid line of the division.
    pub fn on_onset(&mut self, step: usize, eighth: f64) {
        if !self.held || self.release_left > 0 || !step.is_multiple_of(self.grid_steps()) {
            return;
        }
        if self.phase == Phase::Armed || self.regrid {
            self.engage(eighth);
        }
    }

    fn engage(&mut self, eighth: f64) {
        let cap = self.buf.len() as f64;
        let period = (eighth * 8.0 / self.division as f64).clamp(4.0 * self.seam as f64, cap);
        // What was sounding fades out under the new live pass.
        self.tail = match self.phase {
            Phase::Capture | Phase::Loop => Some(Tail {
                live: self.phase == Phase::Capture,
                at: (self.clock - self.start) as usize,
                len: (self.end - self.start) as usize,
                left: self.seam as u32,
            }),
            _ => None,
        };
        self.phase = Phase::Capture;
        self.regrid = false;
        self.period = period;
        self.slice = 0;
        self.clock = 0;
        self.start = 0;
        self.end = (period.ceil() as u64).min(self.buf.len() as u64);
        self.written = 0;
    }

    /// The ramp at position `i` of a slice `len` long: up over the first seam time
    /// (unless `first`, the live pass, which was already sounding) and down over the last.
    #[inline]
    fn ramp(&self, i: usize, len: usize, first: bool) -> f32 {
        let down = (len.saturating_sub(i)) as f32 / self.seam;
        let g = if first {
            down
        } else {
            down.min(i as f32 / self.seam)
        };
        g.min(1.0)
    }

    /// One sample. `live` is what the master would be fed; the return is what it is fed
    /// instead. Only called while [`Repeat::active`].
    #[inline]
    pub fn process(&mut self, live: [f32; CHANNELS]) -> [f32; CHANNELS] {
        let i = (self.clock - self.start) as usize;
        let len = (self.end - self.start) as usize;
        let first = self.phase == Phase::Capture;
        let mut out = match self.phase {
            Phase::Idle | Phase::Armed => return live,
            Phase::Capture => scale(live, self.ramp(i, len, true)),
            Phase::Loop => {
                let at = i.min(self.written.saturating_sub(1));
                scale(self.buf[at], self.ramp(i, len, false))
            }
        };

        // A re-capture's old voice, read before this sample is recorded over it (it
        // always reads at or ahead of the write position).
        if let Some(mut t) = self.tail {
            let fade = t.left as f32 / self.seam;
            let old = if t.live {
                scale(live, self.ramp(t.at, t.len, true))
            } else if t.at < t.len {
                scale(self.buf[t.at], self.ramp(t.at, t.len, false))
            } else {
                [0.0; CHANNELS]
            };
            if t.live {
                // Live into live: a linear blend of the two gains, not a power sum.
                mix(&mut out, 1.0 - fade, &old, fade);
            } else {
                let (gin, gout) = equal_power(1.0 - fade);
                mix(&mut out, gin, &old, gout);
            }
            t.at += 1;
            t.left -= 1;
            self.tail = (t.left > 0).then_some(t);
        }

        if self.phase == Phase::Capture && i < self.buf.len() {
            self.buf[i] = live;
            self.written = i + 1;
        }

        self.clock += 1;
        if self.clock >= self.end {
            self.slice += 1;
            self.start = self.end;
            self.end = ((self.slice + 1) as f64 * self.period).ceil() as u64;
            if self.end <= self.start {
                self.end = self.start + 1;
            }
            self.phase = Phase::Loop;
        }

        if self.release_left > 0 {
            let f = 1.0 - self.release_left as f32 / self.release_len as f32;
            if first {
                // Releasing during the live pass: live into live, linear.
                mix(&mut out, 1.0 - f, &live, f);
            } else {
                let (gin, gout) = equal_power(f);
                mix(&mut out, gout, &live, gin);
            }
            self.release_left -= 1;
            if self.release_left == 0 {
                // Held again during the fade: arm for the next grid line.
                self.phase = if self.held { Phase::Armed } else { Phase::Idle };
                self.tail = None;
            }
        }
        out
    }
}

/// Equal-power gains `(in, out)` at `f` (0..1) through a crossfade: a quarter sine, so
/// both start and end with a gentle slope.
#[inline]
fn equal_power(f: f32) -> (f32, f32) {
    let a = f.clamp(0.0, 1.0) * core::f32::consts::FRAC_PI_2;
    (a.sin(), a.cos())
}

#[inline]
fn scale(x: [f32; CHANNELS], g: f32) -> [f32; CHANNELS] {
    x.map(|v| v * g)
}

/// `out = out * a + b * gb`, per channel.
#[inline]
fn mix(out: &mut [f32; CHANNELS], a: f32, b: &[f32; CHANNELS], gb: f32) {
    for (o, v) in out.iter_mut().zip(b) {
        *o = *o * a + v * gb;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A slow sine on every channel, so its own sample-to-sample step is tiny.
    fn sine(n: u64) -> [f32; CHANNELS] {
        [(n as f32 * 0.01).sin() * 0.9; CHANNELS]
    }

    #[test]
    fn only_the_divisions_are_accepted() {
        let mut r = Repeat::new(48_000.0);
        assert_eq!(r.division(), 8);
        for d in [0, 1, 2, 3, 5, 12, 32, 64, 255] {
            assert!(!r.set_division(d));
        }
        for d in DIVISIONS {
            assert!(r.set_division(d));
            assert_eq!(r.division(), d);
        }
    }

    #[test]
    fn armed_passes_live_through_untouched() {
        let mut r = Repeat::new(48_000.0);
        r.hold();
        assert!(r.active());
        for n in 0..1000 {
            let x = sine(n);
            assert_eq!(r.process(x), x);
        }
        r.on_onset(1, 12_000.0); // off the eighth grid
        assert!(!r.looping());
        r.release();
        assert!(!r.active(), "nothing captured: released at once");
    }

    #[test]
    fn the_buffer_holds_a_quarter_at_the_slowest_tempo() {
        for sr in [32_000.0f32, 44_100.0, 48_000.0, 96_000.0, 192_000.0] {
            let r = Repeat::new(sr);
            assert!(r.buf.len() as f64 >= sr as f64 * 60.0 / 36.0, "{sr}");
        }
    }
}
