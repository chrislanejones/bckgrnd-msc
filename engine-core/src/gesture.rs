//! Performance gestures: temporary overrides on top of the working mix.
//!
//! The contract is `docs/NIGHT3_PROTOCOL.md` (Gestures). The engine keeps the **base**
//! values (what the setters and scene commits write) in the master chain, and up to
//! [`MAX_GESTURES`] overrides here. An override never writes the base: ending one only
//! removes it, so whatever the base is *now* (a knob moved, a scene committed while it
//! was held) is what is heard after.
//!
//! The kinds control disjoint parameters (Echo Throw: the echo's throw send, dry/wet
//! and feedback; Filter Hold: the tape filter's cutoff and resonance; Beat Repeat,
//! Night 10: the pre-master stutter in `repeat`), and every override of one kind
//! applies the same treatment. So "the most recently begun wins for any parameter it controls" reduces to "the parameter is overridden
//! while any gesture of its kind is active", and ending one token reveals the next of
//! the same kind (identical values) or the base. A future kind that overlaps another
//! needs a begin order here; nothing else changes.
//!
//! Each override holds a lease: it expires after [`LEASE_SECONDS`] of rendered audio
//! unless renewed, and expiry is reported as event 21 (`a` = kind). Fixed capacity, no
//! allocation.

use crate::scheduler::{event, EventRing};

/// Overrides active at once.
pub const MAX_GESTURES: usize = 4;

/// Rendered seconds an override lasts without a renewal.
pub const LEASE_SECONDS: f32 = 3.0;

/// Gesture kinds on the wire.
pub mod kind {
    /// Echo Throw: the existing throw (send, feedback and return held open).
    pub const ECHO_THROW: u8 = 1;
    /// Filter Hold: a dark, resonant filter treatment.
    pub const FILTER_HOLD: u8 = 2;
    /// Beat Repeat: loop one grid slice of the pre-master signal (`docs/NIGHT10_PROTOCOL.md`).
    pub const BEAT_REPEAT: u8 = 3;
}

/// The `b` field of `gesture expired` (21): why the engine ended the gesture.
pub mod ended {
    /// Its lease ran out.
    pub const LEASE: f64 = 0.0;
    /// A brake, backspin or scratch took over the deck (Beat Repeat only).
    pub const PLATTER: f64 = 1.0;
}

/// The `b` field of `repeat ended` (62): why the stutter stopped
/// (`docs/NIGHT10_PROTOCOL.md`, Events). 0 and 1 mean what they mean for 21.
pub mod repeat_ended {
    /// The last held Beat Repeat token's lease ran out.
    pub const LEASE: f64 = 0.0;
    /// A brake, backspin or scratch took over the deck.
    pub const PLATTER: f64 = 1.0;
    /// The host let go of the last held Beat Repeat token (`gesture_end`).
    pub const RELEASE: f64 = 2.0;
    /// Release FX (`release_gestures`).
    pub const RELEASE_FX: f64 = 3.0;
    /// Panic.
    pub const PANIC: f64 = 4.0;
    /// Stop.
    pub const STOP: f64 = 5.0;
    /// A track load.
    pub const TRACK: f64 = 6.0;
    /// The end of an offline score.
    pub const END_OF_SCORE: f64 = 7.0;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Slot {
    token: u32,
    kind: u8,
    /// Rendered samples left before the lease runs out.
    lease: u32,
    /// When it began, counted in begins: the lowest is the one held longest.
    order: u64,
}

/// The active overrides.
pub struct Gestures {
    slots: [Option<Slot>; MAX_GESTURES],
    /// A full lease, in samples.
    lease: u32,
    /// Begins accepted so far.
    begun: u64,
}

impl Gestures {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            slots: [None; MAX_GESTURES],
            lease: (LEASE_SECONDS * sample_rate).max(1.0) as u32,
            begun: 0,
        }
    }

    fn find(&mut self, token: u32) -> Option<&mut Option<Slot>> {
        self.slots
            .iter_mut()
            .find(|s| s.is_some_and(|g| g.token == token))
    }

    /// Begin an override. False (and nothing changed) for an unknown kind, a token
    /// already active, or when all [`MAX_GESTURES`] slots are taken.
    pub fn begin(&mut self, token: u32, kind: u8) -> bool {
        if !matches!(
            kind,
            kind::ECHO_THROW | kind::FILTER_HOLD | kind::BEAT_REPEAT
        ) || self.find(token).is_some()
        {
            return false;
        }
        let (lease, order) = (self.lease, self.begun);
        match self.slots.iter_mut().find(|s| s.is_none()) {
            Some(slot) => {
                *slot = Some(Slot {
                    token,
                    kind,
                    lease,
                    order,
                });
                self.begun += 1;
                true
            }
            None => false,
        }
    }

    /// End `token` only. False when it is not active (never begun, ended, expired).
    pub fn end(&mut self, token: u32) -> bool {
        match self.find(token) {
            Some(slot) => {
                *slot = None;
                true
            }
            None => false,
        }
    }

    /// Restart `token`'s lease. False when it is not active.
    pub fn renew(&mut self, token: u32) -> bool {
        let lease = self.lease;
        match self.find(token) {
            Some(Some(g)) => {
                g.lease = lease;
                true
            }
            _ => false,
        }
    }

    /// End every override of `kind`, reporting each as `gesture expired` (21) with `b`
    /// = `why`, since the host did not ask for it. True if there was one.
    pub fn end_kind(&mut self, kind: u8, why: f64, events: &mut EventRing) -> bool {
        let mut any = false;
        for slot in self.slots.iter_mut() {
            if let Some(g) = slot {
                if g.kind == kind {
                    events.push(event::GESTURE_EXPIRED, g.token, g.kind as f64, why);
                    *slot = None;
                    any = true;
                }
            }
        }
        any
    }

    /// End every override. True if there was one.
    pub fn clear(&mut self) -> bool {
        let any = self.slots.iter().any(Option::is_some);
        self.slots = [None; MAX_GESTURES];
        any
    }

    /// The token of `kind` held longest (begun first), if any is held.
    pub fn first(&self, kind: u8) -> Option<u32> {
        self.slots
            .iter()
            .flatten()
            .filter(|g| g.kind == kind)
            .min_by_key(|g| g.order)
            .map(|g| g.token)
    }

    /// Whether an override of `kind` is active.
    #[inline]
    pub fn holds(&self, kind: u8) -> bool {
        self.slots.iter().flatten().any(|g| g.kind == kind)
    }

    /// Count `samples` of rendered audio against every lease, expiring (and reporting)
    /// the ones that run out. True if any expired. Called once per render call, so a
    /// lease ends at the end of the call in which it runs out (within 128 samples).
    #[inline]
    pub fn tick(&mut self, samples: u32, events: &mut EventRing) -> bool {
        let mut expired = false;
        for slot in self.slots.iter_mut() {
            if let Some(g) = slot {
                if g.lease <= samples {
                    events.push(event::GESTURE_EXPIRED, g.token, g.kind as f64, ended::LEASE);
                    *slot = None;
                    expired = true;
                } else {
                    g.lease -= samples;
                }
            }
        }
        expired
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_tokens_and_kinds_are_enforced() {
        let mut g = Gestures::new(48_000.0);
        assert!(!g.begin(1, 0), "unknown kind");
        assert!(!g.begin(1, 4), "unknown kind");
        for t in 0..4 {
            assert!(g.begin(t, kind::FILTER_HOLD));
        }
        assert!(!g.begin(9, kind::ECHO_THROW), "a fifth");
        assert!(g.end(2));
        assert!(!g.end(2), "ended twice");
        assert!(!g.begin(1, kind::ECHO_THROW), "token already active");
        assert!(g.begin(9, kind::ECHO_THROW));
        assert!(g.holds(kind::ECHO_THROW) && g.holds(kind::FILTER_HOLD));
        assert!(g.clear());
        assert!(!g.holds(kind::ECHO_THROW) && !g.holds(kind::FILTER_HOLD));
        assert!(!g.clear());
    }

    #[test]
    fn first_is_the_token_held_longest_whatever_its_slot() {
        let mut g = Gestures::new(48_000.0);
        assert_eq!(g.first(kind::BEAT_REPEAT), None);
        assert!(g.begin(7, kind::BEAT_REPEAT));
        assert!(g.begin(8, kind::BEAT_REPEAT));
        assert!(g.end(7));
        assert!(g.begin(9, kind::BEAT_REPEAT), "takes the slot 7 left");
        assert_eq!(g.first(kind::BEAT_REPEAT), Some(8));
        assert_eq!(g.first(kind::ECHO_THROW), None);
    }

    #[test]
    fn a_lease_expires_unless_renewed() {
        let sr = 1_000.0;
        let mut g = Gestures::new(sr);
        let mut ring = EventRing::default();
        g.begin(5, kind::ECHO_THROW);
        g.begin(6, kind::FILTER_HOLD);
        for _ in 0..29 {
            assert!(!g.tick(100, &mut ring));
            assert!(g.renew(6));
        }
        assert!(g.tick(100, &mut ring), "3 s rendered");
        assert!(!g.holds(kind::ECHO_THROW));
        assert!(g.holds(kind::FILTER_HOLD), "the renewed one stays");
        assert!(!g.renew(5), "an expired token is gone");
        let mut out = [0.0f64; 2 * crate::scheduler::EVENT_WIDTH];
        assert_eq!(ring.drain_into(&mut out), 1);
        assert_eq!(
            &out[..5],
            &[event::GESTURE_EXPIRED as f64, 5.0, 1.0, 0.0, 0.0]
        );
    }
}
