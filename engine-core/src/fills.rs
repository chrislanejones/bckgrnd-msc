//! Night 8 fills (`docs/NIGHT8_PROTOCOL.md`): a fill that ends on a phrase line, and a
//! fill that leads into a scene.
//!
//! - A fill asked for with a phrase length of 2, 4, 8 or 16 bars plays the bar that
//!   ends on the next phrase line, on the absolute grid from step 0, or on the loop's
//!   wrap, whichever comes first. 0 plays the next bar, as fills always have.
//! - A press too late for this phrase goes to the next one; it is never refused for
//!   being late.
//! - The start is counted in onsets (`start_serial`), so a tempo change moves nothing,
//!   and a loop change works it out again and re-announces it.
//! - **Fill into** is one request in two parts: a phrase fill, and a scene (with its
//!   lanes) that commits on the onset the fill ends, before that step's notes. Both
//!   are accepted or neither, with no new slots: the one pending fill, tied by id to
//!   the one pending scene ([`Link::Scene`], [`Timing::Linked`]).
//!
//! Nothing here allocates: a request is a few integers in the one pending fill slot and
//! a copied vector in the one pending scene slot. Lanes are parsed in `queue_patterns`
//! and only moved here.
//!
//! [`Timing::Linked`]: crate::scheduler::Timing::Linked

use crate::scheduler::{self, event, reason, walk, Link, FILL_LENGTHS, FILL_PHRASE_BARS};
use crate::track::FILL_STEPS;
use crate::Engine;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// `b` of the `fill rejected` and `scene rejected` a refused Fill into posts: which
/// part of the request was refused. 0 when the whole request was (not playing, a
/// scratch, brake or backspin).
pub mod detail {
    pub const NONE: u8 = 0;
    pub const SCENE: u8 = 1;
    pub const FILL: u8 = 2;
    /// The lanes the scene sets. The worklet reports this one: it stages the lanes, and
    /// the engine refuses a bad payload as `patterns rejected` before the Fill into is
    /// asked for.
    pub const LANES: u8 = 3;
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl Engine {
    /// Queue fill `index` of the loaded track to end on a phrase line
    /// (`docs/NIGHT8_PROTOCOL.md`). Returns 0 when accepted, otherwise the reason, also
    /// reported as `fill rejected` (15).
    ///
    /// `phrase_bars` is 0 (the next bar, as [`Engine::queue_fill`]) or 2, 4, 8 or 16:
    /// the fill plays the bar that ends on the next phrase line of that length, or on
    /// the loop's wrap. `length` is 0, one bar; nothing else yet. Refused with 1 for any
    /// other `phrase_bars` or `length`, or no such fill; 7 while stopped; 3 during a
    /// scratch, brake or backspin; 8 while a fill is queued or playing.
    pub fn queue_fill_at(
        &mut self,
        request_id: u32,
        index: u32,
        phrase_bars: u8,
        length: u8,
    ) -> u8 {
        let verdict = if !self.fill_args_ok(index, phrase_bars, length) {
            reason::INVALID
        } else if !self.transport.playing {
            reason::NOT_PLAYING
        } else if self.transport.in_gesture() {
            reason::TRANSPORT
        } else if self.scheduler.fill_busy() {
            reason::ALREADY_PLAYING
        } else {
            self.scheduler
                .queue_fill(request_id, index, phrase_bars, Link::None, &self.transport);
            reason::OK
        };
        if verdict != reason::OK {
            self.scheduler
                .events
                .push(event::FILL_REJECTED, request_id, verdict as f64, 0.0);
        }
        verdict
    }

    /// Fill into (`docs/NIGHT8_PROTOCOL.md`): fill `index` as [`Engine::queue_fill_at`]
    /// with `phrase_bars` and `length`, and the scene `values` (a 44-value vector)
    /// committed on the onset the fill ends, before that step's notes, as one request.
    /// Returns 0 when accepted, otherwise the reason.
    ///
    /// Lanes staged just before with [`Engine::queue_patterns`] and `link` = `scene_id`
    /// go with the scene, as a launch's do.
    ///
    /// Everything is checked before anything changes: both parts are queued or neither
    /// is. A refusal posts `fill rejected` (15) for `fill_id` and `scene rejected` (5)
    /// for `scene_id`, both with the reason and `b` = the part refused
    /// ([`detail`]: 1 the scene, 2 the fill, 0 the whole request), withdraws the lanes
    /// staged for `scene_id`, and leaves whatever was queued as it was. Reasons: 1 an
    /// invalid scene, fill index, phrase or length; 7 not playing; 3 a scratch, brake or
    /// backspin; 8 a fill already queued or playing.
    ///
    /// Accepted, it replaces a pending scene (`scene replaced`, latest wins, and that
    /// scene's lanes go with it) and posts `fill queued`, `scene queued` (the landing
    /// bar and step) and `fill linked` (51: `a` = `scene_id`, `b` = the landing step).
    #[allow(clippy::too_many_arguments)]
    pub fn queue_fill_into(
        &mut self,
        fill_id: u32,
        index: u32,
        phrase_bars: u8,
        length: u8,
        scene_id: u32,
        values: &[f32],
    ) -> u8 {
        let (verdict, part) = if !scheduler::valid(values) {
            (reason::INVALID, detail::SCENE)
        } else if !self.fill_args_ok(index, phrase_bars, length) {
            (reason::INVALID, detail::FILL)
        } else if !self.transport.playing {
            (reason::NOT_PLAYING, detail::NONE)
        } else if self.transport.in_gesture() {
            (reason::TRANSPORT, detail::NONE)
        } else if self.scheduler.fill_busy() {
            (reason::ALREADY_PLAYING, detail::FILL)
        } else {
            (reason::OK, detail::NONE)
        };
        if verdict != reason::OK {
            self.refuse_linked(fill_id, scene_id, event::SCENE_REJECTED, verdict, part);
            return verdict;
        }

        // The lanes staged for the scene are the scene's from here.
        let lanes = self.claim_staged(scene_id);
        let ahead = scheduler::fill_offset(&self.transport, phrase_bars);
        let start = self.scheduler.serial() + 1 + ahead as u64;
        self.scheduler
            .queue_linked(scene_id, values, start + FILL_STEPS as u64);
        // The scene it replaced, if one was pending, takes its lanes along.
        self.cancel_scene_lanes(reason::USER);
        self.scene_lanes = lanes;
        self.scheduler.queue_fill(
            fill_id,
            index,
            phrase_bars,
            Link::Scene(scene_id),
            &self.transport,
        );
        let land = walk(&self.transport, ahead + FILL_STEPS);
        self.scheduler
            .events
            .push(event::FILL_LINKED, fill_id, scene_id as f64, land as f64);
        reason::OK
    }

    /// Cancel the fill `request_id` (`docs/NIGHT8_PROTOCOL.md`). False when it is
    /// neither queued nor playing, or is a plain fill already playing (it runs its bar).
    ///
    /// - A plain fill waiting for its bar: `fill cancelled`, reason 10.
    /// - Tied to a scene (Fill into) or a build (Rise + Fill): the whole request is
    ///   cancelled, as [`Engine::cancel_scene`] or [`Engine::cancel_build`] on its
    ///   partner would. A waiting fill is cancelled with it; one already playing runs
    ///   its bar and is unlinked (52).
    pub fn cancel_fill(&mut self, request_id: u32) -> bool {
        match self.scheduler.fill_state(request_id) {
            Some((true, Link::None)) => self.scheduler.cancel_fill(request_id),
            Some((_, Link::Scene(scene))) => self.cancel_scene(scene),
            Some((_, Link::Build(build))) => self.cancel_build(build),
            _ => false,
        }
    }
}

/// The fills' part of the engine, off the exported API.
impl Engine {
    /// Whether a fill request names a fill the track has, a phrase length the engine
    /// knows and a fill length it can play.
    pub(crate) fn fill_args_ok(&self, index: u32, phrase_bars: u8, length: u8) -> bool {
        (index as usize) < self.track.fills.len()
            && FILL_PHRASE_BARS.contains(&phrase_bars)
            && FILL_LENGTHS.contains(&length)
    }

    /// A linked request refused: `fill rejected` for its fill and `rejected` of
    /// `partner_kind` for its partner, both with `why` and `part`, and the lanes staged
    /// for the partner withdrawn. Nothing else is touched.
    #[inline(never)]
    pub(crate) fn refuse_linked(
        &mut self,
        fill_id: u32,
        partner: u32,
        partner_kind: u8,
        why: u8,
        part: u8,
    ) {
        if fill_id != 0 {
            self.scheduler
                .events
                .push(event::FILL_REJECTED, fill_id, why as f64, part as f64);
        }
        self.scheduler
            .events
            .push(partner_kind, partner, why as f64, part as f64);
        self.refuse_staged(partner, why);
    }
}
