//! # bckgrnd-msc-engine
//!
//! The audio engine for the bckgrnd-msc stem machine, ported from a Web Audio node graph
//! to sample-accurate Rust that compiles to WebAssembly.
//!
//! ## What changed, and why it matters
//!
//! The original built a fresh Web Audio node per voice — two `OscillatorNode`s, a
//! `BiquadFilterNode`, a `GainNode`, sometimes a `StereoPannerNode` — and scheduled
//! them from a 25 ms `setInterval` up to 140 ms ahead. Three consequences:
//!
//! 1. **Timing jitter.** The lookahead horizon absorbed timer drift, but a busy main
//!    thread could still starve the interval, and the visual playhead had to be
//!    interpolated separately from what you heard.
//! 2. **Allocation churn.** Every note created and tore down nodes on the audio
//!    thread's schedule queue, which is what `AudioContext` resamples against.
//! 3. **A deprecated tap.** The backspin gesture read its reversed take from a
//!    `ScriptProcessorNode`, which is deprecated in every major browser and absent
//!    from the spec's roadmap.
//!
//! This port keeps the same instrument — same per-stem voicing, same filter and
//! envelope times, same ducking character — but runs it as plain arithmetic:
//!
//! - **Sample-accurate sequencing.** [`Transport::tick`] advances once per sample
//!   inside [`Engine::process`], so an onset lands on the exact sample and the UI
//!   playhead is simply `visual_step`. There is no interval and no lookahead.
//! - **Fixed voice pool.** Voices are allocated up front and recycled, so no
//!   allocation happens on the audio path.
//! - **No `ScriptProcessor`.** Backspin reads a ring buffer the engine fills itself.
//! - **True stereo.** [`ToneVoice`] pans partials equal-power instead of routing
//!   through a channel splitter.
//!
//! ## Architecture
//!
//! ```text
//! sample ──▶ Transport ──▶ spawn voices for the step
//!                              │
//!                              ▼
//!                         active voices ──▶ [Channel; 8] buses
//!                                                    │ fader, mute/solo, duck
//!                                                    ▼
//!                                              Master ──▶ out_l, out_r
//! ```
//!
//! ## Usage
//!
//! From Rust, drive it directly:
//!
//! ```
//! use bckgrnd_msc_engine::{Engine, Track};
//!
//! let mut engine = Engine::new(48_000.0);
//! engine.load_track(Track::silence("demo"));
//! engine.play();
//! let mut left = [0.0f32; 128];
//! let mut right = [0.0f32; 128];
//! engine.process(&mut left, &mut right);
//! assert!(engine.is_playing());
//! ```
//!
//! From JavaScript, [`Engine`] is a `wasm_bindgen` class and the crate is built by
//! `wasm-pack`; the audio worklet calls [`Engine::process`] with 128-frame blocks.

mod drums;
mod dsp;
mod gesture;
mod mixer;
mod scheduler;
mod scratch;
mod tone;
mod track;
mod transition;
mod transport;

use core::f32::consts::FRAC_1_SQRT_2;
use drums::DrumVoice as _;

pub use drums::PercKind;
pub use mixer::{Bus, Channel, Ducker, Master};

/// The engine's defaults and ranges for the parameters the UI exposes, so a test can
/// hold them against `contracts/parameters.json`.
pub mod limits {
    pub use crate::dsp::{ROOM_RT60, ROOM_RT60_MAX, ROOM_RT60_MIN};
    pub use crate::mixer::{
        ECHO_FEEDBACK, ECHO_FEEDBACK_MAX, ECHO_RETURN, FILTER_Q, FILTER_Q_MAX, FILTER_Q_MIN,
        VERB_WET, VERB_WET_MAX, WIDTH_MAX,
    };
}
pub use track::{DrumStep, Fill, NoteEvent, Perc, Stem, Track, TrackKind, FILL_STEPS, STEPS};

/// Performance gestures (`docs/NIGHT3_PROTOCOL.md`, Gestures): the kinds, the
/// capacity, the lease, and what Filter Hold does.
pub mod perform {
    pub use crate::gesture::{kind, LEASE_SECONDS, MAX_GESTURES};
    pub use crate::mixer::{FILTER_HOLD_OPEN, FILTER_HOLD_Q, FILTER_HOLD_TRIM};
}

/// The scene vector's layout, the timing, event and reason codes, and the validator,
/// as `docs/NIGHT3_PROTOCOL.md` defines them. Exported so tests can hold them against
/// `contracts/scenes.json` and `contracts/parameters.json`.
pub mod scene {
    pub use crate::scheduler::{
        event, reason, slot_kind, timing, valid, SlotKind, Timing, ECHO_TIME_OPTIONS,
        EVENT_CAPACITY, EVENT_WIDTH, FX_BASE, FX_KINDS, SCENE_LEN, SCENE_PARAMS, STEM_FIELDS,
    };
}
use scheduler::{reason, SCENE_LEN};
pub use transport::Transport;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// A voice currently sounding, in one of two families.
enum Voice {
    Kick(drums::KickVoice),
    Clap(drums::ClapVoice),
    Hat(drums::HatVoice),
    Perc(drums::PercVoice),
    Tone(tone::ToneVoice),
    Reverse(ReverseVoice),
}

impl Voice {
    #[inline]
    fn process(&mut self) -> (f32, f32, bool) {
        match self {
            Voice::Kick(v) => v.process(),
            Voice::Clap(v) => v.process(),
            Voice::Hat(v) => v.process(),
            Voice::Perc(v) => v.process(),
            Voice::Tone(v) => v.process(),
            Voice::Reverse(v) => v.process(),
        }
    }

    #[inline]
    fn release(&mut self) {
        match self {
            Voice::Kick(v) => v.release_now(),
            Voice::Clap(v) => v.release_now(),
            Voice::Hat(v) => v.release_now(),
            Voice::Perc(v) => v.release_now(),
            Voice::Tone(v) => v.release_now(),
            Voice::Reverse(v) => v.release_now(),
        }
    }

    /// Which stem's channel this voice sums into, or `None` for one that bypasses the
    /// channels entirely.
    ///
    /// The backspin take is full-mix audio that has already been through the stem
    /// faders once, so it goes straight into the master sum, as the original's
    /// `g.connect(this.master)` does. It used to be routed through the arp's channel
    /// instead — the comment said "bypasses the stem faders" while the code handed it
    /// to a fader, a mute, a solo and the kick's duck. On a track whose arp sits at
    /// 0.14 the gesture was barely audible, and with the arp cut it was silent.
    #[inline]
    fn stem(&self) -> Option<usize> {
        match self {
            Voice::Kick(_) => Some(Stem::Kick.index()),
            Voice::Clap(_) => Some(Stem::Clap.index()),
            // The hand percussion rides the hats' fader, cut and solo.
            Voice::Hat(_) | Voice::Perc(_) => Some(Stem::Hats.index()),
            Voice::Tone(v) => Some(v.stem_index()),
            Voice::Reverse(_) => None,
        }
    }
}

/// Gain floor for the backspin envelopes, matching the `0.0001` the original ramps
/// its gains to and from.
const SPIN_FLOOR: f32 = 0.0001;

#[derive(Clone, Copy, PartialEq, Eq)]
enum SpinStage {
    Attack,
    Hold,
    Release,
    Done,
}

/// Plays a captured buffer at a swept rate: the backspin gesture.
///
/// The reversal is in how the buffer was captured, not in how it is read.
/// [`Ring::take`] returns the recent past newest-sample-first, so reading it *forward*
/// plays "now" first and walks back into the past, which is the backspin. The
/// synthesised fallbacks are built the ordinary way round, oldest-first, and reading
/// those forward plays the sweep as composed. One read direction is right for both.
///
/// Reading it backwards instead — from the end of the buffer to the start, as this
/// did — plays the captured audio in its original order. Not a backspin at all: the
/// last second and a bit of the track, again, at the wrong speed.
struct ReverseVoice {
    left: Vec<f32>,
    right: Vec<f32>,
    /// Read position in samples, advancing forward through the buffer.
    cursor: f32,
    /// Playback rate, swept up and then back down across the gesture.
    rate: f32,
    rate_from: f32,
    rate_mid: f32,
    rate_to: f32,
    /// Sample counts for the two rate ramps.
    ramp_up: f32,
    ramp_down: f32,
    /// Samples since the voice started, for the rate sweep.
    t: f32,
    /// Envelope, kept here rather than in [`dsp::Adsr`] so the hold can be timed from
    /// note-on. The shared envelope measures its hold from the end of the attack.
    stage: SpinStage,
    elapsed: f32,
    peak: f32,
    attack: f32,
    /// Samples from note-on at which the release begins.
    hold_until: f32,
    release: f32,
    done: bool,
}

/// How a backspin voice is shaped. Times in seconds.
struct SpinShape {
    /// `from` to `mid` across `ramp_up`, then `mid` to `to` across `ramp_down`.
    rate_from: f32,
    rate_mid: f32,
    rate_to: f32,
    ramp_up: f32,
    ramp_down: f32,
    peak: f32,
    attack: f32,
    /// Measured from note-on, not from the end of the attack.
    hold_until: f32,
    release: f32,
}

impl ReverseVoice {
    fn new(left: Vec<f32>, right: Vec<f32>, shape: SpinShape, sr: f32) -> Self {
        Self {
            cursor: 0.0,
            rate: shape.rate_from,
            rate_from: shape.rate_from,
            rate_mid: shape.rate_mid,
            rate_to: shape.rate_to,
            ramp_up: (shape.ramp_up * sr).max(1.0),
            ramp_down: (shape.ramp_down * sr).max(1.0),
            t: 0.0,
            stage: SpinStage::Attack,
            elapsed: 0.0,
            peak: shape.peak,
            attack: (shape.attack * sr).max(1.0),
            hold_until: (shape.hold_until * sr).max(1.0),
            release: (shape.release * sr).max(1.0),
            left,
            right,
            done: false,
        }
    }

    /// Constant-rate playback of a buffer that already carries its own shape.
    fn flat(left: Vec<f32>, right: Vec<f32>, dur: f32, sr: f32) -> Self {
        Self::new(
            left,
            right,
            SpinShape {
                rate_from: 1.0,
                rate_mid: 1.0,
                rate_to: 1.0,
                ramp_up: dur,
                ramp_down: dur,
                peak: 1.0,
                // A couple of milliseconds either end, only to avoid a click.
                attack: 0.002,
                hold_until: (dur - 0.002).max(0.004),
                release: 0.002,
            },
            sr,
        )
    }

    fn sample_at(&self, cursor: f32) -> (f32, f32) {
        let n = self.left.len();
        if n == 0 {
            return (0.0, 0.0);
        }
        let c = cursor.clamp(0.0, (n - 1) as f32);
        let i0 = c.floor() as usize;
        let i1 = (i0 + 1).min(n - 1);
        let f = c - c.floor();
        (
            self.left[i0] * (1.0 - f) + self.left[i1] * f,
            self.right[i0] * (1.0 - f) + self.right[i1] * f,
        )
    }
}

impl ReverseVoice {
    fn process(&mut self) -> (f32, f32, bool) {
        if self.done {
            return (0.0, 0.0, true);
        }

        // Wind up, then ease back toward normal speed: the reference ramps
        // `playbackRate` 0.62 -> 2.8 by 0.42 s and then 2.8 -> 1.15 by 0.66 s. Only
        // the first of those was here, so the gesture accelerated for 420 ms and then
        // stayed at nearly 3x for the rest of its length instead of settling.
        //
        // `geom`, not `exp_between`: that helper floors both ends at 20, because it
        // exists for filter frequencies and 20 Hz is the bottom of hearing. Applied to
        // a playback *rate* it turned 0.62 and 2.8 into 20 and 20, so every backspin
        // played at a flat twenty times speed and tore through 1.35 s of audio in 67
        // ms. That was most of what made this sound wrong.
        self.t += 1.0;
        if self.t < self.ramp_up {
            self.rate = dsp::geom(self.rate_from, self.rate_mid, self.t / self.ramp_up);
        } else if self.t < self.ramp_up + self.ramp_down {
            let p = (self.t - self.ramp_up) / self.ramp_down;
            self.rate = dsp::geom(self.rate_mid, self.rate_to, p);
        } else {
            self.rate = self.rate_to;
        }

        let (l, r) = self.sample_at(self.cursor);
        let g = self.envelope();
        self.cursor += self.rate;

        let last = self.left.len().max(1) - 1;
        if self.cursor >= last as f32 || self.stage == SpinStage::Done {
            self.done = true;
        }
        (l * g, r * g, self.done)
    }

    /// Attack, flat hold, release — the shape the original automates onto the gain.
    fn envelope(&mut self) -> f32 {
        self.elapsed += 1.0;
        match self.stage {
            SpinStage::Attack => {
                let v = dsp::geom(SPIN_FLOOR, self.peak, self.elapsed / self.attack);
                if self.elapsed >= self.attack {
                    self.stage = SpinStage::Hold;
                }
                v
            }
            SpinStage::Hold => {
                // `elapsed` is still counted from note-on here, so the hold ends where
                // it was asked to rather than an attack later.
                if self.elapsed >= self.hold_until {
                    self.stage = SpinStage::Release;
                    self.elapsed = 0.0;
                }
                self.peak
            }
            SpinStage::Release => {
                let v = dsp::geom(self.peak, SPIN_FLOOR, self.elapsed / self.release);
                if self.elapsed >= self.release {
                    self.stage = SpinStage::Done;
                }
                v
            }
            SpinStage::Done => 0.0,
        }
    }

    fn release_now(&mut self) {
        if self.stage != SpinStage::Done {
            self.stage = SpinStage::Release;
            self.elapsed = 0.0;
        }
    }
}

/// Upper bound on simultaneously sounding voices. A four-on-the-floor pattern with
/// an eight-note pad and a lead line peaks well under this; the cap exists so a
/// dense arrangement degrades by stealing the quietest voice rather than allocating.
const MAX_VOICES: usize = 48;

/// Seconds of output the ring keeps. The backspin takes 1.35 s of it; the scratch
/// gesture can reach back across nearly all of it.
const RING_SECONDS: f32 = 4.0;

/// Ring buffer holding the last four seconds of output, for the backspin and scratch
/// gestures, replacing the original's `ScriptProcessorNode` tap.
struct Ring {
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
    /// Samples written since the last clear, saturating at the ring's length, so a
    /// scratch knows how far back real output goes.
    filled: usize,
}

impl Ring {
    fn new(sample_rate: f32) -> Self {
        let n = ((sample_rate * RING_SECONDS) as usize).max(2);
        Self {
            left: vec![0.0; n],
            right: vec![0.0; n],
            write: 0,
            filled: 0,
        }
    }

    #[inline]
    fn push(&mut self, l: f32, r: f32) {
        self.left[self.write] = l;
        self.right[self.write] = r;
        self.write = (self.write + 1) % self.left.len();
        if self.filled < self.left.len() {
            self.filled += 1;
        }
    }

    fn clear(&mut self) {
        self.left.iter_mut().for_each(|v| *v = 0.0);
        self.right.iter_mut().for_each(|v| *v = 0.0);
        self.write = 0;
        self.filled = 0;
    }

    /// Copy the most recent `seconds` of output, newest first.
    fn take(&self, seconds: f32, sample_rate: f32) -> Option<(Vec<f32>, Vec<f32>)> {
        let n = self.left.len();
        let want = ((seconds * sample_rate) as usize).min(n - 1);
        if want < (sample_rate * 0.25) as usize {
            return None;
        }
        let mut l = vec![0.0; want];
        let mut r = vec![0.0; want];
        let mut energy = 0.0;
        for i in 0..want {
            let idx = (self.write + n - 1 - i) % n;
            l[i] = self.left[idx];
            r[i] = self.right[idx];
            energy += l[i] * l[i];
        }
        // A silent tail means there is nothing to reverse; the caller falls back to
        // a synthetic spin, exactly as the original did.
        if energy / (want as f32) < 0.00002 {
            return None;
        }
        Some((l, r))
    }
}

/// One engine instance. Owns the voices, buses, master chain and transport.
///
/// Two engines can run side by side against the same output buffer, which is how the
/// desktop build performs a beat-matched auto-mix: it crossfades two of these.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
pub struct Engine {
    sample_rate: f32,
    track: Track,
    transport: Transport,
    master: Master,
    channels: [Channel; 8],
    ducker: Ducker,
    voices: Vec<Option<Voice>>,
    ring: Ring,
    /// The scratch gesture's reader over the frozen ring.
    scratch: scratch::Scratch,
    /// Whether the transport was running when the scratch began, so letting go
    /// resumes it or leaves it stopped.
    scratch_resume: bool,
    /// Gain on the sequenced music, faded out under a scratch and back after it.
    music: f32,
    music_target: f32,
    music_step: f32,
    /// Level per stem for the UI meters, post-fader.
    levels: Vec<f32>,
    /// The latched echo throw from the older `set_echo(bool)` path. Combined with any
    /// Echo Throw gesture; not leased, and not released by Stop or a track load (the
    /// UI holds the latch), only by `release_gestures` and `panic`.
    echo_latch: bool,
    /// Held Echo Throw and Filter Hold overrides, over the base values in `master`.
    gestures: gesture::Gestures,
    /// Whether any stem was soloed on the previous sample, to catch entering solo.
    solo_was: bool,
    /// The all-cut gate, 0..1, and how far it moves per sample. See `render_sample`.
    cut_gate: f32,
    cut_step: f32,
    /// Post-master trim, for crossfading two engines in the worklet.
    output_gain: f32,
    /// The kick sub's pitch for the loaded track, worked out once at load so the
    /// audio path only reads it.
    kick_root_hz: f32,
    /// Riser, crash and downsweep at the song's seams, summed into the master.
    transitions: transition::Transitions,
    /// Per-sample glide coefficient for the channel faders, cuts, solos and sends.
    channel_coef: f32,
    /// The pending scene, the onset serial and the outcome events.
    scheduler: scheduler::Scheduler,
    /// Samples rendered, and what happened on which of them, for the scheduling tests.
    #[cfg(test)]
    clock: u64,
    #[cfg(test)]
    trace: Vec<Trace>,
}

/// One entry in the test-only record of what the engine did on which sample.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq)]
enum Trace {
    /// A scene was committed: request id, sample.
    Apply(u32, u64),
    /// A step's notes were triggered: step, sample.
    Trigger(usize, u64),
    /// A drum voice was spawned: stem index, step, velocity.
    Drum(usize, usize, f32),
}

/// How long a fader, a cut, a solo or a send takes to glide, in seconds. The browser
/// original used `setTargetAtTime` with 12-20 ms; a cut still lands within a beat's
/// sixteenth at any tempo (5 time constants is 60 ms).
const CHANNEL_GLIDE: f32 = 0.012;

/// How long the all-cut gate takes to close or open, in seconds.
const CUT_FADE_SECONDS: f32 = 0.03;

#[cfg_attr(target_arch = "wasm32", wasm_bindgen::prelude::wasm_bindgen)]
impl Engine {
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        let track = Track::silence("empty");
        let mut channels: [Channel; 8] = std::array::from_fn(|_| Channel::default());
        for stem in Stem::ALL {
            let i = stem.index();
            channels[i].send = stem.send();
        }
        Self {
            sample_rate: sr,
            transport: Transport::new(126.0, 0.22, sr),
            master: Master::new(sr),
            channels,
            ducker: Ducker::new(track.kind, 126.0, sr),
            voices: (0..MAX_VOICES).map(|_| None).collect(),
            ring: Ring::new(sr),
            scratch: scratch::Scratch::new(sr),
            scratch_resume: false,
            music: 1.0,
            music_target: 1.0,
            music_step: 1.0 / (scratch::FADE_SECONDS * sr).max(1.0),
            levels: vec![0.0; 8],
            echo_latch: false,
            gestures: gesture::Gestures::new(sr),
            solo_was: false,
            cut_gate: 1.0,
            cut_step: 1.0 / (CUT_FADE_SECONDS * sr).max(1.0),
            output_gain: 1.0,
            kick_root_hz: track.kick_root_hz(),
            transitions: transition::Transitions::new(track.kind, sr),
            channel_coef: dsp::glide_coef(CHANNEL_GLIDE, sr),
            scheduler: scheduler::Scheduler::default(),
            #[cfg(test)]
            clock: 0,
            #[cfg(test)]
            trace: Vec::new(),
            track,
        }
    }

    pub fn play(&mut self) {
        // Play while playing starts over from step 0: a seek, so a pending scene's
        // announced bar no longer means anything.
        self.interrupt(reason::TRANSPORT);
        self.let_go_of_the_platter();
        self.transport.start();
        self.transitions.reset();
    }

    pub fn stop(&mut self) {
        self.interrupt(reason::STOPPED);
        self.release_overrides();
        self.let_go_of_the_platter();
        self.transport.stop();
        for v in self.voices.iter_mut().flatten() {
            v.release();
        }
        self.transitions.release();
        for c in self.channels.iter_mut() {
            c.duck = 1.0;
        }
        // Silence the delay and reverb tails too. Letting a tempo-synced echo ring
        // for another second after Stop reads as a bug rather than a tail, and the
        // next Play would start on top of it.
        self.master.reset();
    }

    pub fn is_playing(&self) -> bool {
        self.transport.playing
    }

    pub fn visual_step(&self) -> i32 {
        if self.transport.playing {
            self.transport.visual_step
        } else {
            -1
        }
    }

    pub fn set_bpm(&mut self, bpm: f32) {
        self.transport.bpm = bpm.clamp(40.0, 200.0);
        self.master
            .set_delay_time(self.transport.bpm, self.transport.rate);
    }

    pub fn set_swing(&mut self, swing: f32) {
        self.transport.swing = swing.clamp(0.0, 1.0);
    }

    /// Set or clear the loop. A pending scene keeps its boundary (the next eligible
    /// onset), but which step that is may have moved, so `queued` is reported again.
    pub fn set_loop(&mut self, bars: u32) {
        self.transport.set_loop(bars);
        self.scheduler.announce(&self.transport);
        self.scheduler.announce_fill(&self.transport);
    }

    /// Cue or seek. Cancels a pending scene and fill and ends an active fill
    /// (`transport`).
    pub fn jump(&mut self, step: usize) {
        self.interrupt(reason::TRANSPORT);
        self.transport.jump(step);
    }

    pub fn nudge(&mut self, dir: i32) {
        self.transport.nudge(dir);
    }

    pub fn brake(&mut self) {
        self.transport.brake();
        if self.transport.braking() {
            self.interrupt(reason::TRANSPORT);
        }
        // A riser on a clock grinding to a halt sounds broken, so the transition
        // sounds get out of the way of the gesture.
        if self.transport.braking() {
            self.transitions.release();
        }
    }

    /// Grab the platter: freeze the recent output for scratching and pause the
    /// transport where it is.
    ///
    /// No steps fire until [`Engine::scratch_end`]; the sequenced voices fade out over
    /// 15 ms and are then dropped, so the output is the scratch reader alone, summed
    /// into the master like the backspin take. The reader starts at "now", standing
    /// still, and can reach back across the ring (just under four seconds once that
    /// much has played).
    ///
    /// Calling this while already scratching is a no-op: the cursor stays where the
    /// hand left it. Calling it during the release fade of a scratch recaptures.
    pub fn scratch_start(&mut self) {
        if self.scratch.held() {
            return;
        }
        self.interrupt(reason::TRANSPORT);
        self.scratch
            .capture(self.ring.left.len(), self.ring.write, self.ring.filled);
        self.scratch_resume = self.transport.playing;
        self.transport.hold();
        self.music_target = 0.0;
    }

    /// Signed platter speed for a scratch: 1 forward at normal speed, -1 backward, 0
    /// held still. Clamped to +/-4; anything not finite reads as 0. The actual speed
    /// glides toward this with about 20 ms of inertia. Ignored when not scratching.
    pub fn scratch_rate(&mut self, rate: f32) {
        if self.scratch.held() {
            self.scratch.set_target(rate);
        }
    }

    /// Let go of the platter and drop the needle at `step` (0..256, the space of
    /// [`Engine::jump`] and `visual_step`).
    ///
    /// The reader fades out over 15 ms while the transport resumes at normal speed,
    /// firing `step` on the next sample if it was playing when the scratch began.
    /// With a loop set, a step outside it is folded into the loop at the same
    /// position in the bar grid. Without a scratch in progress this is a plain jump.
    pub fn scratch_end(&mut self, step: u32) {
        // Dropping the needle is a seek.
        self.interrupt(reason::TRANSPORT);
        let mut at = (step as usize).min(STEPS - 1);
        let t = &self.transport;
        if t.loop_steps > 0 && !(t.loop_start..t.loop_start + t.loop_steps).contains(&at) {
            at = t.loop_start + at % t.loop_steps;
        }
        if !self.scratch.held() {
            self.transport.jump(at);
            return;
        }
        let resume = self.scratch_resume;
        self.let_go_of_the_platter();
        self.transport.jump(at);
        if resume {
            self.transport.to_next = 0.0;
        }
    }

    /// Let go of a scratch, if there is one, and carry on from the step it was
    /// grabbed on. A no-op when not scratching.
    ///
    /// For a mix: the handover is timed from this deck's next downbeat, and a held
    /// transport never reaches one, so the platter has to be released before the
    /// mix measures where that downbeat is.
    pub fn scratch_release(&mut self) {
        self.let_go_of_the_platter();
    }

    /// End a scratch, if there is one, without moving the playhead.
    fn let_go_of_the_platter(&mut self) {
        if self.scratch.held() {
            self.scratch.release();
            self.transport.unhold();
            self.music_target = 1.0;
        }
    }

    /// Capture the last ~1.35 s of output and play it backwards with a rising rate.
    ///
    /// This replaces the original's `ScriptProcessorNode` tap. If nothing worth
    /// reversing has played yet, a synthetic sweep stands in, as the original did.
    pub fn backspin(&mut self) {
        if self.scratch.held() || !self.transport.backspin() {
            return;
        }
        self.interrupt(reason::TRANSPORT);
        self.transitions.release();
        match self.ring.take(1.35, self.sample_rate) {
            Some((l, r)) => {
                // Rates and times straight from the original's automation on the
                // reversed take: 0.62 -> 2.8 by 0.42 s, 2.8 -> 1.15 by 0.66 s, with
                // the gain up in 20 ms, held to 0.48 s, and gone by 0.68 s.
                self.spawn(Voice::Reverse(ReverseVoice::new(
                    l,
                    r,
                    SpinShape {
                        rate_from: 0.62,
                        rate_mid: 2.8,
                        rate_to: 1.15,
                        ramp_up: 0.42,
                        ramp_down: 0.24,
                        peak: 1.0,
                        attack: 0.02,
                        hold_until: 0.48,
                        release: 0.2,
                    },
                    self.sample_rate,
                )));
            }
            None => {
                self.spawn(Voice::Reverse(self.synthetic_spin()));
            }
        }
        self.spawn(self.spin_hiss());
    }

    /// A noise sweep through a rising bandpass, under a short low thump, standing in
    /// when there is no recorded audio to reverse yet.
    ///
    /// Composed here at real time and played at a constant rate. The breakpoints are
    /// the original's, in seconds: the thump runs 92 -> 40 Hz over 0.18 s, and the
    /// noise waits 0.06 s, sweeps 180 -> 4600 Hz by 0.5 s, then falls to 900 Hz by
    /// 0.66 s. They used to be compared against `i / n`, a 0..1 fraction, so `0.06`
    /// meant six percent of the gesture rather than sixty milliseconds — the sweep
    /// spent its first 40 ms racing to 4600 Hz and the remaining 640 ms sliding down.
    /// The thump was missing altogether.
    fn synthetic_spin(&self) -> ReverseVoice {
        let sr = self.sample_rate;
        let dur = 0.68_f32;
        let n = (sr * dur) as usize;
        let mut bp = dsp::Biquad::new();
        let mut thump = dsp::Osc::new(dsp::Wave::Sine, 92.0, sr);
        let mut left = Vec::with_capacity(n);
        let mut right = Vec::with_capacity(n);

        for i in 0..n {
            let t = i as f32 / sr;

            // The low thump: 92 -> 40 Hz, up in 15 ms and gone by 0.2 s.
            thump.set_frequency(dsp::exp_between(92.0, 40.0, (t / 0.18).min(1.0)), sr);
            let thump_env = if t < 0.015 {
                dsp::geom(SPIN_FLOOR, 0.4, t / 0.015)
            } else if t < 0.2 {
                dsp::geom(0.4, SPIN_FLOOR, (t - 0.015) / 0.185)
            } else {
                0.0
            };
            let low = thump.next() * thump_env;

            // The platter noise, which does not start until 0.06 s.
            let noise = if t < 0.06 {
                0.0
            } else {
                let f = if t < 0.5 {
                    dsp::exp_between(180.0, 4600.0, (t - 0.06) / 0.44)
                } else {
                    dsp::exp_between(4600.0, 900.0, ((t - 0.5) / 0.16).min(1.0))
                };
                bp.bandpass(sr, f, 2.2);
                let env = if t < 0.14 {
                    dsp::geom(SPIN_FLOOR, 0.28, (t - 0.06) / 0.08)
                } else {
                    dsp::geom(0.28, SPIN_FLOOR, ((t - 0.14) / 0.52).min(1.0))
                };
                bp.process(dsp::noise()) * env
            };

            let s = low + noise;
            left.push(s);
            right.push(s);
        }
        ReverseVoice::flat(left, right, dur, sr)
    }

    /// High-passed noise swelling across the spin: the platter hiss.
    fn spin_hiss(&self) -> Voice {
        let n = (self.sample_rate * 0.68) as usize;
        let mut hp = dsp::Biquad::new();
        hp.highpass(self.sample_rate, 2400.0, FRAC_1_SQRT_2);
        let mut left = Vec::with_capacity(n);
        let mut right = Vec::with_capacity(n);
        for _ in 0..n {
            let s = hp.process(dsp::noise()) * 0.04;
            left.push(s);
            right.push(s);
        }
        // Flat noise, shaped by the voice: up over 50 ms, then away across the rest of
        // the gesture, which is the original's automation on the hiss gain.
        Voice::Reverse(ReverseVoice::new(
            left,
            right,
            SpinShape {
                rate_from: 1.0,
                rate_mid: 1.0,
                rate_to: 1.0,
                ramp_up: 0.68,
                ramp_down: 0.68,
                peak: 1.0,
                attack: 0.05,
                hold_until: 0.05,
                release: 0.61,
            },
            self.sample_rate,
        ))
    }

    pub fn set_master(&mut self, gain: f32) {
        self.master.set_master(gain);
    }

    /// Post-master output trim.
    ///
    /// Used by the worklet's two-deck host to crossfade between engines during an
    /// auto-mix: both render every block, and only their relative trim changes.
    pub fn set_output_gain(&mut self, gain: f32) {
        self.output_gain = gain.clamp(0.0, 1.0);
    }

    /// Samples until the next downbeat `bars` from now, at least `min_ahead` away.
    ///
    /// The worklet uses this to schedule an auto-mix handover on a musical boundary
    /// without a timer — the same job the original did with
    /// `nextDownbeat()`.
    pub fn samples_to_next_downbeat(&self, bars: u32, min_ahead: f32) -> f64 {
        if !self.transport.playing {
            let beat = 60.0 / self.transport.bpm.max(40.0);
            return (min_ahead + beat * bars.max(1) as f32) as f64 * self.sample_rate as f64;
        }
        let grid = (bars.max(1) as usize) * 16;
        let mut step = self.transport.step;
        let mut acc = self.transport.to_next.max(0.0);
        // `acc` counts samples: `to_next` is decremented once per sample, and each
        // step's duration is converted below. `min_ahead` is seconds, so it has to be
        // converted too — comparing against it raw made the guard "at least 0.32
        // samples ahead", which every candidate passes, so this returned whichever
        // downbeat came next even if it was about to pass. The caller then scheduled a
        // handover with no runway, and the fade began almost immediately instead of on
        // the phrase it had picked.
        let min_samples = (min_ahead.max(0.0) as f64) * self.sample_rate as f64;
        for _ in 0..STEPS + 32 {
            if step.is_multiple_of(grid) && acc >= min_samples {
                return acc;
            }
            acc += self.transport.step_seconds(step) as f64 * self.sample_rate as f64;
            step = if step + 1 >= STEPS { 0 } else { step + 1 };
        }
        min_samples
    }

    /// Filter position, 0 (dark) to 1 (open).
    pub fn set_filter(&mut self, open: f32) {
        self.master.set_filter(open);
    }

    /// The latched echo throw (the older UI toggle). Kept alongside the Echo Throw
    /// gesture: the throw is engaged while this is on or any Echo Throw is held.
    pub fn set_echo(&mut self, on: bool) {
        self.echo_latch = on;
        self.apply_overrides();
    }

    /// Echo time in beats: 0.25 a sixteenth, 0.75 a dotted eighth (the default), 1 a
    /// quarter, and so on; 0 turns the stems' echo off. Kept across track loads and
    /// retimed with the tempo.
    pub fn set_echo_time(&mut self, beats: f32) {
        self.master
            .set_delay_beats(beats, self.transport.bpm, self.transport.rate);
    }

    /// Whether the latched throw is on. Says nothing about held gestures: nothing
    /// here reads an override back as if it were the base.
    pub fn echo_enabled(&self) -> bool {
        self.echo_latch
    }

    /// Three-band isolator, given as 0..1 amounts per band.
    pub fn set_bands(&mut self, low: f32, mid: f32, high: f32) {
        self.master
            .set_eq(band_db(low), band_db(mid), band_db(high));
    }

    /// The old three-way switch, kept for callers that still send it: 0, 1 and 2 map
    /// to balance 0.0, 0.5 and 1.0. Since the balance became a hardware-style balance,
    /// 0 is hard left (right channel silent) and 2 is hard right (left silent), not
    /// mono; mono is `set_width(0.0)`.
    pub fn set_stereo_mode(&mut self, mode: u8) {
        // The three switch positions are the ends and the center of the balance.
        self.master.set_balance(match mode.min(2) {
            0 => 0.0,
            2 => 1.0,
            _ => 0.5,
        });
    }

    /// Hardware-style balance, 0..1: 0.5 (center) leaves both channels at unity,
    /// lower fades the right channel, higher fades the left, and each end silences
    /// the opposite side. The continuous form of [`Engine::set_stereo_mode`].
    pub fn set_stereo_balance(&mut self, balance: f32) {
        self.master.set_balance(balance);
    }

    /// Stereo width: 0 mono, 1 as mixed (the default), up to 1.5 wider.
    pub fn set_width(&mut self, width: f32) {
        self.master.set_width(width);
    }

    /// The filter's resonance as it closes, a Q from 0.5 to 6 (default 0.85).
    pub fn set_filter_q(&mut self, q: f32) {
        self.master.set_filter_q(q);
    }

    /// The echo's feedback, 0 to 0.9 (default 0.3). The echo throw lifts it while held.
    pub fn set_echo_feedback(&mut self, amount: f32) {
        self.master.set_echo_feedback(amount);
    }

    /// How loud the echo returns, 0 to 1 (default 0.24). The throw overrides it while held.
    pub fn set_echo_return(&mut self, amount: f32) {
        self.master.set_echo_return(amount);
    }

    /// How much room is mixed in, 0 to 0.5 (default 0.07).
    pub fn set_reverb_mix(&mut self, amount: f32) {
        self.master.set_reverb_mix(amount);
    }

    /// The room's decay, 0.2 to 2.5 s (default 0.32 s).
    pub fn set_reverb_decay(&mut self, seconds: f32) {
        self.master.set_reverb_decay(seconds);
    }

    /// Queue a scene (`docs/NIGHT3_PROTOCOL.md`). Returns 0 when accepted, otherwise
    /// the reason it was refused, which is also reported as a `rejected` event.
    ///
    /// `values` is the 44-value scene vector; it is validated as a whole first, and a
    /// refused vector changes nothing (a scene already pending stays pending).
    /// `timing` is 0 Now, 1 Next Beat, 2 Next Bar. While stopped the scene applies
    /// here and now and playback does not start; while a scratch, brake or backspin is
    /// in progress it is refused (`transport`).
    pub fn queue_scene(&mut self, request_id: u32, timing: u8, values: &[f32]) -> u8 {
        let verdict = match scheduler::Timing::from_code(timing) {
            None => reason::INVALID,
            Some(_) if !scheduler::valid(values) => reason::INVALID,
            Some(_) if self.transport.in_gesture() => reason::TRANSPORT,
            Some(t) => {
                if self.transport.playing {
                    self.scheduler.queue(request_id, t, values, &self.transport);
                } else {
                    // Nothing can be pending while stopped (Stop cancels it), so this
                    // replaces nothing.
                    let mut copy = [0.0f32; SCENE_LEN];
                    copy.copy_from_slice(&values[..SCENE_LEN]);
                    self.commit_scene(request_id, &copy, -1);
                }
                reason::OK
            }
        };
        if verdict != reason::OK {
            self.scheduler.events.push(
                scheduler::event::SCENE_REJECTED,
                request_id,
                verdict as f64,
                0.0,
            );
        }
        verdict
    }

    /// Set a scene's targets right away, with no scheduling and no events, whatever
    /// the transport is doing. For the worklet's idle deck, which follows the live
    /// deck's scenes so a later handover does not bring back the old mix. Validated
    /// like [`Engine::queue_scene`]; false (and nothing changed) when invalid.
    pub fn set_scene(&mut self, values: &[f32]) -> bool {
        if !scheduler::valid(values) {
            return false;
        }
        let mut copy = [0.0f32; SCENE_LEN];
        copy.copy_from_slice(&values[..SCENE_LEN]);
        self.commit_targets(&copy);
        true
    }

    /// Cancel the pending scene if it is `request_id`, reported as `cancelled` with
    /// reason 10. False when it is not pending: already applied, replaced, cancelled,
    /// or never queued.
    pub fn cancel_scene(&mut self, request_id: u32) -> bool {
        self.scheduler.cancel(request_id)
    }

    /// Cancel whatever scene and fill are pending, and cut short an active fill, for
    /// a structural reason the host knows about and the engine does not (an auto-mix
    /// starting or a promote is 4). False when there was none of those. Held
    /// gestures are not touched; see [`Engine::release_gestures`].
    pub fn cancel_pending(&mut self, why: u8) -> bool {
        self.interrupt(why)
    }

    /// Queue fill `index` of the loaded track for the next bar line
    /// (`docs/NIGHT3_PROTOCOL.md`, Fills). Returns 0 when accepted, otherwise the
    /// reason, also reported as `fill rejected` (15): 1 no such fill, 7 not playing,
    /// 3 a scratch, brake or backspin is running, 8 a fill is already queued or
    /// playing (no stacking, and no replacing: the queued one keeps its bar; the UI
    /// cancels it with [`Engine::cancel_fill`]).
    ///
    /// It starts on the first bar onset after the request (the onset-serial rule
    /// scenes use), plays exactly sixteen steps, and the track's own drums carry on
    /// from the step after.
    pub fn queue_fill(&mut self, request_id: u32, index: u32) -> u8 {
        let verdict = if index as usize >= self.track.fills.len() {
            reason::INVALID
        } else if !self.transport.playing {
            reason::NOT_PLAYING
        } else if self.transport.in_gesture() {
            reason::TRANSPORT
        } else if self.scheduler.fill_busy() {
            reason::ALREADY_PLAYING
        } else {
            self.scheduler
                .queue_fill(request_id, index, &self.transport);
            reason::OK
        };
        if verdict != reason::OK {
            self.scheduler.events.push(
                scheduler::event::FILL_REJECTED,
                request_id,
                verdict as f64,
                0.0,
            );
        }
        verdict
    }

    /// Cancel the queued fill if it is `request_id` (`fill cancelled`, reason 10).
    /// False when it is not queued: never queued, already started (a playing fill
    /// runs its bar), or already cancelled.
    pub fn cancel_fill(&mut self, request_id: u32) -> bool {
        self.scheduler.cancel_fill(request_id)
    }

    /// The request id of the queued fill, if one is waiting for its bar.
    pub fn pending_fill(&self) -> Option<u32> {
        self.scheduler.pending_fill().map(|f| f.request_id)
    }

    /// The request id of the fill playing now, if one is.
    pub fn active_fill(&self) -> Option<u32> {
        self.scheduler.active_fill().map(|f| f.request_id)
    }

    /// Begin a temporary override (`docs/NIGHT3_PROTOCOL.md`, Gestures): kind 1 Echo
    /// Throw, 2 Filter Hold. False (nothing changed) for an unknown kind, a token
    /// already held, or when four are already held. The override expires after 3 s
    /// of rendered audio unless [`Engine::gesture_renew`] is called (event 21).
    pub fn gesture_begin(&mut self, token: u32, kind: u8) -> bool {
        let began = self.gestures.begin(token, kind);
        if began {
            self.apply_overrides();
        }
        began
    }

    /// End `token`'s override only, revealing the next held one of its kind or the
    /// base as it is now. False when the token is not held.
    pub fn gesture_end(&mut self, token: u32) -> bool {
        let ended = self.gestures.end(token);
        if ended {
            self.apply_overrides();
        }
        ended
    }

    /// Restart `token`'s 3 s lease. False when the token is not held.
    pub fn gesture_renew(&mut self, token: u32) -> bool {
        self.gestures.renew(token)
    }

    /// End every override, and the latched echo throw, leaving the working mix as it
    /// is: Release FX. Echo repeats already in the line ring out on the base feedback.
    pub fn release_gestures(&mut self) {
        self.echo_latch = false;
        self.release_overrides();
    }

    /// Panic: cancel the pending scene and fill (`panic`), cut short an active fill,
    /// release every gesture and the latched throw, stop playback and clear the
    /// tails. Not the same as [`Engine::cancel_pending`], which only withdraws what
    /// is queued.
    pub fn panic(&mut self) {
        self.interrupt(reason::PANIC);
        self.release_gestures();
        self.stop();
        self.transitions.reset();
    }

    /// The request id of the pending scene, if one is pending.
    pub fn pending_scene(&self) -> Option<u32> {
        self.scheduler.pending().map(|p| p.request_id)
    }

    /// Events waiting to be drained. Cheap, so the worklet can ask every block and
    /// only pay for [`Engine::take_events_into`] when there is something to take.
    pub fn event_count(&self) -> u32 {
        self.scheduler.events.len() as u32
    }

    /// Events overwritten before they were drained, since the engine was made. The
    /// ring keeps the newest [`scene::EVENT_CAPACITY`]; anything above zero here means
    /// requests arrived faster than the host drained them.
    pub fn dropped_events(&self) -> u32 {
        self.scheduler.events.dropped()
    }

    /// Move waiting events into `out`, four numbers each (`[kind, request id, a, b]`),
    /// oldest first. Returns how many were moved; any that did not fit stay queued.
    pub fn take_events_into(&mut self, out: &mut [f64]) -> u32 {
        self.scheduler.events.drain_into(out)
    }

    /// Render `out_l`/`out_r` in place. This is the audio callback's entry point and
    /// does no allocation on the audio path.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len());
        // A scene queued Now lands on the first sample of the render call after it was
        // accepted, ahead of anything on that sample.
        if let Some(p) = self.scheduler.take_now() {
            self.commit_scene(p.request_id, &p.values, -1);
        }
        for i in 0..n {
            if self.transport.tick_gesture() {
                self.stop();
            }
            let onset = self.transport.tick();
            if let Some(step) = onset {
                // The order on a boundary is fixed (NIGHT3_PROTOCOL.md, Timing):
                // 1. Commit the scene, so this step's notes are already in it.
                if let Some(p) = self.scheduler.on_onset(step) {
                    self.commit_scene(p.request_id, &p.values, step as i32);
                }
                // 2. End a fill that has played its bar, and start one due here, after
                //    the scene and before the notes, so the fill's first step plays.
                self.scheduler.fill_onset(step);
                // 3. Trigger the step's notes.
                if !self.transport.in_backspin() {
                    self.trigger(step);
                }
                // The transition sounds fire only on ordinary playback. A step the
                // spin or the brake raced through breaks the chain of crossings.
                // Under a solo they are counted but stay quiet.
                if self.transport.in_backspin() || self.transport.braking() {
                    self.transitions.forget();
                } else {
                    let quiet = self.any_solo();
                    self.transitions.on_step(step, &self.transport, quiet);
                }
            }
            let (l, r) = self.render_sample();
            out_l[i] = l * self.output_gain;
            out_r[i] = r * self.output_gain;
            // Frozen under a scratch, so the reader's window stays put.
            if !self.scratch.held() {
                self.ring.push(out_l[i], out_r[i]);
            }
            #[cfg(test)]
            {
                self.clock += 1;
            }
        }
        for (i, c) in self.channels.iter_mut().enumerate() {
            c.meter();
            self.levels[i] = c.level;
        }
        // Leases count rendered audio, once per call.
        if self.gestures.tick(n as u32, &mut self.scheduler.events) {
            self.apply_overrides();
        }
    }

    /// Whether any stem is soloed.
    #[inline]
    fn any_solo(&self) -> bool {
        self.channels.iter().any(|c| c.solo)
    }

    /// Cancel the pending scene and fill and cut short an active fill, all with
    /// `why`. True if there was any of those.
    fn interrupt(&mut self, why: u8) -> bool {
        let scene = self.scheduler.cancel_pending(why);
        let fill = self.scheduler.end_fills(why);
        scene || fill
    }

    /// End every held gesture (not the latch) and put the base back.
    fn release_overrides(&mut self) {
        self.gestures.clear();
        self.apply_overrides();
    }

    /// Point the master at the base or at the overrides held over it. The master
    /// keeps the base values itself; this only says which treatment is on.
    #[inline(never)]
    fn apply_overrides(&mut self) {
        let echo = self.echo_latch || self.gestures.holds(gesture::kind::ECHO_THROW);
        if echo != self.master.echo_on() {
            self.master.set_echo(echo);
        }
        self.master
            .set_filter_hold(self.gestures.holds(gesture::kind::FILTER_HOLD));
    }

    /// Advance every voice and bus by one sample.
    fn render_sample(&mut self) -> (f32, f32) {
        for c in self.channels.iter_mut() {
            c.clear();
        }
        // Voices with no stem bypass the channel strips and are held back to be added
        // to the master sum directly, after the faders have been applied below. The
        // transitions are kept apart from them: the silence policy treats the two
        // differently.
        let (mut fx_l, mut fx_r) = self.transitions.process(&self.transport);
        let (mut direct_l, mut direct_r) = (0.0f32, 0.0f32);
        for slot in self.voices.iter_mut() {
            let Some(voice) = slot.as_mut() else { continue };
            let stem = voice.stem();
            let (l, r, done) = voice.process();
            match stem {
                Some(index) => {
                    if let Some(c) = self.channels.get_mut(index) {
                        c.bus.left += l;
                        c.bus.right += r;
                    }
                }
                None => {
                    direct_l += l;
                    direct_r += r;
                }
            }
            if done {
                *slot = None;
            }
        }
        self.ducker.apply(&mut self.channels, self.sample_rate);

        // The music fade under a scratch. Once it is all the way down the voices are
        // dropped rather than left running unheard.
        if self.music != self.music_target {
            self.music = if self.music < self.music_target {
                (self.music + self.music_step).min(self.music_target)
            } else {
                (self.music - self.music_step).max(self.music_target)
            };
            if self.music <= 0.0 {
                self.voices.iter_mut().for_each(|v| *v = None);
                self.transitions.reset();
                for c in self.channels.iter_mut() {
                    c.duck = 1.0;
                }
            }
        }
        direct_l *= self.music;
        direct_r *= self.music;
        fx_l *= self.music;
        fx_r *= self.music;
        if self.scratch.active() {
            let (l, r) = self.scratch.process(&self.ring.left, &self.ring.right);
            direct_l += l;
            direct_r += r;
        }

        // Silence policy (docs/NIGHT3_PROTOCOL.md, Silence, solo and transition sounds):
        //
        // - Entering solo (none to some) ducks and clears the echo and room history,
        //   and fades out any transition sound; while soloed none start.
        // - Every stem cut (muted, faded to 0, or left out by another's solo) closes
        //   the all-cut gate over 30 ms. It scales the stem sum, the transition sounds
        //   and the echo and room returns. One stem cut does nothing here: the tails
        //   decay as they always did.
        // - The gesture voices, the backspin take and the scratch reader (`direct`), are
        //   never gated: they are deliberate sounds made with every stem cut, and
        //   only their echo and room returns follow the gate.
        let any_solo = self.any_solo();
        if any_solo && !self.solo_was {
            self.master.flush_returns();
            self.transitions.silence();
        }
        self.solo_was = any_solo;
        let all_cut = self
            .channels
            .iter()
            .all(|c| !c.audible(any_solo) || c.vol <= 0.0);
        if all_cut {
            self.cut_gate = (self.cut_gate - self.cut_step).max(0.0);
        } else if self.cut_gate < 1.0 {
            self.cut_gate = (self.cut_gate + self.cut_step).min(1.0);
        }
        let gate = self.cut_gate;
        self.master.set_returns_gate(gate);

        let mut sum_l = 0.0f32;
        let mut sum_r = 0.0f32;
        let coef = self.channel_coef;
        for c in self.channels.iter_mut() {
            let g = c.step_gain(any_solo, coef) * self.music;
            c.bus.left *= g;
            c.bus.right *= g;
            // Sends tap post-fader so cutting a stem also cuts its echo. One call per
            // stem: the line advances once per sample, inside `Master::process`.
            if c.send_now > 0.0 {
                self.master.feed_send(c.bus.left, c.bus.right, c.send_now);
            }
            sum_l += c.bus.left;
            sum_r += c.bus.right;
        }
        self.master.process(
            (sum_l + fx_l) * gate + direct_l,
            (sum_r + fx_r) * gate + direct_r,
        )
    }

    /// Set every target a scene holds, in one place, and report `applied` on `step`
    /// (-1 for Now or stopped). Gains, sends and effects glide to the new targets with
    /// their usual smoothing (ADR-013); nothing here jumps the audio. No allocation.
    fn commit_scene(&mut self, request_id: u32, values: &[f32; SCENE_LEN], step: i32) {
        self.commit_targets(values);
        self.scheduler.events.push(
            scheduler::event::SCENE_APPLIED,
            request_id,
            step as f64,
            0.0,
        );
        #[cfg(test)]
        self.trace.push(Trace::Apply(request_id, self.clock));
    }

    /// The scene's targets, set without scheduling or reporting anything.
    fn commit_targets(&mut self, values: &[f32; SCENE_LEN]) {
        for (i, c) in self.channels.iter_mut().enumerate() {
            let v = &values[i * scheduler::STEM_FIELDS..(i + 1) * scheduler::STEM_FIELDS];
            c.vol = v[0].clamp(0.0, 1.0);
            c.send = v[1].clamp(0.0, 1.0);
            c.muted = v[2] == 1.0;
            c.solo = v[3] == 1.0;
        }
        let fx = &values[scheduler::FX_BASE..];
        self.set_filter(fx[0]);
        self.set_filter_q(fx[1]);
        self.set_bands(fx[2], fx[3], fx[4]);
        self.set_echo_time(fx[5]);
        self.set_echo_feedback(fx[6]);
        self.set_echo_return(fx[7]);
        self.set_reverb_mix(fx[8]);
        self.set_reverb_decay(fx[9]);
        self.set_width(fx[10]);
        self.set_stereo_balance(fx[11]);
    }

    /// Schedule every hit on `step` into the voice pool.
    fn trigger(&mut self, step: usize) {
        #[cfg(test)]
        self.trace.push(Trace::Trigger(step, self.clock));
        let at = step % STEPS;
        let kind = self.track.kind;
        // A fill replaces the drum lanes its recipe defines for its bar; every stem's
        // level, cut and solo still apply, since the voices go through the channels.
        let fill = self
            .scheduler
            .active_fill()
            .map(|f| (f.index as usize, f.pos));
        let drums = self.track.drums(at, fill);
        #[cfg(test)]
        for (stem, vel) in [(0, drums.kick), (1, drums.clap), (2, drums.hat)] {
            if vel > 0.0 {
                self.trace.push(Trace::Drum(stem, at, vel));
            }
        }
        if drums.kick > 0.0 {
            let vel = drums.kick;
            self.spawn(Voice::Kick(drums::KickVoice::new(
                vel,
                self.sample_rate,
                kind == TrackKind::Lofi,
                self.kick_root_hz,
            )));
            if self.channels[Stem::Kick.index()].audible(self.any_solo()) {
                self.ducker.trigger(self.transport.bpm, self.sample_rate);
            }
        }
        if drums.clap > 0.0 {
            let vel = drums.clap;
            let freq = match kind {
                TrackKind::Lofi => 780.0,
                TrackKind::Deep => 1250.0,
                _ => 1750.0,
            };
            self.spawn(Voice::Clap(drums::ClapVoice::new(
                vel,
                self.sample_rate,
                freq,
                kind == TrackKind::Lofi,
            )));
        }
        if drums.hat > 0.0 {
            self.spawn(Voice::Hat(drums::HatVoice::new(
                drums.hat,
                self.sample_rate,
                drums.hat_open,
                kind,
            )));
        }
        for perc in drums::PercKind::ALL {
            if let Some(vel) = self.track.perc.hit(perc, at) {
                self.spawn(Voice::Perc(drums::PercVoice::new(
                    perc,
                    vel,
                    self.sample_rate,
                    kind,
                )));
            }
        }
        for stem in Stem::TUNED {
            let Some(ev) = self.track.note(stem, at).cloned() else {
                continue;
            };
            let hold = self.hold_seconds(at, ev.len);
            let freq = crate::dsp::midi_hz(ev.first(60.0));
            let v = tone::voicing(stem, kind, &ev, freq);
            self.spawn(Voice::Tone(tone::ToneVoice::with_stem(
                stem,
                &ev,
                freq,
                hold,
                self.sample_rate,
                v,
            )));
            // House and deep bass get a second saw layer under the sine body, routed
            // to the same stem so it rides the same fader. `bass_sub_layer` checks the
            // stem itself and returns None for the other tuned stems.
            if let Some(sub) = tone::bass_sub_layer(stem, kind, &ev, freq) {
                self.spawn(Voice::Tone(tone::ToneVoice::with_stem(
                    stem,
                    &ev,
                    freq,
                    hold,
                    self.sample_rate,
                    sub,
                )));
            }
        }
    }

    /// Gate length for a note, measured in 16th steps from its own onset.
    fn hold_seconds(&self, step: usize, len: f32) -> f32 {
        let mut total = 0.0f32;
        for i in 0..len.max(1.0) as u32 {
            total += self.transport.step_seconds(step + i as usize);
        }
        total
    }

    /// Allocate a voice, stealing the quietest existing one if the pool is full.
    fn spawn(&mut self, voice: Voice) {
        if let Some(slot) = self.voices.iter_mut().find(|s| s.is_none()) {
            *slot = Some(voice);
            return;
        }
        let mut quietest = 0usize;
        let mut best = f32::INFINITY;
        for (i, slot) in self.voices.iter().enumerate() {
            if let Some(v) = slot {
                // A voice with no channel has no meter to read. Treated as loud, so a
                // deliberate gesture is the last thing stolen under pressure.
                let lvl = match v.stem() {
                    Some(stem) => self.channels[stem].level,
                    None => 1.0,
                };
                if lvl < best {
                    best = lvl;
                    quietest = i;
                }
            }
        }
        self.voices[quietest] = Some(voice);
    }
}

/// Convert a 0..1 isolator amount to decibels, with a floor at -36 dB.
fn band_db(amount: f32) -> f32 {
    if amount <= 0.02 {
        return -36.0;
    }
    (20.0 * amount.log10()).clamp(-36.0, 6.0)
}

/// Rust-only helpers.
///
/// These are on their own block because they cannot cross the wasm ABI — they
/// hand back Rust references or tuples, or take a `#[derive]`d enum. Keeping them
/// out of the exported block means the block above can be annotated wholesale,
/// which removes the duplicated signatures that previously let the JS API drift
/// out of sync with what the worklet actually calls.
impl Engine {
    /// Replace the arrangement. Keeps transport running if it already was, and
    /// re-applies the faders so a loaded track's mix is heard immediately.
    pub fn load_track(&mut self, track: Track) {
        self.interrupt(reason::TRACK);
        self.release_overrides();
        self.track = track;
        self.kick_root_hz = self.track.kick_root_hz();
        for stem in Stem::ALL {
            let i = stem.index();
            self.channels[i].vol = self.track.fader(stem);
            self.channels[i].send = stem.send();
        }
        self.transport.bpm = self.track.bpm;
        self.transport.swing = self.track.swing;
        self.master.set_delay_time(self.transport.bpm, 1.0);
        self.ducker = Ducker::new(self.track.kind, self.transport.bpm, self.sample_rate);
        self.transitions.set_kind(self.track.kind);
        self.ring.clear();
    }
    pub fn track(&self) -> &Track {
        &self.track
    }

    pub fn levels(&self) -> &[f32] {
        &self.levels
    }

    /// Oscilloscope bytes, 128 = centre.
    pub fn scope(&self) -> &[u8] {
        &self.master.scope
    }

    pub fn volumes(&self) -> [f32; 8] {
        let mut out = [0.0; 8];
        for stem in Stem::ALL {
            out[stem.index()] = self.channels[stem.index()].vol;
        }
        out
    }

    pub fn set_muted(&mut self, stem: Stem, muted: bool) {
        if let Some(c) = self.channels.get_mut(stem.index()) {
            c.muted = muted;
        }
    }

    pub fn set_solo(&mut self, stem: Stem, solo: bool) {
        if let Some(c) = self.channels.get_mut(stem.index()) {
            c.solo = solo;
        }
    }

    pub fn set_volume(&mut self, stem: Stem, vol: f32) {
        if let Some(c) = self.channels.get_mut(stem.index()) {
            if vol.is_finite() {
                c.vol = vol.clamp(0.0, 1.0);
            }
        }
    }

    /// A stem's echo send, 0 to 1. Each stem starts at its own amount
    /// ([`Stem::send`]), and loading a track puts it back there.
    pub fn set_send(&mut self, stem: Stem, amount: f32) {
        if let Some(c) = self.channels.get_mut(stem.index()) {
            if amount.is_finite() {
                c.send = amount.clamp(0.0, 1.0);
            }
        }
    }

    /// Every stem's echo send, in stem order.
    pub fn sends(&self) -> [f32; 8] {
        let mut out = [0.0; 8];
        for stem in Stem::ALL {
            out[stem.index()] = self.channels[stem.index()].send;
        }
        out
    }
}

/// Existing Rust API ------------------------------------------------------
#[cfg(not(target_arch = "wasm32"))]
impl Engine {
    /// Load an arrangement from the JSON the Laravel backend emits.
    pub fn load_track_json(&mut self, json: &str) -> Result<(), serde_json::Error> {
        let track: Track = serde_json::from_str(json)?;
        self.load_track(track);
        Ok(())
    }

    /// Seconds until the next downbeat, used to schedule the auto-mix handover.
    pub fn next_downbeat(&self, bars: u32, min_ahead: f32) -> f64 {
        self.samples_to_next_downbeat(bars, min_ahead) / self.sample_rate as f64
    }
}

/// WebAssembly bindings ----------------------------------------------------
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new_wasm(sample_rate: f32) -> Engine {
        Engine::new(sample_rate)
    }

    pub fn load_track_wasm(&mut self, json: &str) -> bool {
        match serde_json::from_str::<Track>(json) {
            Ok(t) => {
                self.load_track(t);
                true
            }
            Err(_) => false,
        }
    }

    pub fn set_muted_index(&mut self, index: usize, muted: bool) {
        if let Some(stem) = stem_from_index(index) {
            self.set_muted(stem, muted);
        }
    }

    pub fn set_solo_index(&mut self, index: usize, solo: bool) {
        if let Some(stem) = stem_from_index(index) {
            self.set_solo(stem, solo);
        }
    }

    pub fn set_volume_index(&mut self, index: usize, vol: f32) {
        if let Some(stem) = stem_from_index(index) {
            self.set_volume(stem, vol);
        }
    }

    pub fn set_send_index(&mut self, index: usize, amount: f32) {
        if let Some(stem) = stem_from_index(index) {
            self.set_send(stem, amount);
        }
    }

    pub fn levels_json(&self) -> String {
        serde_json::to_string(self.levels.as_slice()).unwrap_or_else(|_| "[]".into())
    }

    /// Copy the eight meter levels into a caller-owned buffer.
    ///
    /// Telemetry runs at ~30 Hz, not per block, so this exists to avoid
    /// serialising to JSON on the audio thread.
    pub fn levels_into(&self, out: &mut [f32]) {
        let n = out.len().min(self.levels.len());
        out[..n].copy_from_slice(&self.levels[..n]);
    }

    pub fn set_output_gain_wasm(&mut self, gain: f32) {
        self.set_output_gain(gain);
    }

    pub fn scope_json(&self) -> String {
        serde_json::to_string(self.master.scope.as_slice()).unwrap_or_else(|_| "[]".into())
    }
}

/// Map a mixer index back to its stem, for the integer-indexed WASM bindings.
#[cfg(target_arch = "wasm32")]
fn stem_from_index(index: usize) -> Option<Stem> {
    Stem::ALL.iter().copied().find(|s| s.index() == index)
}

#[cfg(test)]
mod scene_tests;

#[cfg(test)]
mod perform_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn track_with_kick() -> Track {
        let mut t = Track::silence("t");
        t.kick[0] = 1.0;
        t.kick[4] = 1.0;
        t.kick[8] = 1.0;
        t.kick[12] = 1.0;
        t
    }

    /// The handover has to be scheduled the distance ahead it asks for.
    ///
    /// `samples_to_next_downbeat` accumulates samples but compared them to `min_ahead`,
    /// which is seconds, so the lead-time guard was "at least 0.32 samples" and every
    /// candidate passed. Asking for a downbeat at least a second away has to return one
    /// at least a second away.
    #[test]
    fn the_downbeat_respects_its_minimum_lead_in_seconds() {
        let sr = 48_000.0;
        let mut e = Engine::new(sr);
        e.load_track(track_with_kick());
        e.play();
        // Run a little way in, so the playhead is mid-bar rather than on the downbeat.
        for _ in 0..40 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
        }

        for min_ahead in [0.32f32, 1.0, 2.0] {
            let samples = e.samples_to_next_downbeat(1, min_ahead);
            assert!(
                samples >= (min_ahead * sr) as f64,
                "asked for a downbeat at least {min_ahead} s ahead, got {:.3} s",
                samples / sr as f64
            );
        }
    }

    /// The old three-way switch lands on the balance's ends and center: hard left
    /// silences the right, center leaves both, hard right silences the left.
    #[test]
    fn stereo_mode_maps_to_balance_ends_and_center() {
        // Mean |L| and |R| over a second of the same tone on both sides. A sine, not a
        // constant: the master opens with a 28 Hz highpass, which removes a steady
        // level, so a DC input would read as near-silence at every setting.
        let levels = |mode: u8| -> (f32, f32) {
            let sr = 48_000.0;
            let mut e = Engine::new(sr);
            e.set_stereo_mode(mode);
            let mut m = std::mem::replace(&mut e.master, mixer::Master::new(sr));
            // The balance glides; let it arrive before measuring.
            let warm = sr as usize / 4;
            let tone = |i: usize| 0.4 * (i as f32 / sr * 220.0 * std::f32::consts::TAU).sin();
            for i in 0..warm {
                m.process(tone(i), tone(i));
            }
            let (mut sl, mut sr_sum) = (0.0f32, 0.0f32);
            let n = sr as usize;
            for i in warm..warm + n {
                let (l, r) = m.process(tone(i), tone(i));
                sl += l.abs();
                sr_sum += r.abs();
            }
            (sl / n as f32, sr_sum / n as f32)
        };

        let (ll, lr) = levels(0);
        let (cl, cr) = levels(1);
        let (rl, rr) = levels(2);
        assert!(cl > 0.05 && cr > 0.05, "center should play both: {cl} {cr}");
        assert!(lr < 1e-4, "mode 0 should silence the right, got {lr}");
        assert!(rl < 1e-4, "mode 2 should silence the left, got {rl}");
        assert!(
            (ll - cl).abs() < 1e-3,
            "mode 0 left not at full level: {ll} vs {cl}"
        );
        assert!(
            (rr - cr).abs() < 1e-3,
            "mode 2 right not at full level: {rr} vs {cr}"
        );
    }

    /// The backspin has to play the recent past *backwards*.
    ///
    /// `Ring::take` hands back the capture newest-sample-first, so a correct read runs
    /// forward through it. Reading from the far end instead replays the audio in its
    /// original order, which is not a backspin at all.
    #[test]
    fn the_backspin_plays_the_capture_backwards() {
        let sr = 1_000.0;
        let mut ring = Ring::new(sr);
        // A chronological ramp: the oldest sample is small, the newest is large.
        for i in 0..1_000 {
            ring.push(i as f32, i as f32);
        }
        let (l, r) = ring.take(0.5, sr).expect("a take");
        assert!(l[0] > l[l.len() - 1], "take should be newest-first");

        let mut v = ReverseVoice::new(
            l,
            r,
            SpinShape {
                rate_from: 1.0,
                rate_mid: 1.0,
                rate_to: 1.0,
                ramp_up: 1.0,
                ramp_down: 1.0,
                peak: 1.0,
                attack: 0.001,
                hold_until: 1.0,
                release: 0.01,
            },
            sr,
        );
        let mut read = Vec::new();
        for _ in 0..40 {
            read.push(v.sample_at(v.cursor).0);
            v.process();
        }
        // Descending: it starts at "now" and walks back into the past.
        assert!(
            read[0] > read[read.len() - 1],
            "backspin played forwards: {} then {}",
            read[0],
            read[read.len() - 1]
        );
    }

    /// The rate sweep has to be the rate it asks for.
    ///
    /// `exp_between` floors both ends at 20, because it is written for filter
    /// frequencies. Used on a playback rate it turned 0.62 and 2.8 into 20 and 20, so
    /// every backspin ran at twenty times speed.
    #[test]
    fn the_backspin_rate_sweeps_where_it_was_told_to() {
        let sr = 48_000.0;
        let buf = vec![0.0f32; (sr * 2.0) as usize];
        let mut v = ReverseVoice::new(
            buf.clone(),
            buf,
            SpinShape {
                rate_from: 0.62,
                rate_mid: 2.8,
                rate_to: 1.15,
                ramp_up: 0.42,
                ramp_down: 0.24,
                peak: 1.0,
                attack: 0.02,
                hold_until: 0.48,
                release: 0.2,
            },
            sr,
        );
        assert!((v.rate - 0.62).abs() < 0.01, "starts at {}", v.rate);

        let at = |v: &mut ReverseVoice, seconds: f32| {
            let target = (seconds * sr) as usize;
            while (v.t as usize) < target {
                v.process();
            }
            v.rate
        };
        let peak = at(&mut v, 0.42);
        assert!((peak - 2.8).abs() < 0.1, "peak rate {peak}, expected 2.8");
        let settled = at(&mut v, 0.67);
        assert!(
            (settled - 1.15).abs() < 0.1,
            "should ease back to 1.15, got {settled}"
        );
    }

    /// The backspin bypasses the stem strips, so cutting a stem cannot silence it.
    #[test]
    fn the_backspin_is_not_routed_through_a_stem() {
        let sr = 48_000.0;
        let energy = |mute_all: bool| -> f32 {
            let mut e = Engine::new(sr);
            e.load_track(track_with_kick());
            e.play();
            // Give the ring something to capture.
            for _ in 0..(sr as usize) / 128 {
                let mut l = [0.0f32; 128];
                let mut r = [0.0f32; 128];
                e.process(&mut l, &mut r);
            }
            if mute_all {
                for s in Stem::ALL {
                    e.set_muted(s, true);
                }
            }
            e.backspin();
            let mut total = 0.0f32;
            for _ in 0..(sr as usize) / 128 {
                let mut l = [0.0f32; 128];
                let mut r = [0.0f32; 128];
                e.process(&mut l, &mut r);
                for s in &l {
                    total += s.abs();
                }
            }
            total
        };

        let cut = energy(true);
        assert!(
            cut > 1.0,
            "backspin was silenced by cutting the stems: {cut}"
        );
    }

    #[test]
    fn silence_renders_nothing_but_stays_finite() {
        let mut e = Engine::new(48_000.0);
        e.load_track(Track::silence("x"));
        e.play();
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        e.process(&mut l, &mut r);
        assert!(l.iter().all(|v| v.is_finite()));
        assert!(l.iter().all(|v| v.abs() < 1e-6));
    }

    #[test]
    fn a_kick_pattern_produces_signal() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        let mut peak: f32 = 0.0;
        for _ in 0..40 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for v in l.iter() {
                peak = peak.max(v.abs());
            }
        }
        assert!(peak > 0.05, "no audio, peak {peak}");
    }

    fn dense_track() -> Track {
        let mut t = Track::silence("full");
        for s in 0..STEPS {
            t.kick[s] = if s % 4 == 0 { 1.0 } else { 0.0 };
            t.clap[s] = if s % 8 == 4 { 0.9 } else { 0.0 };
            t.hat[s] = if s % 2 == 0 { 0.5 } else { 0.0 };
            t.hat_open[s] = if s % 16 == 14 { 0.6 } else { 0.0 };
            t.bass[s] = Some(NoteEvent::new(vec![45.0], 2.0, 0.9, s % 8 == 0));
            t.stab[s] = if s % 8 == 0 {
                Some(NoteEvent::new(vec![57.0, 60.0, 64.0], 1.0, 0.5, false))
            } else {
                None
            };
            t.lead[s] = if s % 8 == 4 {
                Some(NoteEvent::new(vec![69.0], 4.0, 0.4, false))
            } else {
                None
            };
            t.pad[s] = if s % 32 == 0 {
                Some(NoteEvent::new(vec![52.0, 55.0, 59.0], 16.0, 0.5, false))
            } else {
                None
            };
            t.arp[s] = if s % 2 == 0 {
                Some(NoteEvent::new(vec![81.0], 1.0, 0.3, s % 8 == 0))
            } else {
                None
            };
        }
        t
    }

    #[test]
    fn output_never_nans_under_a_full_mix() {
        let t = dense_track();
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        for _ in 0..200 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            assert!(l.iter().all(|v| v.is_finite()));
            assert!(r.iter().all(|v| v.is_finite()));
            assert!(l.iter().all(|v| v.abs() <= 1.5), "clipping too hard");
        }
    }

    /// Every band boosted, master fully up, a dense mix: the output still never
    /// reaches the -0.3 dBFS ceiling. The EQ and master gain come after the
    /// compressor, so without the limiter this went past full scale.
    #[test]
    fn the_output_never_passes_the_ceiling() {
        let ceiling = 10f32.powf(-0.3 / 20.0);
        for kind in [
            TrackKind::House,
            TrackKind::Deep,
            TrackKind::Acid,
            TrackKind::Lofi,
        ] {
            for echo in [false, true] {
                let mut t = dense_track();
                t.kind = kind;
                let mut e = Engine::new(48_000.0);
                e.load_track(t);
                e.set_bands(1.4, 1.4, 1.4);
                e.set_master(1.0);
                e.set_echo(echo);
                e.play();
                let mut peak = 0.0f32;
                for _ in 0..(6 * 48_000 / 128) {
                    let mut l = [0.0f32; 128];
                    let mut r = [0.0f32; 128];
                    e.process(&mut l, &mut r);
                    for v in l.iter().chain(r.iter()) {
                        peak = peak.max(v.abs());
                    }
                }
                assert!(
                    peak <= ceiling,
                    "{kind:?} echo={echo}: peak {peak} passed the ceiling {ceiling}"
                );
            }
        }
    }

    /// A loaded track's kicks are tuned to its key: an A-minor bass line puts the sub
    /// on A1, 55 Hz.
    #[test]
    fn the_kick_sub_is_tuned_to_the_track_root() {
        let mut t = track_with_kick();
        t.bass[0] = Some(NoteEvent::new(vec![45.0], 2.0, 0.9, false));
        t.bass[8] = Some(NoteEvent::new(vec![52.0], 2.0, 0.9, false));
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        e.process(&mut l, &mut r);
        let sub = e
            .voices
            .iter()
            .flatten()
            .find_map(|v| match v {
                Voice::Kick(k) => Some(k.sub_hz()),
                _ => None,
            })
            .expect("a kick on the downbeat");
        assert!((sub - 55.0).abs() < 1e-3, "sub at {sub} Hz, expected 55");
    }

    #[test]
    fn muting_the_kick_silences_it_immediately() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.set_muted(Stem::Kick, true);
        e.play();
        let mut peak: f32 = 0.0;
        for _ in 0..40 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for v in l.iter() {
                peak = peak.max(v.abs());
            }
        }
        assert!(peak < 1e-5, "muted kick still audible at {peak}");
    }

    #[test]
    fn soloing_one_stem_mutes_the_rest() {
        let mut t = Track::silence("s");
        t.kick[0] = 1.0;
        t.kick[4] = 1.0;
        t.hat[0] = 0.8;
        t.hat[4] = 0.8;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.set_solo(Stem::Hats, true);
        e.play();
        // Hats soloed means the kick bus contributes nothing.
        let kick_gain = e.channels[Stem::Kick.index()].gain(true);
        assert_eq!(kick_gain, 0.0);
        assert!(e.channels[Stem::Hats.index()].gain(true) > 0.0);
    }

    #[test]
    fn band_isolator_attenuates_the_lows() {
        let mut t = Track::silence("eq");
        t.bass[0] = Some(NoteEvent::new(vec![40.0], 8.0, 1.0, false));
        t.bass[16] = Some(NoteEvent::new(vec![40.0], 8.0, 1.0, false));
        let mut open = Engine::new(48_000.0);
        open.load_track(t.clone());
        open.set_bands(1.0, 1.0, 1.0);
        open.play();
        let mut cut = Engine::new(48_000.0);
        cut.load_track(t);
        cut.set_bands(0.0, 1.0, 1.0);
        cut.play();
        let mut a: f32 = 0.0;
        let mut b: f32 = 0.0;
        for _ in 0..100 {
            let mut l1 = [0.0f32; 128];
            let mut r1 = [0.0f32; 128];
            open.process(&mut l1, &mut r1);
            a += l1.iter().map(|v| v * v).sum::<f32>();
            let mut l2 = [0.0f32; 128];
            let mut r2 = [0.0f32; 128];
            cut.process(&mut l2, &mut r2);
            b += l2.iter().map(|v| v * v).sum::<f32>();
        }
        assert!(b < a * 0.6, "low cut too weak: open {a} cut {b}");
    }

    #[test]
    fn voice_pool_is_bounded_under_a_dense_pattern() {
        let mut t = Track::silence("dense");
        for s in 0..STEPS {
            t.bass[s] = Some(NoteEvent::new(vec![45.0], 16.0, 0.8, false));
            t.pad[s] = Some(NoteEvent::new(
                vec![52.0, 55.0, 59.0, 62.0],
                16.0,
                0.5,
                false,
            ));
            t.arp[s] = Some(NoteEvent::new(vec![81.0], 16.0, 0.3, false));
            t.lead[s] = Some(NoteEvent::new(vec![69.0], 16.0, 0.4, false));
            t.stab[s] = Some(NoteEvent::new(vec![57.0, 60.0, 64.0], 16.0, 0.4, false));
        }
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        for _ in 0..300 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            let live = e.voices.iter().filter(|v| v.is_some()).count();
            assert!(live <= MAX_VOICES);
        }
    }

    #[test]
    fn backspin_does_not_spawn_new_voices() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        e.process(&mut l, &mut r);
        e.backspin();
        let before = e.voices.iter().filter(|v| v.is_some()).count();
        for _ in 0..50 {
            e.process(&mut l, &mut r);
        }
        let after = e.voices.iter().filter(|v| v.is_some()).count();
        assert!(
            after <= before + 1,
            "backspin spawned voices {before} -> {after}"
        );
    }

    /// Render `blocks` 128-sample blocks, returning the summed |L| + |R| and
    /// asserting every sample is finite.
    fn run(e: &mut Engine, blocks: usize) -> f32 {
        let mut total = 0.0f32;
        for _ in 0..blocks {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for (a, b) in l.iter().zip(r.iter()) {
                assert!(a.is_finite() && b.is_finite(), "non-finite output");
                total += a.abs() + b.abs();
            }
        }
        total
    }

    fn live_voices(e: &Engine) -> usize {
        e.voices.iter().filter(|v| v.is_some()).count()
    }

    #[test]
    fn a_scratch_pauses_the_transport_and_resumes_at_the_requested_step() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 400);
        e.scratch_start();
        let step = e.transport.step;
        let shown = e.visual_step();
        assert!(shown >= 0);

        // A second of dragging back and forth: the clock does not move.
        for rate in [-1.0, 0.0, 1.0, -2.0, 0.5] {
            e.scratch_rate(rate);
            run(&mut e, 75);
            assert_eq!(e.transport.step, step, "transport advanced under a scratch");
            assert_eq!(e.visual_step(), shown, "playhead moved under a scratch");
            assert!(e.is_playing());
        }

        e.scratch_end(64);
        run(&mut e, 1);
        assert_eq!(e.visual_step(), 64, "should land on the requested step");
        // And it keeps going from there at normal speed.
        run(&mut e, 400);
        assert!(e.visual_step() > 64, "transport did not resume");
        assert_eq!(e.transport.rate, 1.0);
    }

    #[test]
    fn a_scratch_spawns_no_voices_and_drops_the_old_ones() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 400);
        assert!(live_voices(&e) > 0);
        e.scratch_start();
        e.scratch_rate(-1.0);
        // Past the 15 ms fade, the sequenced voices are gone.
        run(&mut e, 8);
        assert_eq!(live_voices(&e), 0, "voices survived the music fade");
        for rate in [-1.0, 1.0, -4.0, 4.0, 0.0] {
            e.scratch_rate(rate);
            run(&mut e, 100);
            assert_eq!(live_voices(&e), 0, "a voice was spawned under a scratch");
        }
        // Gestures that would spawn voices are refused while the platter is held.
        e.backspin();
        run(&mut e, 10);
        assert_eq!(live_voices(&e), 0, "backspin spawned under a scratch");
    }

    #[test]
    fn dragging_back_plays_the_recent_past() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 750);
        e.scratch_start();
        // Held still: the music fades and nothing replaces it.
        run(&mut e, 400);
        let held = run(&mut e, 40);
        e.scratch_rate(-1.0);
        let dragged = run(&mut e, 300);
        assert!(
            dragged > 50.0 * held.max(1e-3),
            "dragging back made no sound: held {held}, dragged {dragged}"
        );
    }

    #[test]
    fn the_edges_hold_at_full_throw() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 2_000);
        e.scratch_start();
        let last = (e.scratch.len() - 1) as f32;
        assert!(
            e.scratch.len() as f32 > 3.9 * 48_000.0,
            "window {}",
            e.scratch.len()
        );
        for rate in [-4.0, 4.0, -4.0, f32::NAN, f32::INFINITY, -1e9] {
            e.scratch_rate(rate);
            for _ in 0..600 {
                run(&mut e, 1);
                let p = e.scratch.pos();
                assert!((0.0..=last).contains(&p), "cursor left the window: {p}");
            }
        }
        e.scratch_end(0);
        run(&mut e, 100);
    }

    #[test]
    fn scratch_calls_without_a_scratch_are_safe() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        // Before anything has played, and stopped.
        e.scratch_rate(-1.0);
        e.scratch_end(64);
        run(&mut e, 10);
        e.scratch_start();
        e.scratch_rate(f32::NAN);
        run(&mut e, 10);
        e.scratch_end(999);
        run(&mut e, 10);
        assert!(!e.is_playing(), "a scratch started the transport");

        // While playing: a bare scratch_end is just a jump.
        e.play();
        run(&mut e, 100);
        e.scratch_rate(3.0);
        e.scratch_end(64);
        assert_eq!(e.transport.step, 64);
        assert!(!e.transport.held);
        run(&mut e, 10);
        assert!(e.is_playing());
    }

    #[test]
    fn a_second_grab_keeps_the_cursor_where_it_was() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 400);
        e.scratch_start();
        e.scratch_rate(-1.0);
        run(&mut e, 100);
        let p = e.scratch.pos();
        e.scratch_start();
        assert_eq!(e.scratch.pos(), p, "a repeat grab recaptured");
    }

    #[test]
    fn letting_go_inside_a_loop_stays_inside_it() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        e.set_loop(1);
        run(&mut e, 100);
        e.scratch_start();
        run(&mut e, 10);
        e.scratch_end(70);
        run(&mut e, 1);
        assert_eq!(e.visual_step(), 6, "70 folds to 6 in a one-bar loop at 0");
    }

    #[test]
    fn stop_during_a_scratch_lets_go() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 400);
        e.scratch_start();
        e.scratch_rate(-1.0);
        run(&mut e, 50);
        e.stop();
        assert!(!e.scratch.held() && !e.transport.held);
        run(&mut e, 20);
        assert!(!e.scratch.active(), "the reader outlived its fade");
    }

    #[test]
    fn releasing_a_scratch_resumes_from_the_step_it_was_grabbed_on() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 400);
        e.scratch_start();
        e.scratch_rate(-1.0);
        run(&mut e, 50);
        let held = e.visual_step();
        let wait_held = e.samples_to_next_downbeat(1, 0.0);
        run(&mut e, 200);
        assert_eq!(e.visual_step(), held, "the step moved under a held platter");

        e.scratch_release();
        assert!(
            !e.scratch.held() && !e.transport.held,
            "release left it held"
        );
        assert!(e.is_playing(), "release stopped the deck");
        // Downbeat timing counts from the held step again, so a mix started now is
        // scheduled against a transport that is actually moving.
        assert_eq!(e.samples_to_next_downbeat(1, 0.0), wait_held);
        run(&mut e, 400);
        assert_ne!(
            e.visual_step(),
            held,
            "playback did not resume after release"
        );
        assert!(!e.scratch.active(), "the reader outlived its fade");
    }

    #[test]
    fn releasing_without_a_scratch_does_nothing() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        run(&mut e, 300);
        let before = e.visual_step();
        e.scratch_release();
        run(&mut e, 1);
        assert!(!e.scratch.held() && e.is_playing());
        assert!(
            e.visual_step() == before || e.visual_step() == before + 1,
            "it jumped"
        );
    }

    #[test]
    fn ring_buffer_captures_playable_audio() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        // Fill past the 0.25 s minimum the backspin tap requires.
        for _ in 0..(48_000 * 2) / 128 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
        }
        assert!(
            e.ring.take(1.35, 48_000.0).is_some(),
            "two seconds of playback should be reversible"
        );
    }

    #[test]
    fn ring_buffer_is_empty_before_anything_plays() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        // Nothing rendered yet, so there is nothing worth reversing — the engine
        // falls back to a synthetic sweep.
        assert!(e.ring.take(1.35, 48_000.0).is_none());
    }

    #[test]
    fn loop_wraps_the_sequence() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.set_loop(1);
        e.play();
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..2000 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            if e.transport.step >= 16 {
                break;
            }
        }
        assert!(e.transport.loop_steps == 16);
        seen.insert(e.transport.step);
        assert!(!seen.is_empty());
    }

    #[test]
    fn track_json_roundtrips() {
        let t = track_with_kick();
        let json = serde_json::to_string(&t).unwrap();
        let back: Track = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, t.id);
        assert_eq!(back.kick[0], 1.0);
        assert_eq!(back.bpm, t.bpm);
    }

    #[test]
    fn loads_track_from_backend_json() {
        let t = track_with_kick();
        let json = serde_json::to_string(&t).unwrap();
        let mut e = Engine::new(48_000.0);
        assert!(e.load_track_json(&json).is_ok());
        assert_eq!(e.track().id, "t");
    }

    #[test]
    fn stop_fades_voices_out_then_falls_silent() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        for _ in 0..10 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
        }
        assert!(e.is_playing());
        e.stop();
        assert!(!e.is_playing());

        // Stopping releases rather than hard-cuts, so the tail should fade out over
        // the release time rather than clicking to zero on a single sample.
        //
        // The window has to outlast the room as well as the voices: the master chain
        // ends in a 0.32 s reverb send, so the mix keeps ringing after the last note
        // has gone — exactly as it does in the engine this replaces, whose `stop()`
        // halts the sources but leaves the convolver running. Twelve blocks is 32 ms
        // and only covers the voices.
        let mut block_peak = Vec::new();
        for _ in 0..200 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            block_peak.push(l.iter().fold(0.0f32, |m, v| m.max(v.abs())));
        }
        assert!(
            block_peak[0] > 0.0 && block_peak[3] < block_peak[0],
            "release should decay: {:?}",
            &block_peak[..4]
        );
        assert!(
            block_peak[199] < 1e-3,
            "tail should be inaudible once the room has died: {}",
            block_peak[199]
        );

        // And it reaches exact silence, staying there.
        for _ in 0..100 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            // -120 dBFS. Anything above this is not "still audible", it is the
            // dynamics stage and the room's filters settling toward their zero state.
            assert!(l.iter().all(|v| v.abs() < 1e-6), "no output after stop");
            assert!(r.iter().all(|v| v.abs() < 1e-6), "no output after stop");
        }
    }

    /// Max RMS over 20 ms windows, and the peak, of `blocks` blocks of output.
    fn loudness(e: &mut Engine, blocks: usize) -> (f32, f32) {
        let win = 8; // 8 x 128 samples, about 21 ms
        let (mut best, mut peak) = (0.0f32, 0.0f32);
        let mut acc = 0.0f32;
        for b in 0..blocks {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for (a, c) in l.iter().zip(r.iter()) {
                assert!(a.is_finite() && c.is_finite());
                acc += 0.5 * (a * a + c * c);
                peak = peak.max(a.abs()).max(c.abs());
            }
            if b % win == win - 1 {
                best = best.max((acc / (win * 128) as f32).sqrt());
                acc = 0.0;
            }
        }
        (best, peak)
    }

    /// Blocks covering `steps` steps at `bpm`.
    fn blocks_for(steps: usize, bpm: f32) -> usize {
        (steps as f32 * 15.0 / bpm * 48_000.0 / 128.0) as usize + 2
    }

    /// A clap on two and four at a modest fader: the reference for how loud the
    /// transition sounds may be.
    fn clap_reference(kind: TrackKind) -> (f32, f32) {
        let mut t = Track::silence("clap");
        t.kind = kind;
        for s in 0..STEPS {
            t.clap[s] = if s % 8 == 4 { 0.85 } else { 0.0 };
        }
        t.mix.0[Stem::Clap.index()] = 0.44;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        loudness(&mut e, blocks_for(64, 126.0))
    }

    /// The transitions alone, from the Break through into the Drop, with every stem
    /// but the (empty) kick cut: they bypass the strips, like the backspin. Not every
    /// stem: with all eight cut the all-cut gate silences them too.
    fn transitions_only(kind: TrackKind) -> (f32, f32) {
        let mut t = Track::silence("fx");
        t.kind = kind;
        t.bpm = 126.0;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        for s in Stem::ALL.into_iter().skip(1) {
            e.set_muted(s, true);
        }
        e.play();
        e.jump(120);
        loudness(&mut e, blocks_for(100, 126.0))
    }

    /// The transitions are noticeable but no louder than a modest clap, with the stems
    /// cut, which they ignore.
    #[test]
    fn transitions_bypass_the_stems_and_sit_under_the_clap() {
        for kind in [
            TrackKind::House,
            TrackKind::Deep,
            TrackKind::Acid,
            TrackKind::Lofi,
        ] {
            let (clap, clap_peak) = clap_reference(kind);
            let (fx, fx_peak) = transitions_only(kind);
            assert!(
                fx <= clap && fx_peak <= clap_peak,
                "{kind:?}: transitions {fx:.4} rms / {fx_peak:.4} peak over the clap's {clap:.4} / {clap_peak:.4}"
            );
            let floor = if kind == TrackKind::Lofi { 0.3 } else { 0.6 };
            assert!(
                fx > clap * floor,
                "{kind:?}: transitions too quiet to notice, {fx:.4} vs clap {clap:.4}"
            );
        }
    }

    /// Run until the transport has fired `step`.
    fn run_to_step(e: &mut Engine, step: i32) {
        for _ in 0..20_000 {
            run(e, 1);
            if e.visual_step() == step {
                return;
            }
        }
        panic!("never reached step {step}");
    }

    #[test]
    fn no_transition_fires_under_a_scratch() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        e.jump(186);
        run_to_step(&mut e, 188);
        e.scratch_start();
        // Held for longer than it would take to reach the Drop.
        run(&mut e, 600);
        assert!(
            !e.transitions.active(),
            "a transition sounded under a scratch"
        );
        // And letting go back at the Drop is a jump, not a crossing.
        e.scratch_end(192);
        run(&mut e, 2);
        assert!(!e.transitions.active(), "the release crashed");
    }

    #[test]
    fn the_brake_and_backspin_silence_the_riser() {
        for gesture in [Engine::brake as fn(&mut Engine), Engine::backspin] {
            let mut e = Engine::new(48_000.0);
            e.load_track(track_with_kick());
            e.play();
            e.jump(158);
            run_to_step(&mut e, 170);
            assert!(e.transitions.active(), "no riser to cut");
            gesture(&mut e);
            run(&mut e, 60);
            assert!(!e.transitions.active(), "riser outlived the gesture");
            // The spin races the clock past the Drop; nothing fires on the way.
            run(&mut e, 400);
            assert!(
                !e.transitions.active(),
                "a transition fired under the gesture"
            );
        }
    }

    #[test]
    fn transitions_are_silent_when_stopped() {
        let mut e = Engine::new(48_000.0);
        e.load_track(track_with_kick());
        e.play();
        e.jump(186);
        run_to_step(&mut e, 193);
        assert!(e.transitions.active(), "no crash");
        e.stop();
        run(&mut e, 400);
        assert!(!e.transitions.active());
    }

    /// A track whose only content is percussion, on every instrument.
    fn percussion_only() -> Track {
        let mut t = Track::silence("perc");
        let lane = |every: usize, at: usize| -> Vec<f32> {
            (0..STEPS)
                .map(|s| if s % every == at { 0.8 } else { 0.0 })
                .collect()
        };
        t.perc.shaker = lane(2, 1);
        t.perc.rim = lane(8, 3);
        t.perc.conga_hi = lane(8, 6);
        t.perc.conga_lo = lane(16, 10);
        t
    }

    #[test]
    fn percussion_plays_on_the_hats_stem() {
        let energy = |setup: fn(&mut Engine)| -> f32 {
            let mut e = Engine::new(48_000.0);
            e.load_track(percussion_only());
            setup(&mut e);
            e.play();
            run(&mut e, 400)
        };
        let open = energy(|_| {});
        assert!(open > 1.0, "percussion made no sound: {open}");
        let cut = energy(|e| e.set_muted(Stem::Hats, true));
        assert_eq!(cut, 0.0, "cutting the hats left the percussion playing");
        let faded = energy(|e| e.set_volume(Stem::Hats, 0.0));
        assert_eq!(faded, 0.0, "the hats fader does not reach the percussion");
        let other_solo = energy(|e| e.set_solo(Stem::Clap, true));
        assert_eq!(other_solo, 0.0, "soloing another stem left the percussion");
        let solo = energy(|e| e.set_solo(Stem::Hats, true));
        assert!(solo > 1.0, "soloing the hats silenced the percussion");
        // And it shows on the hats meter.
        let mut e = Engine::new(48_000.0);
        e.load_track(percussion_only());
        e.play();
        let mut seen = 0.0f32;
        for _ in 0..200 {
            run(&mut e, 1);
            seen = seen.max(e.levels()[Stem::Hats.index()]);
        }
        assert!(seen > 0.0, "the hats meter did not move");
    }

    #[test]
    fn a_percussion_pattern_keeps_the_voice_pool_bounded() {
        let mut t = percussion_only();
        t.perc.shaker = vec![1.0; STEPS];
        t.perc.rim = vec![1.0; STEPS];
        t.perc.conga_hi = vec![1.0; STEPS];
        t.perc.conga_lo = vec![1.0; STEPS];
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        for _ in 0..300 {
            run(&mut e, 1);
            assert!(live_voices(&e) <= MAX_VOICES);
        }
    }
}
