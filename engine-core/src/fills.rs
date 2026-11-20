//! Night 8 fills (`docs/NIGHT8_PROTOCOL.md`): a fill that ends on a phrase line.
//!
//! - A fill asked for with a phrase length of 2, 4, 8 or 16 bars plays the bar that
//!   ends on the next phrase line, on the absolute grid from step 0, or on the loop's
//!   wrap, whichever comes first. 0 plays the next bar, as fills always have.
//! - A press too late for this phrase goes to the next one; it is never refused for
//!   being late.
//! - The start is counted in onsets (`start_serial`), so a tempo change moves nothing,
//!   and a loop change works it out again and re-announces it.
//!
//! Nothing here allocates: a request is a few integers in the one pending fill slot.

use crate::scheduler::{event, reason, FILL_LENGTHS, FILL_PHRASE_BARS};
use crate::Engine;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

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
                .queue_fill(request_id, index, phrase_bars, &self.transport);
            reason::OK
        };
        if verdict != reason::OK {
            self.scheduler
                .events
                .push(event::FILL_REJECTED, request_id, verdict as f64, 0.0);
        }
        verdict
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
}
