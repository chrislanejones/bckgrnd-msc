//! Timed builds: a scene that rises over 2, 4 or 8 bars instead of landing on one
//! boundary (`docs/NIGHT7_PROTOCOL.md`).
//!
//! A build is one request with up to two vectors: the **target** the mix moves toward
//! across the bars, and an optional **landing** scene committed on the boundary where
//! the build ends. In short:
//!
//! - It starts on the first bar onset after the request (the onset-serial rule scenes
//!   use) and ends exactly `bars * 16` onsets later, on a bar line. Tempo changes move
//!   neither end, and a looping bar cannot end it twice.
//! - From the start onset it owns the base: on every onset each slot it drives moves to
//!   [`value_at`] for the progress so far, and the existing smoothing (ADR-013) glides
//!   between onsets. Gestures stay overrides on top of that moving base.
//! - On the end onset it writes the target exactly, then commits the landing scene as a
//!   whole, then swaps in the pattern lanes linked to it, before that step's notes:
//!   the scene transaction, sample-accurate. The lanes come and go with the build the
//!   way a scene's linked lanes do with the scene.
//! - Cancelled (by the user, or by stop, seek, scratch, brake, backspin, a track change,
//!   panic or the host), it puts back the base it started from. Nothing is left
//!   half-built. Replaced (by a scene that commits, or by a newer build), it is not
//!   restored: the replacement is complete.
//! - A knob, fader, mute or solo moved while it runs takes that one slot out of the
//!   build: the user's value stands, and a cancel does not restore it.
//!
//! Nothing here allocates. The build is a fixed-size value in an `Option`, and the
//! per-onset work is 44 multiply-adds and the writes for the slots that moved. Its
//! lanes are parsed in the message handler, swapped in by pointer, and if withdrawn
//! on the audio path, parked until the next message rather than freed.

use crate::scheduler::{
    self, event, reason, slot_kind, walk, Link, SlotKind, FX_BASE, SCENE_LEN, STEM_FIELDS,
};
use crate::{band_db, Engine};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// The lengths a build may run for, in bars.
pub const BUILD_BARS: [u32; 3] = [2, 4, 8];

/// Onsets per bar.
const BAR: u32 = 16;

/// `b` of a `build rejected` event: which part of the request was refused, when the
/// reason is `invalid` (1). 0 for every other reason.
pub mod detail {
    pub const NONE: u8 = 0;
    pub const BARS: u8 = 1;
    pub const TARGET: u8 = 2;
    pub const LAND: u8 = 3;
    /// The lanes the build sets. The worklet reports this one: it stages the lanes,
    /// and the engine refuses a bad payload as `patterns rejected` before the build is
    /// asked for.
    pub const LANES: u8 = 4;
    /// The fill it finishes with (Rise + Fill, `docs/NIGHT8_PROTOCOL.md`): no such fill
    /// (reason 1), or the fill slot already taken (reason 8).
    pub const FILL: u8 = 5;
}

/// The fx slots, as engine indices into [`Engine::fx_base`].
const FX_LEN: usize = SCENE_LEN - FX_BASE;

/// What the fx half of the base holds before anything sets it: the master chain's own
/// starting values, in `SCENE_PARAMS` order.
pub(crate) const FX_DEFAULTS: [f32; FX_LEN] = [
    1.0,
    crate::mixer::FILTER_Q,
    1.0,
    1.0,
    1.0,
    crate::mixer::DELAY_BEATS_DEFAULT,
    crate::mixer::ECHO_FEEDBACK,
    crate::mixer::ECHO_RETURN,
    crate::mixer::VERB_WET,
    crate::dsp::ROOM_RT60,
    1.0,
    0.5,
];

/// The bit for scene slot `i` in a slot mask.
#[inline]
pub(crate) const fn bit(i: usize) -> u64 {
    1u64 << i
}

/// One stem's bits: volume, send, muted, solo.
const fn stem_bits(stem: usize, field: usize) -> u64 {
    bit(stem * STEM_FIELDS + field)
}

/// Where slot `i` stands at progress `p` (0 on the start onset, 1 on the end onset),
/// moving from `from` toward `to`.
///
/// - Continuous slots move in a straight line **in their control's own space**: the
///   filter position is already exponential in hertz (`Master::filter_freq`), the
///   isolators are amounts that become decibels through `band_db`, and the faders are
///   the faders. So every knob turns at a steady rate, and the cutoff rises evenly in
///   octaves.
/// - A stem that is muted at the start and playing in the target is unmuted on the
///   start onset with its fader at 0, and fades in across the build. A stem that the
///   target mutes fades out across the build and is muted on the end onset. Either
///   way the stem's audible level moves steadily, and the switch happens where it is
///   silent.
/// - Solo and the echo time switch on the end onset: a solo changes which stems are
///   heard at all, and an echo time between two of the registry's options is not one.
/// - At `p >= 1` every slot is exactly the target.
pub fn value_at(i: usize, from: &[f32; SCENE_LEN], to: &[f32; SCENE_LEN], p: f32) -> f32 {
    if p >= 1.0 {
        return to[i];
    }
    let p = p.max(0.0);
    let lerp = |a: f32, b: f32| a + (b - a) * p;
    if i < FX_BASE {
        let stem = i - i % STEM_FIELDS;
        let was_muted = from[stem + 2] == 1.0;
        let will_mute = to[stem + 2] == 1.0;
        return match i % STEM_FIELDS {
            0 => match (was_muted, will_mute) {
                (true, false) => lerp(0.0, to[i]),
                (false, true) => lerp(from[i], 0.0),
                _ => lerp(from[i], to[i]),
            },
            1 => lerp(from[i], to[i]),
            2 if was_muted && !will_mute => 0.0,
            _ => from[i],
        };
    }
    match slot_kind(i) {
        Some(SlotKind::Range { .. }) => lerp(from[i], to[i]),
        _ => from[i],
    }
}

/// A timed build, waiting for its bar line or running.
#[derive(Clone, Copy)]
pub(crate) struct Build {
    pub request_id: u32,
    pub bars: u32,
    /// The onset serial when it was queued (or when the build it replaced was).
    queued_at: u64,
    /// Whether the start onset has passed.
    pub started: bool,
    /// Onsets since the start onset.
    elapsed: u32,
    /// The base on the start onset: where the interpolation begins.
    from: [f32; SCENE_LEN],
    target: [f32; SCENE_LEN],
    land: Option<[f32; SCENE_LEN]>,
    /// What a cancel puts back. Once started, `from`, except where `inherited`.
    restore: [f32; SCENE_LEN],
    /// Whether this build replaced a running one. Then `restore` is that build's
    /// starting base (so cancelling the newer one still undoes both), not the
    /// half-built mix in between.
    inherited: bool,
    /// While waiting: slots whose restore value is whatever the base holds when this
    /// starts (the user moved them, or the build it replaced had given them up).
    keep: u64,
    /// While running: slots the user has taken back. The build leaves them alone.
    touched: u64,
    /// A crash on the onset it lands (`docs/NIGHT8_PROTOCOL.md`).
    accent: bool,
}

impl Build {
    fn total(&self) -> u32 {
        self.bars * BAR
    }

    fn progress(&self) -> f32 {
        (self.elapsed as f32 / self.total() as f32).min(1.0)
    }
}

/// Copy a validated 44-value slice into a vector.
fn vector(values: &[f32]) -> [f32; SCENE_LEN] {
    let mut v = [0.0f32; SCENE_LEN];
    v.copy_from_slice(&values[..SCENE_LEN]);
    v
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl Engine {
    /// Queue a timed build (`docs/NIGHT7_PROTOCOL.md`). Returns 0 when accepted,
    /// otherwise the reason it was refused, also reported as `build rejected` (45)
    /// with `b` naming the part refused (1 bars, 2 target, 3 land).
    ///
    /// `bars` is 2, 4 or 8. `target` is the 44-value scene vector the mix moves toward
    /// across them; `land` is either empty (no landing scene) or a 44-value scene
    /// committed whole on the onset the build ends on. Both are validated like a
    /// scene's before anything changes, and a refused request leaves whatever was
    /// queued or running as it was.
    ///
    /// The build starts on the next bar line and ends `bars` bars later, on a bar
    /// line. Refused while stopped (`not playing`, 7) and while a scratch, brake or
    /// backspin is running (`transport`, 3). Latest wins: a pending scene is replaced
    /// by it (`scene replaced`, `a` = this id), and so is a build already queued or
    /// running (`build replaced`); a running one hands over where it has got to, and
    /// cancelling this one restores the base from before either.
    ///
    /// Pattern lanes staged just before with [`Engine::queue_patterns`] and `link` =
    /// `request_id` go with the build: they apply on its end onset, after the landing
    /// scene and before that step's notes, and are withdrawn (`patterns cancelled`)
    /// when it is refused (with its reason), cancelled (with the cancel's), or
    /// replaced (10), exactly as a scene's linked lanes are.
    pub fn queue_build(&mut self, request_id: u32, bars: u32, target: &[f32], land: &[f32]) -> u8 {
        self.queue_build_with(request_id, bars, target, land, 0, 0, 0)
    }

    /// [`Engine::queue_build`], finishing with a fill (Rise + Fill,
    /// `docs/NIGHT8_PROTOCOL.md`) when `fill_id` is not 0: fill `fill_index` of the track
    /// plays the build's last bar, and the landing scene and lanes commit on the next
    /// downbeat, the onset the build ends on, as without one.
    ///
    /// One transaction: everything is checked before anything changes, and a refusal of
    /// any part refuses all of it. It posts `build rejected` (45) and, with a fill,
    /// `fill rejected` (15) for `fill_id`, both with the reason and `b` = the part
    /// ([`detail`]; 5 the fill: no such fill, reason 1, or a fill already waiting,
    /// reason 8). Accepted with a fill, it posts `build queued`, `fill queued` (the bar
    /// the fill plays) and `fill linked` (51: `a` = this build, `b` = the landing step).
    /// Cancelled, the fill goes with it, or runs its bar unlinked if already playing;
    /// replaced, the fill is cancelled (or unlinked) with reason 11.
    ///
    /// `accent` 1 plays a crash on the onset it lands (`accent fired`, 53), with or
    /// without a landing scene; 0 none; anything else is refused as invalid, part 3.
    #[allow(clippy::too_many_arguments)]
    pub fn queue_build_with(
        &mut self,
        request_id: u32,
        bars: u32,
        target: &[f32],
        land: &[f32],
        fill_id: u32,
        fill_index: u32,
        accent: u8,
    ) -> u8 {
        let with_fill = fill_id != 0;
        let replacing = self.build.as_ref().map(|b| b.request_id);
        let (verdict, part) = if !BUILD_BARS.contains(&bars) {
            (reason::INVALID, detail::BARS)
        } else if !scheduler::valid(target) {
            (reason::INVALID, detail::TARGET)
        } else if (!land.is_empty() && !scheduler::valid(land)) || accent > scheduler::accent::CRASH
        {
            (reason::INVALID, detail::LAND)
        } else if with_fill && !self.fill_args_ok(fill_index, 0, 0) {
            (reason::INVALID, detail::FILL)
        } else if !self.transport.playing {
            (reason::NOT_PLAYING, detail::NONE)
        } else if self.transport.in_gesture() {
            (reason::TRANSPORT, detail::NONE)
        } else if with_fill && self.scheduler.fill_busy_for_build(replacing) {
            (reason::ALREADY_PLAYING, detail::FILL)
        } else {
            (reason::OK, detail::NONE)
        };
        if verdict != reason::OK {
            // Both parts are refused, and the build's staged lanes are withdrawn;
            // anything else stays as it was, including the lanes a pending scene or
            // build was accepted with.
            self.refuse_linked(fill_id, request_id, event::BUILD_REJECTED, verdict, part);
            return verdict;
        }

        // The lanes this build sets, staged just before it, are the build's from here.
        let lanes = self.claim_staged(request_id);
        // Latest wins over a pending scene, and the lanes that scene carried go with it.
        if self.scheduler.replace_pending(request_id) {
            self.cancel_scene_lanes(reason::USER);
        }
        let serial = self.scheduler.serial();
        let (queued_at, inherited, restore, keep) = match self.build.take() {
            Some(old) => {
                self.scheduler.events.push(
                    event::BUILD_REPLACED,
                    old.request_id,
                    request_id as f64,
                    0.0,
                );
                self.withdraw_build_lanes(reason::USER);
                // Its fill was its last bar: it goes with it.
                self.scheduler
                    .drop_fill(Link::Build(old.request_id), reason::LINKED);
                if old.started {
                    // Hand over mid-build: the mix stays where the old one left it until
                    // this one starts, and a cancel still goes back to before the old one.
                    (serial, true, old.restore, old.touched)
                } else {
                    (old.queued_at, old.inherited, old.restore, old.keep)
                }
            }
            None => (serial, false, [0.0; SCENE_LEN], 0),
        };
        self.build = Some(Build {
            request_id,
            bars,
            queued_at,
            started: false,
            elapsed: 0,
            from: [0.0; SCENE_LEN],
            target: vector(target),
            land: if land.is_empty() {
                None
            } else {
                Some(vector(land))
            },
            restore,
            inherited,
            keep,
            touched: 0,
            accent: accent == scheduler::accent::CRASH,
        });
        self.build_lanes = lanes;
        // Freed here, in the message handler: a replaced build's lanes, and any a scene
        // withdrew on the audio path since the last message.
        self.parked = None;
        if with_fill {
            // Unarmed until the build starts: the build times it.
            self.scheduler.queue_fill(
                fill_id,
                fill_index,
                0,
                Link::Build(request_id),
                &self.transport,
            );
        }
        self.announce_build();
        if let Some(land) = self.announce_build_fill() {
            self.scheduler
                .events
                .push(event::FILL_LINKED, fill_id, request_id as f64, land as f64);
        }
        reason::OK
    }

    /// Cancel the build if it is `request_id`, queued or running, reported as `build
    /// cancelled` with reason 10. A running build glides back to the base it started
    /// from, and its landing scene never lands. False when it is not queued or
    /// running: already applied, replaced, cancelled, or never queued.
    pub fn cancel_build(&mut self, request_id: u32) -> bool {
        if self
            .build
            .as_ref()
            .is_some_and(|b| b.request_id == request_id)
        {
            self.cancel_build_for(reason::USER)
        } else {
            false
        }
    }

    /// The request id of the build waiting for its bar line, if one is.
    pub fn pending_build(&self) -> Option<u32> {
        self.build
            .as_ref()
            .filter(|b| !b.started)
            .map(|b| b.request_id)
    }

    /// The request id of the build in progress, if one is.
    pub fn active_build(&self) -> Option<u32> {
        self.build
            .as_ref()
            .filter(|b| b.started)
            .map(|b| b.request_id)
    }

    /// Copy the base, the working mix as the engine holds it, into `out` as a 44-value
    /// scene vector. Held gestures are not in it: it is what capture reads. During a
    /// build it is where the build has got to. False (nothing written) when `out` is
    /// shorter than 44.
    pub fn base_into(&self, out: &mut [f32]) -> bool {
        if out.len() < SCENE_LEN {
            return false;
        }
        out[..SCENE_LEN].copy_from_slice(&self.base());
        true
    }
}

/// The build's part of the engine, off the exported API.
impl Engine {
    /// The base as a scene vector: the channels' targets and the effects' base values.
    pub(crate) fn base(&self) -> [f32; SCENE_LEN] {
        let mut v = [0.0f32; SCENE_LEN];
        for (i, c) in self.channels.iter().enumerate() {
            let at = i * STEM_FIELDS;
            v[at] = c.vol;
            v[at + 1] = c.send;
            v[at + 2] = if c.muted { 1.0 } else { 0.0 };
            v[at + 3] = if c.solo { 1.0 } else { 0.0 };
        }
        v[FX_BASE..].copy_from_slice(&self.fx_base);
        v
    }

    /// Write `values` into the base, leaving the slots in `skip` alone. Effects whose
    /// value has not changed are not touched, so a build that does not move the room
    /// never recomputes it.
    #[inline(never)]
    fn write_base(&mut self, values: &[f32; SCENE_LEN], skip: u64) {
        for (i, c) in self.channels.iter_mut().enumerate() {
            let at = i * STEM_FIELDS;
            if skip & bit(at) == 0 {
                c.vol = values[at].clamp(0.0, 1.0);
            }
            if skip & bit(at + 1) == 0 {
                c.send = values[at + 1].clamp(0.0, 1.0);
            }
            if skip & bit(at + 2) == 0 {
                c.muted = values[at + 2] == 1.0;
            }
            if skip & bit(at + 3) == 0 {
                c.solo = values[at + 3] == 1.0;
            }
        }
        let mut bands = false;
        for j in 0..FX_LEN {
            let i = FX_BASE + j;
            if skip & bit(i) != 0 || values[i] == self.fx_base[j] {
                continue;
            }
            if (2..=4).contains(&j) {
                bands = true;
            } else {
                self.put_fx(j, values[i]);
            }
        }
        if bands {
            let pick = |i: usize| {
                if skip & bit(i) == 0 {
                    values[i]
                } else {
                    self.fx_base[i - FX_BASE]
                }
            };
            let (low, mid, high) = (pick(FX_BASE + 2), pick(FX_BASE + 3), pick(FX_BASE + 4));
            self.put_bands(low, mid, high);
        }
    }

    /// Set effect `j` (`SCENE_PARAMS` order, not the isolators) in the master and in
    /// the base mirror, with the master's own clamping, so the two never disagree.
    #[inline(never)]
    pub(crate) fn put_fx(&mut self, j: usize, v: f32) {
        let finite = v.is_finite();
        let m = &mut self.master;
        let stored = match j {
            0 => {
                m.set_filter(v);
                finite.then(|| v.clamp(0.0, 1.0))
            }
            1 => {
                m.set_filter_q(v);
                finite.then(|| v.clamp(crate::mixer::FILTER_Q_MIN, crate::mixer::FILTER_Q_MAX))
            }
            5 => {
                m.set_delay_beats(v, self.transport.bpm, self.transport.rate);
                Some(if !finite {
                    crate::mixer::DELAY_BEATS_DEFAULT
                } else if v <= 0.0 {
                    0.0
                } else {
                    v.clamp(0.125, 2.0)
                })
            }
            6 => {
                m.set_echo_feedback(v);
                finite.then(|| v.clamp(0.0, crate::mixer::ECHO_FEEDBACK_MAX))
            }
            7 => {
                m.set_echo_return(v);
                finite.then(|| v.clamp(0.0, 1.0))
            }
            8 => {
                m.set_reverb_mix(v);
                finite.then(|| v.clamp(0.0, crate::mixer::VERB_WET_MAX))
            }
            9 => {
                m.set_reverb_decay(v);
                Some(if finite {
                    v.clamp(crate::dsp::ROOM_RT60_MIN, crate::dsp::ROOM_RT60_MAX)
                } else {
                    crate::dsp::ROOM_RT60
                })
            }
            10 => {
                m.set_width(v);
                finite.then(|| v.clamp(0.0, crate::mixer::WIDTH_MAX))
            }
            11 => {
                m.set_balance(v);
                finite.then(|| v.clamp(0.0, 1.0))
            }
            _ => None,
        };
        if let Some(s) = stored {
            self.fx_base[j] = s;
        }
    }

    /// Set the three isolators in the master and the mirror. The master gets exactly
    /// what it always did; the mirror keeps the registry range (0 to 1.4).
    #[inline(never)]
    pub(crate) fn put_bands(&mut self, low: f32, mid: f32, high: f32) {
        self.master
            .set_eq(band_db(low), band_db(mid), band_db(high));
        for (j, v) in [(2, low), (3, mid), (4, high)] {
            if v.is_finite() {
                self.fx_base[j] = v.clamp(0.0, 1.4);
            }
        }
    }

    /// A setter moved the slots in `mask`. While a build runs they are the user's from
    /// now on; while one waits, a cancel keeps what the user set.
    #[inline]
    pub(crate) fn touch(&mut self, mask: u64) {
        if let Some(b) = self.build.as_mut() {
            if b.started {
                b.touched |= mask;
            } else {
                b.keep |= mask;
            }
        }
    }

    /// [`Engine::touch`] for effect `j`, in `SCENE_PARAMS` order.
    #[inline]
    pub(crate) fn touch_fx(&mut self, j: usize) {
        self.touch(bit(FX_BASE + j));
    }

    /// [`Engine::touch`] for one field of one stem: 0 volume, 1 send, 2 muted, 3 solo.
    #[inline]
    pub(crate) fn touch_stem(&mut self, stem: usize, field: usize) {
        self.touch(stem_bits(stem, field));
    }

    /// Report `build queued` for the waiting build with a fresh prediction of its bar
    /// line. Called when it is queued and again whenever the loop changes under it.
    pub(crate) fn announce_build(&mut self) {
        let Some(b) = self.build.as_ref().filter(|b| !b.started) else {
            return;
        };
        let step = scheduler::predict(&self.transport, BAR as usize);
        let id = b.request_id;
        self.scheduler
            .events
            .push(event::BUILD_QUEUED, id, (step / 16 + 1) as f64, step as f64);
    }

    /// Report `fill queued` for the build's fill (Rise + Fill), waiting or running,
    /// with the bar it plays: the build's last. Returns the predicted landing step, or
    /// `None` when the build has no fill waiting. Called when it is queued and whenever
    /// the loop changes. The fill's onset count is the build's, so only the step moves.
    pub(crate) fn announce_build_fill(&mut self) -> Option<usize> {
        let b = self.build.as_ref()?;
        let f = *self
            .scheduler
            .pending_fill()
            .filter(|f| f.link == Link::Build(b.request_id))?;
        let ahead = if b.started && f.start_serial != u64::MAX {
            (f.start_serial - self.scheduler.serial() - 1) as usize
        } else {
            // Starts on the next bar line; its last bar begins `bars - 1` bars later.
            scheduler::fill_offset(&self.transport, 0) + ((b.bars - 1) * BAR) as usize
        };
        let step = walk(&self.transport, ahead);
        self.scheduler.events.push(
            event::FILL_QUEUED,
            f.request_id,
            (step / 16 + 1) as f64,
            step as f64,
        );
        Some(walk(&self.transport, ahead + BAR as usize))
    }

    /// Cancel the build, queued or running, reporting `why`, and put back the base it
    /// started from (except the slots the user took back). True if there was one.
    #[inline(never)]
    pub(crate) fn cancel_build_for(&mut self, why: u8) -> bool {
        let Some(b) = self.build.take() else {
            return false;
        };
        if b.started {
            self.write_base(&b.restore, b.touched);
        } else if b.inherited {
            // Waiting to take over from a build it replaced: the mix is still where
            // that one left it, so it goes back to before that one.
            self.write_base(&b.restore, b.keep);
        }
        self.scheduler
            .events
            .push(event::BUILD_CANCELLED, b.request_id, why as f64, 0.0);
        self.withdraw_build_lanes(why);
        // One transaction: its fill goes with it (an interrupt has already ended it).
        self.scheduler.drop_fill(Link::Build(b.request_id), why);
        true
    }

    /// A scene request `by` has just been committed over the build: it is replaced,
    /// with no restore (the scene is complete), and its lanes are withdrawn. `by` is 0
    /// for the idle deck's follower.
    pub(crate) fn replace_build(&mut self, by: u32) {
        if let Some(b) = self.build.take() {
            self.scheduler
                .events
                .push(event::BUILD_REPLACED, b.request_id, by as f64, 0.0);
            self.withdraw_build_lanes(reason::USER);
            self.scheduler
                .drop_fill(Link::Build(b.request_id), reason::LINKED);
        }
    }

    /// Withdraw the build's linked lanes, reported as `patterns cancelled` with `why`,
    /// as a scene's are when it goes. Parked rather than dropped, because a scene
    /// committing over the build does this on the audio path; the next pattern or build
    /// message frees them.
    fn withdraw_build_lanes(&mut self, why: u8) {
        if let Some(l) = self.build_lanes.take() {
            self.scheduler
                .events
                .push(event::PATTERNS_CANCELLED, l.request_id, why as f64, 0.0);
            self.parked = Some(l);
        }
    }

    /// The build's part of an onset on `step`, run after the scene due here (which
    /// would have replaced it) and before the fill and the notes: start a waiting build
    /// on its bar line, or move a running one on, and end it on its last bar line with
    /// the target exact, the landing scene committed and its lanes swapped in.
    #[inline(never)]
    pub(crate) fn build_onset(&mut self, step: usize) {
        let Some(mut b) = self.build.take() else {
            return;
        };
        let bar_line = step.is_multiple_of(BAR as usize);
        if !b.started {
            if !(bar_line && self.scheduler.serial() > b.queued_at) {
                self.build = Some(b);
                return;
            }
            b.started = true;
            b.elapsed = 0;
            b.from = self.base();
            if b.inherited {
                for i in 0..SCENE_LEN {
                    if b.keep & bit(i) != 0 {
                        b.restore[i] = b.from[i];
                    }
                }
            } else {
                b.restore = b.from;
            }
            b.keep = 0;
            b.touched = 0;
            // Its fill plays the last bar, ending on the onset the build lands.
            let last_bar = self.scheduler.serial() + (b.total() - BAR) as u64;
            self.scheduler.arm_fill(Link::Build(b.request_id), last_bar);
            self.scheduler.events.push(
                event::BUILD_STARTED,
                b.request_id,
                step as f64,
                b.bars as f64,
            );
            #[cfg(test)]
            self.trace
                .push(crate::Trace::BuildStart(b.request_id, self.clock));
        } else {
            b.elapsed += 1;
            if b.elapsed >= b.total() && bar_line {
                self.write_base(&b.target, b.touched);
                if let Some(land) = b.land.as_ref() {
                    self.commit_targets(land);
                    #[cfg(test)]
                    self.trace
                        .push(crate::Trace::Apply(b.request_id, self.clock));
                }
                // The lanes after the landing, as a scene's follow its targets.
                if let Some(lanes) = self.build_lanes.take() {
                    debug_assert_eq!(lanes.link, b.request_id);
                    self.apply_patterns(lanes, step as i32);
                }
                if b.accent {
                    self.accent_due = Some(b.request_id);
                }
                self.scheduler.events.push(
                    event::BUILD_APPLIED,
                    b.request_id,
                    step as f64,
                    if b.land.is_some() { 1.0 } else { 0.0 },
                );
                return;
            }
            if bar_line {
                self.scheduler.events.push(
                    event::BUILD_PROGRESS,
                    b.request_id,
                    (b.elapsed / BAR + 1) as f64,
                    b.bars as f64,
                );
            }
        }
        let p = b.progress();
        let mut now = [0.0f32; SCENE_LEN];
        for (i, v) in now.iter_mut().enumerate() {
            *v = value_at(i, &b.from, &b.target, p);
        }
        self.write_base(&now, b.touched);
        self.build = Some(b);
    }
}
