//! Performance gestures: temporary overrides on top of the working mix.
//!
//! The contract is `docs/NIGHT3_PROTOCOL.md` (Gestures). The engine keeps the **base**
//! values (what the setters and scene commits write) in the master chain, and up to
//! [`MAX_GESTURES`] overrides here. An override never writes the base: ending one only
//! removes it, so whatever the base is *now* (a knob moved, a scene committed while it
//! was held) is what is heard after.
//!
//! The two Night 3 kinds control disjoint parameters (Echo Throw: the echo's throw
//! send, dry/wet and feedback; Filter Hold: the tape filter's cutoff and resonance),
//! and every override of one kind applies the same treatment. So "the most recently
//! begun wins for any parameter it controls" reduces to "the parameter is overridden
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Slot {
    token: u32,
    kind: u8,
    /// Rendered samples left before the lease runs out.
    lease: u32,
}

/// The active overrides.
pub struct Gestures {
    slots: [Option<Slot>; MAX_GESTURES],
    /// A full lease, in samples.
    lease: u32,
}

impl Gestures {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            slots: [None; MAX_GESTURES],
            lease: (LEASE_SECONDS * sample_rate).max(1.0) as u32,
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
        if !matches!(kind, kind::ECHO_THROW | kind::FILTER_HOLD) || self.find(token).is_some() {
            return false;
        }
        let lease = self.lease;
        match self.slots.iter_mut().find(|s| s.is_none()) {
            Some(slot) => {
                *slot = Some(Slot { token, kind, lease });
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

    /// End every override. True if there was one.
    pub fn clear(&mut self) -> bool {
        let any = self.slots.iter().any(Option::is_some);
        self.slots = [None; MAX_GESTURES];
        any
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
                    events.push(event::GESTURE_EXPIRED, g.token, g.kind as f64, 0.0);
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
        assert!(!g.begin(1, 3), "unknown kind");
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
        let mut out = [0.0f64; 8];
        assert_eq!(ring.drain_into(&mut out), 1);
        assert_eq!(&out[..4], &[event::GESTURE_EXPIRED as f64, 5.0, 1.0, 0.0]);
    }
}
