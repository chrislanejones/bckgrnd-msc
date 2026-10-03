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
mod tone;
mod track;
mod transport;

use core::f32::consts::FRAC_1_SQRT_2;
use drums::DrumVoice as _;

pub use mixer::{Bus, Channel, Ducker, Master};
pub use track::{NoteEvent, Stem, Track, TrackKind, STEPS};
pub use transport::Transport;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// A voice currently sounding, in one of two families.
enum Voice {
    Kick(drums::KickVoice),
    Clap(drums::ClapVoice),
    Hat(drums::HatVoice),
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
            Voice::Tone(v) => v.release_now(),
            Voice::Reverse(v) => v.release_now(),
        }
    }

    #[inline]
    fn stem(&self) -> usize {
        match self {
            Voice::Kick(_) => Stem::Kick.index(),
            Voice::Clap(_) => Stem::Clap.index(),
            Voice::Hat(_) => Stem::Hats.index(),
            Voice::Tone(v) => v.stem_index(),
            // The reverse take is full-mix audio, so it bypasses the stem faders and
            // is routed to the master like the original's direct-to-master spin.
            Voice::Reverse(_) => Stem::Arp.index(),
        }
    }
}

/// Plays a captured buffer backwards with a rising playback rate, the backspin
/// gesture. Replaces the original's `ScriptProcessorNode` tap and reverse playback.
struct ReverseVoice {
    left: Vec<f32>,
    right: Vec<f32>,
    env: dsp::Adsr,
    /// Read position, in samples, advancing backwards.
    cursor: f32,
    /// Playback rate, swept upward over the gesture.
    rate: f32,
    rate_from: f32,
    rate_to: f32,
    sweep_samples: f32,
    t: f32,
    done: bool,
}

impl ReverseVoice {
    fn new(
        left: Vec<f32>,
        right: Vec<f32>,
        rate_from: f32,
        rate_to: f32,
        dur: f32,
        sr: f32,
    ) -> Self {
        let n = left.len();
        Self {
            cursor: (n - 1) as f32,
            env: dsp::Adsr::new(0.92, 0.02, dur * 0.5, 1.0, dur * 0.5, 0.08, sr),
            rate: rate_from,
            rate_from,
            rate_to,
            sweep_samples: (0.42 * sr).max(1.0),
            t: 0.0,
            left,
            right,
            done: false,
        }
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
        // Sweep the playback rate up over the first 420 ms, which is the rising
        // "wind back" sound.
        self.t += 1.0;
        if self.t < self.sweep_samples {
            let p = self.t / self.sweep_samples;
            self.rate = dsp::exp_between(self.rate_from, self.rate_to, p);
        }
        let (l, r) = self.sample_at(self.cursor);
        let g = self.env.process();
        self.cursor -= self.rate;
        if self.cursor <= 0.0 || self.env.is_done() {
            self.done = true;
        }
        (l * g, r * g, self.done)
    }

    fn release_now(&mut self) {
        self.env.release_now();
    }
}

/// Upper bound on simultaneously sounding voices. A four-on-the-floor pattern with
/// an eight-note pad and a lead line peaks well under this; the cap exists so a
/// dense arrangement degrades by stealing the quietest voice rather than allocating.
const MAX_VOICES: usize = 48;

/// Ring buffer holding the last two seconds of output for the backspin gesture,
/// replacing the original's `ScriptProcessorNode` tap.
struct Ring {
    left: Vec<f32>,
    right: Vec<f32>,
    write: usize,
}

impl Ring {
    fn new(sample_rate: f32) -> Self {
        let n = (sample_rate * 2.0) as usize;
        Self {
            left: vec![0.0; n],
            right: vec![0.0; n],
            write: 0,
        }
    }

    #[inline]
    fn push(&mut self, l: f32, r: f32) {
        self.left[self.write] = l;
        self.right[self.write] = r;
        self.write = (self.write + 1) % self.left.len();
    }

    fn clear(&mut self) {
        self.left.iter_mut().for_each(|v| *v = 0.0);
        self.right.iter_mut().for_each(|v| *v = 0.0);
        self.write = 0;
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
    /// Level per stem for the UI meters, post-fader.
    levels: Vec<f32>,
    echo_on: bool,
    /// Post-master trim, for crossfading two engines in the worklet.
    output_gain: f32,
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
            levels: vec![0.0; 8],
            echo_on: false,
            output_gain: 1.0,
            track,
        }
    }

    pub fn play(&mut self) {
        self.transport.start();
    }

    pub fn stop(&mut self) {
        self.transport.stop();
        for v in self.voices.iter_mut().flatten() {
            v.release();
        }
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
    }

    /// Capture the last ~1.35 s of output and play it backwards with a rising rate.
    ///
    /// This replaces the original's `ScriptProcessorNode` tap. If nothing worth
    /// reversing has played yet, a synthetic sweep stands in, as the original did.
    pub fn backspin(&mut self) {
        if !self.transport.backspin() {
            return;
        }
        match self.ring.take(1.35, self.sample_rate) {
            Some((l, r)) => {
                self.spawn(Voice::Reverse(ReverseVoice::new(
                    l,
                    r,
                    0.62,
                    2.8,
                    0.68,
                    self.sample_rate,
                )));
            }
            None => {
                self.spawn(Voice::Reverse(self.synthetic_spin()));
            }
        }
        self.spawn(self.spin_hiss());
    }

    /// A noise sweep through a rising bandpass, standing in when there is no
    /// recorded audio to reverse yet.
    fn synthetic_spin(&self) -> ReverseVoice {
        let n = (self.sample_rate * 0.68) as usize;
        let mut bp = dsp::Biquad::new();
        let mut left = Vec::with_capacity(n);
        let mut right = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / n as f32;
            let f = if t < 0.06 {
                dsp::exp_between(180.0, 4600.0, t / 0.06)
            } else {
                dsp::exp_between(4600.0, 900.0, ((t - 0.06) / 0.94).min(1.0))
            };
            bp.bandpass(self.sample_rate, f, 2.2);
            let s = bp.process(dsp::noise()) * 0.28;
            left.push(s);
            right.push(s);
        }
        ReverseVoice::new(left, right, 1.0, 1.0, 0.68, self.sample_rate)
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
        Voice::Reverse(ReverseVoice::new(
            left,
            right,
            1.0,
            1.0,
            0.68,
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
        for _ in 0..STEPS + 32 {
            if step.is_multiple_of(grid) && acc >= min_ahead as f64 {
                return acc;
            }
            acc += self.transport.step_seconds(step) as f64 * self.sample_rate as f64;
            step = if step + 1 >= STEPS { 0 } else { step + 1 };
        }
        min_ahead as f64
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
        self.master.mode = mode.min(2);
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
            }
            let (l, r) = self.render_sample();
            out_l[i] = l * self.output_gain;
            out_r[i] = r * self.output_gain;
            self.ring.push(out_l[i], out_r[i]);
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
        for slot in self.voices.iter_mut() {
            let Some(voice) = slot.as_mut() else { continue };
            let stem = voice.stem();
            let (l, r, done) = voice.process();
            if let Some(c) = self.channels.get_mut(stem) {
                c.bus.left += l;
                c.bus.right += r;
            }
            if done {
                *slot = None;
            }
        }
        self.ducker.apply(&mut self.channels, self.sample_rate);

        let any_solo = Stem::ALL.iter().any(|s| self.channels[s.index()].solo);
        let mut sum_l = 0.0f32;
        let mut sum_r = 0.0f32;
        for c in self.channels.iter_mut() {
            let g = c.gain(any_solo);
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
        self.master.process(sum_l, sum_r)
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
                let stem = v.stem();
                let lvl = self.channels[stem].level;
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
        for stem in Stem::ALL {
            let i = stem.index();
            self.channels[i].vol = self.track.fader(stem);
            self.channels[i].send = stem.send();
        }
        self.transport.bpm = self.track.bpm;
        self.transport.swing = self.track.swing;
        self.master.set_delay_time(self.transport.bpm, 1.0);
        self.ducker = Ducker::new(self.track.kind, self.transport.bpm, self.sample_rate);
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

    #[test]
    fn output_never_nans_under_a_full_mix() {
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
}
