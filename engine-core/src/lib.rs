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
mod mixer;
mod scratch;
mod texture;
mod tone;
mod track;
mod transition;
mod transport;

use core::f32::consts::FRAC_1_SQRT_2;
use drums::DrumVoice as _;

pub use drums::PercKind;
pub use mixer::{Bus, Channel, Ducker, Master};
pub use track::{NoteEvent, Perc, Stem, Track, TrackKind, STEPS};
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
    echo_on: bool,
    /// Post-master trim, for crossfading two engines in the worklet.
    output_gain: f32,
    /// The kick sub's pitch for the loaded track, worked out once at load so the
    /// audio path only reads it.
    kick_root_hz: f32,
    /// Riser, crash and downsweep at the song's seams, summed into the master.
    transitions: transition::Transitions,
    /// Vinyl crackle and tape hiss under lo-fi tracks, summed into the master.
    texture: texture::Texture,
}

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
            echo_on: false,
            output_gain: 1.0,
            kick_root_hz: track.kick_root_hz(),
            transitions: transition::Transitions::new(track.kind, sr),
            texture: texture::Texture::new(sr),
            track,
        }
    }

    pub fn play(&mut self) {
        self.let_go_of_the_platter();
        self.transport.start();
        self.transitions.reset();
        self.texture.set_running(true);
    }

    pub fn stop(&mut self) {
        self.let_go_of_the_platter();
        self.transport.stop();
        for v in self.voices.iter_mut().flatten() {
            v.release();
        }
        self.transitions.release();
        self.texture.set_running(false);
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

    pub fn set_loop(&mut self, bars: u32) {
        self.transport.set_loop(bars);
    }

    pub fn jump(&mut self, step: usize) {
        self.transport.jump(step);
    }

    pub fn nudge(&mut self, dir: i32) {
        self.transport.nudge(dir);
    }

    pub fn brake(&mut self) {
        self.transport.brake();
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

    pub fn set_echo(&mut self, on: bool) {
        self.echo_on = on;
        self.master.set_echo(on);
    }

    pub fn echo_enabled(&self) -> bool {
        self.echo_on
    }

    /// Three-band isolator, given as 0..1 amounts per band.
    pub fn set_bands(&mut self, low: f32, mid: f32, high: f32) {
        self.master
            .set_eq(band_db(low), band_db(mid), band_db(high));
    }

    pub fn set_stereo_mode(&mut self, mode: u8) {
        // The three switch positions are the ends and the centre of the balance.
        self.master.balance = match mode.min(2) {
            0 => 0.0,
            2 => 1.0,
            _ => 0.5,
        };
    }

    /// Where the output sits between the channels: 0 mono-left, 0.5 stereo, 1
    /// mono-right. The continuous form of [`Engine::set_stereo_mode`].
    pub fn set_stereo_balance(&mut self, balance: f32) {
        self.master.balance = balance.clamp(0.0, 1.0);
    }

    /// Render `out_l`/`out_r` in place. This is the audio callback's entry point and
    /// does no allocation on the audio path.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len());
        for i in 0..n {
            if self.transport.tick_gesture() {
                self.stop();
            }
            let onset = self.transport.tick();
            if let Some(step) = onset {
                if !self.transport.in_backspin() {
                    self.trigger(step);
                }
                // The transition sounds fire only on ordinary playback. A step the
                // spin or the brake raced through breaks the chain of crossings.
                if self.transport.in_backspin() || self.transport.braking() {
                    self.transitions.forget();
                } else {
                    self.transitions.on_step(step, &self.transport);
                }
            }
            let (l, r) = self.render_sample();
            out_l[i] = l * self.output_gain;
            out_r[i] = r * self.output_gain;
            // Frozen under a scratch, so the reader's window stays put.
            if !self.scratch.held() {
                self.ring.push(out_l[i], out_r[i]);
            }
        }
        for (i, c) in self.channels.iter_mut().enumerate() {
            c.meter();
            self.levels[i] = c.level;
        }
    }

    /// Advance every voice and bus by one sample.
    fn render_sample(&mut self) -> (f32, f32) {
        for c in self.channels.iter_mut() {
            c.clear();
        }
        // Voices with no stem bypass the channel strips and are held back to be added
        // to the master sum directly, after the faders have been applied below.
        let (mut direct_l, mut direct_r) = self.transitions.process(&self.transport);
        // The record's surface: not a stem, so no cut or solo touches it, but it goes
        // quiet with the music under a scratch like everything else on the record.
        let (tex_l, tex_r) = self.texture.process();
        direct_l += tex_l;
        direct_r += tex_r;
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
        if self.scratch.active() {
            let (l, r) = self.scratch.process(&self.ring.left, &self.ring.right);
            direct_l += l;
            direct_r += r;
        }

        let any_solo = Stem::ALL.iter().any(|s| self.channels[s.index()].solo);
        let mut sum_l = 0.0f32;
        let mut sum_r = 0.0f32;
        for c in self.channels.iter_mut() {
            let g = c.gain(any_solo) * self.music;
            c.bus.left *= g;
            c.bus.right *= g;
            // Sends tap post-fader so cutting a stem also cuts its echo. One call per
            // stem: the line advances once per sample, inside `Master::process`.
            if c.send > 0.0 {
                self.master.feed_send(c.bus.left, c.bus.right, c.send);
            }
            sum_l += c.bus.left;
            sum_r += c.bus.right;
        }
        self.master.process(sum_l + direct_l, sum_r + direct_r)
    }

    /// Schedule every hit on `step` into the voice pool.
    fn trigger(&mut self, step: usize) {
        let at = step % STEPS;
        let kind = self.track.kind;
        if let Some(vel) = self.track.hit(Stem::Kick, at) {
            self.spawn(Voice::Kick(drums::KickVoice::new(
                vel,
                self.sample_rate,
                kind == TrackKind::Lofi,
                self.kick_root_hz,
            )));
            if self.channels[Stem::Kick.index()]
                .audible(Stem::ALL.iter().any(|s| self.channels[s.index()].solo))
            {
                self.ducker.trigger(self.transport.bpm, self.sample_rate);
            }
        }
        if let Some(vel) = self.track.hit(Stem::Clap, at) {
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
        if let Some(vel) = self.track.hit(Stem::Hats, at) {
            let open = self.track.hat_open.get(at).copied().unwrap_or(0.0) > 0.0;
            self.spawn(Voice::Hat(drums::HatVoice::new(
                vel,
                self.sample_rate,
                open,
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
        self.texture.set_enabled(self.track.kind == TrackKind::Lofi);
        self.texture.set_running(self.transport.playing);
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
            c.vol = vol.clamp(0.0, 1.0);
        }
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

    /// The balance fader's ends and centre are the old three-way switch.
    #[test]
    fn balance_endpoints_match_the_old_stereo_modes() {
        // Mean |L - R| over a second of an out-of-phase tone. A sine, not a constant:
        // the master opens with a 28 Hz highpass, which removes a steady level, so a
        // DC input would read as near-silence at every setting.
        let spread = |balance: f32| -> f32 {
            let sr = 48_000.0;
            let mut m = mixer::Master::new(sr);
            m.balance = balance;
            let mut total = 0.0f32;
            let n = sr as usize;
            for i in 0..n {
                let v = 0.4 * (i as f32 / sr * 220.0 * std::f32::consts::TAU).sin();
                let (l, r) = m.process(v, -v);
                total += (l - r).abs();
            }
            total / n as f32
        };

        let (left, quarter, centre, right) = (spread(0.0), spread(0.25), spread(0.5), spread(1.0));
        assert!(left < 1e-4, "left end should be mono, spread {left}");
        assert!(right < 1e-4, "right end should be mono, spread {right}");
        assert!(
            centre > 0.05,
            "centre should leave the channels apart, spread {centre}"
        );
        // And it opens smoothly rather than switching.
        assert!(
            left < quarter && quarter < centre,
            "not monotonic: {left} {quarter} {centre}"
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
    /// cut: they bypass the strips, like the backspin.
    fn transitions_only(kind: TrackKind) -> (f32, f32) {
        let mut t = Track::silence("fx");
        t.kind = kind;
        t.bpm = 126.0;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        for s in Stem::ALL {
            e.set_muted(s, true);
        }
        e.play();
        e.jump(120);
        loudness(&mut e, blocks_for(100, 126.0))
    }

    /// The transitions are noticeable but no louder than a modest clap, with every
    /// stem cut, which they ignore.
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

    /// Output of a silent lo-fi track with every stem cut: the medium alone.
    /// Returns RMS in dBFS over the window and the peak.
    fn texture_only(kind: TrackKind, seconds: f32, crackle: bool) -> (f32, f32) {
        let mut t = Track::silence("medium");
        t.kind = kind;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.texture.crackle = crackle;
        for s in Stem::ALL {
            e.set_muted(s, true);
        }
        e.play();
        // Past the fade-in.
        run(&mut e, 100);
        let (mut ss, mut peak, mut n) = (0.0f64, 0.0f32, 0usize);
        for _ in 0..(seconds * 48_000.0 / 128.0) as usize {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for (a, b) in l.iter().zip(r.iter()) {
                assert!(a.is_finite() && b.is_finite());
                ss += 0.5 * (a * a + b * b) as f64;
                peak = peak.max(a.abs()).max(b.abs());
                n += 1;
            }
        }
        ((10.0 * (ss / n.max(1) as f64).log10()) as f32, peak)
    }

    #[test]
    fn the_lofi_medium_is_quiet_bounded_and_ignores_the_stems() {
        // Every stem cut, and the hiss and crackle are still there: they are the
        // record, not a part on it.
        let (hiss, hiss_peak) = texture_only(TrackKind::Lofi, 6.0, false);
        assert!(
            (-45.0..=-40.0).contains(&hiss),
            "hiss at {hiss:.2} dBFS, want -45..-40"
        );
        assert!(hiss_peak < 0.05, "hiss peak {hiss_peak}");
        let (all, peak) = texture_only(TrackKind::Lofi, 12.0, true);
        assert!(all > -46.0 && all < -38.0, "texture at {all:.2} dBFS");
        // Crackle peaks stay far under a lo-fi mix, which peaks around 0.45.
        assert!(peak < 0.1, "crackle peak {peak}");
    }

    #[test]
    fn the_medium_is_silent_on_other_kinds() {
        for kind in [TrackKind::House, TrackKind::Deep, TrackKind::Acid] {
            let (_, peak) = texture_only(kind, 3.0, true);
            assert_eq!(peak, 0.0, "{kind:?}: texture on a non-lo-fi track");
        }
    }

    #[test]
    fn the_medium_fades_out_with_stop() {
        let mut t = Track::silence("medium");
        t.kind = TrackKind::Lofi;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        assert!(run(&mut e, 200) > 0.0);
        e.stop();
        // The 0.25 s fade, then the room and filters settle: the reverb and the
        // filters ring for a while after the last of the noise.
        run(&mut e, 600);
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        for _ in 0..100 {
            e.process(&mut l, &mut r);
            assert!(l.iter().chain(r.iter()).all(|v| v.abs() < 1e-6));
        }
        assert!(!e.texture.audible());
    }

    #[test]
    fn loading_a_club_track_silences_the_medium() {
        let mut t = Track::silence("medium");
        t.kind = TrackKind::Lofi;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        run(&mut e, 50);
        assert!(e.texture.audible());
        e.load_track(Track::silence("club"));
        assert!(!e.texture.audible());
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
