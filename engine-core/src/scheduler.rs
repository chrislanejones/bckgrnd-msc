//! The musical scheduler: scenes queued against the step clock, and the events that
//! report what became of them.
//!
//! The contract is `docs/NIGHT3_PROTOCOL.md`. In short:
//!
//! - A scene is a 44-value vector ([`SCENE_LEN`]): four values per stem in
//!   `Stem::ALL` order, then the twelve effect parameters of [`SCENE_PARAMS`].
//! - It is validated as a whole before anything changes, and committed as a whole at
//!   one onset (or at the start of the next render call, for [`Timing::Now`]).
//! - Deadlines are counted on a monotonic onset serial, never on step numbers, so a
//!   loop that repeats a bar cannot make a request fire twice, or early.
//! - One pending scene. The latest valid request replaces it and keeps the boundary
//!   already announced, unless the new request is `Now`.
//! - Every outcome is an event in a fixed ring, drained by the worklet after each
//!   render call.
//!
//! Nothing here allocates. The pending slot and the ring are fixed-size arrays, and
//! the per-onset check is two comparisons.

use crate::track::{FILL_STEPS, STEPS};
use crate::transport::Transport;

/// Fills start on bar lines.
const FILL_GRID: usize = 16;

/// The phrase lengths a fill can end on, in bars (`docs/NIGHT8_PROTOCOL.md`). 0 is not
/// a phrase: the fill plays the next bar, as it always has.
pub const FILL_PHRASE_BARS: [u8; 5] = [0, 2, 4, 8, 16];

/// The fill lengths `queue_fill_at` takes. Only 0, one bar, for now; the argument is
/// there so more lengths fit later without changing the call.
pub const FILL_LENGTHS: [u8; 1] = [0];

/// Length of the scene vector: 8 stems x (volume, send, muted, solo), then 12 effects.
pub const SCENE_LEN: usize = 44;

/// Values per stem in the scene vector.
pub const STEM_FIELDS: usize = 4;

/// Index of the first effect parameter in the scene vector.
pub const FX_BASE: usize = 32;

/// The effect parameters a scene holds, in vector order from index [`FX_BASE`]. This
/// is `sceneVector` in `contracts/scenes.json`; `tests/scenes_contract.rs` holds the
/// two together.
pub const SCENE_PARAMS: [&str; 12] = [
    "fx.filter",
    "fx.filterQ",
    "fx.low",
    "fx.mid",
    "fx.high",
    "fx.echoTime",
    "fx.echoFeedback",
    "fx.echoReturn",
    "fx.reverbMix",
    "fx.reverbDecay",
    "fx.width",
    "fx.stereo",
];

/// The echo times the registry offers, in beats (0 is off). `fx.echoTime` is an enum
/// in `contracts/parameters.json`, so a scene must hold one of these exactly (to f32
/// precision), not merely something inside 0..1.5.
pub const ECHO_TIME_OPTIONS: [f32; 7] = [0.0, 0.25, 1.0 / 3.0, 0.5, 0.75, 1.0, 1.5];

/// What a slot of the scene vector may hold.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SlotKind {
    /// Any value from `min` to `max`, inclusive.
    Range { min: f32, max: f32 },
    /// Exactly 0 or exactly 1.
    Toggle,
    /// One of [`ECHO_TIME_OPTIONS`].
    EchoTime,
}

/// The registry range of each effect parameter, in [`SCENE_PARAMS`] order.
pub const FX_KINDS: [SlotKind; 12] = [
    SlotKind::Range { min: 0.0, max: 1.0 }, // fx.filter
    SlotKind::Range {
        min: crate::mixer::FILTER_Q_MIN,
        max: crate::mixer::FILTER_Q_MAX,
    }, // fx.filterQ
    SlotKind::Range { min: 0.0, max: 1.4 }, // fx.low
    SlotKind::Range { min: 0.0, max: 1.4 }, // fx.mid
    SlotKind::Range { min: 0.0, max: 1.4 }, // fx.high
    SlotKind::EchoTime,                     // fx.echoTime
    SlotKind::Range {
        min: 0.0,
        max: crate::mixer::ECHO_FEEDBACK_MAX,
    }, // fx.echoFeedback
    SlotKind::Range { min: 0.0, max: 1.0 }, // fx.echoReturn
    SlotKind::Range {
        min: 0.0,
        max: crate::mixer::VERB_WET_MAX,
    }, // fx.reverbMix
    SlotKind::Range {
        min: crate::dsp::ROOM_RT60_MIN,
        max: crate::dsp::ROOM_RT60_MAX,
    }, // fx.reverbDecay
    SlotKind::Range {
        min: 0.0,
        max: crate::mixer::WIDTH_MAX,
    }, // fx.width
    SlotKind::Range { min: 0.0, max: 1.0 }, // fx.stereo
];

/// What slot `index` of the scene vector may hold, or `None` past the end.
pub fn slot_kind(index: usize) -> Option<SlotKind> {
    if index < FX_BASE {
        return Some(match index % STEM_FIELDS {
            // Volume and send.
            0 | 1 => SlotKind::Range { min: 0.0, max: 1.0 },
            // Muted and solo.
            _ => SlotKind::Toggle,
        });
    }
    FX_KINDS.get(index - FX_BASE).copied()
}

/// Slack on a range's ends, so a value that round-tripped through f64 and back still
/// counts as inside. The setters clamp, so this cannot let anything past the engine.
const RANGE_SLACK: f32 = 1e-5;

/// Whether `values` is a complete, valid scene vector: the right length, every value
/// finite and inside its slot's registry range, toggles exactly 0 or 1.
pub fn valid(values: &[f32]) -> bool {
    values.len() == SCENE_LEN
        && values.iter().enumerate().all(|(i, &v)| {
            v.is_finite()
                && match slot_kind(i) {
                    Some(SlotKind::Range { min, max }) => {
                        v >= min - RANGE_SLACK && v <= max + RANGE_SLACK
                    }
                    Some(SlotKind::Toggle) => v == 0.0 || v == 1.0,
                    Some(SlotKind::EchoTime) => {
                        ECHO_TIME_OPTIONS.iter().any(|o| (o - v).abs() < 1e-4)
                    }
                    None => false,
                }
        })
}

/// When a queued scene applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Timing {
    /// The first sample of the next render call.
    Now,
    /// The first eligible onset on a multiple of 4 steps.
    Beat,
    /// The first eligible onset on a multiple of 16 steps.
    Bar,
    /// On the onset serial [`PendingScene::due`]: the scene of a Fill into, which
    /// commits on the onset its fill ends (`docs/NIGHT8_PROTOCOL.md`). Never on the wire.
    Linked,
}

impl Timing {
    pub fn from_code(code: u8) -> Option<Self> {
        match code {
            timing::NOW => Some(Self::Now),
            timing::BEAT => Some(Self::Beat),
            timing::BAR => Some(Self::Bar),
            _ => None,
        }
    }

    /// Steps between eligible onsets, or `None` for `Now`, which waits on no onset.
    pub fn grid(self) -> Option<usize> {
        match self {
            Self::Now | Self::Linked => None,
            Self::Beat => Some(4),
            Self::Bar => Some(16),
        }
    }
}

/// Timing codes on the wire.
pub mod timing {
    pub const NOW: u8 = 0;
    pub const BEAT: u8 = 1;
    pub const BAR: u8 = 2;
}

/// Event kinds on the wire: the first of each event's four numbers.
pub mod event {
    pub const SCENE_QUEUED: u8 = 1;
    pub const SCENE_APPLIED: u8 = 2;
    pub const SCENE_CANCELLED: u8 = 3;
    pub const SCENE_REPLACED: u8 = 4;
    pub const SCENE_REJECTED: u8 = 5;
    pub const FILL_QUEUED: u8 = 11;
    pub const FILL_STARTED: u8 = 12;
    pub const FILL_ENDED: u8 = 13;
    pub const FILL_CANCELLED: u8 = 14;
    pub const FILL_REJECTED: u8 = 15;
    pub const GESTURE_EXPIRED: u8 = 21;
    pub const PATTERNS_QUEUED: u8 = 31;
    pub const PATTERNS_APPLIED: u8 = 32;
    pub const PATTERNS_CANCELLED: u8 = 33;
    pub const PATTERNS_REPLACED: u8 = 34;
    pub const PATTERNS_REJECTED: u8 = 35;
    /// Timed builds (`docs/NIGHT7_PROTOCOL.md`). 41-45 mean what 1-5 mean for a
    /// scene; 46 and 47 are the build's own.
    pub const BUILD_QUEUED: u8 = 41;
    pub const BUILD_APPLIED: u8 = 42;
    pub const BUILD_CANCELLED: u8 = 43;
    pub const BUILD_REPLACED: u8 = 44;
    pub const BUILD_REJECTED: u8 = 45;
    pub const BUILD_STARTED: u8 = 46;
    pub const BUILD_PROGRESS: u8 = 47;
    /// Linked requests (`docs/NIGHT8_PROTOCOL.md`): a fill tied to the scene or build it
    /// leads into (`a` = that request's id, `b` = the predicted landing step), and the
    /// tie broken while the fill lives on as a plain fill (`a` = the reason).
    pub const FILL_LINKED: u8 = 51;
    pub const FILL_UNLINKED: u8 = 52;
}

/// Reason codes, carried by `cancelled` and `rejected` events and returned by
/// [`crate::Engine::queue_scene`].
pub mod reason {
    pub const OK: u8 = 0;
    pub const INVALID: u8 = 1;
    pub const STOPPED: u8 = 2;
    pub const TRANSPORT: u8 = 3;
    pub const TRACK: u8 = 4;
    pub const PANIC: u8 = 5;
    pub const MIXING: u8 = 6;
    pub const NOT_PLAYING: u8 = 7;
    pub const ALREADY_PLAYING: u8 = 8;
    pub const STALE: u8 = 9;
    pub const USER: u8 = 10;
    /// One part of a linked request was cancelled because its partner was replaced
    /// (`docs/NIGHT8_PROTOCOL.md`).
    pub const LINKED: u8 = 11;
}

/// Numbers per event: `[kind, request id, a, b]`.
pub const EVENT_WIDTH: usize = 4;

/// Events the ring holds between drains.
///
/// The worklet drains after every render call, and a call produces at most a few
/// (one pending scene can be applied once). Overflow needs dozens of requests landing
/// between two render calls. When it happens the **oldest** event is overwritten and
/// counted in [`EventRing::dropped`]: with one pending slot the newest events describe
/// the current state, and a UI that sees `queued` or `applied` for a request treats
/// any older request it was still waiting on as superseded.
pub const EVENT_CAPACITY: usize = 64;

/// A fixed ring of outcome events. Allocated once, at its full size, when the engine
/// is made; it never grows or reallocates after that.
pub struct EventRing {
    /// Always exactly [`EVENT_CAPACITY`] long. Boxed rather than inline so the engine's
    /// constructor zeroes it with one allocation instead of 256 separate stores.
    buf: Box<[[f64; EVENT_WIDTH]]>,
    /// Index of the oldest event.
    head: usize,
    len: usize,
    dropped: u32,
}

impl Default for EventRing {
    fn default() -> Self {
        Self {
            buf: vec![[0.0; EVENT_WIDTH]; EVENT_CAPACITY].into_boxed_slice(),
            head: 0,
            len: 0,
            dropped: 0,
        }
    }
}

impl EventRing {
    // Out of line: every transport action reports through here, and inlining it into
    // each one cost more wasm than the call.
    #[inline(never)]
    pub fn push(&mut self, kind: u8, id: u32, a: f64, b: f64) {
        let record = [kind as f64, id as f64, a, b];
        if self.len == EVENT_CAPACITY {
            // Full: overwrite the oldest.
            self.buf[self.head] = record;
            self.head = (self.head + 1) % EVENT_CAPACITY;
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.buf[(self.head + self.len) % EVENT_CAPACITY] = record;
        self.len += 1;
    }

    pub fn len(&self) -> usize {
        self.len
    }

    /// Events overwritten before they were drained, since the engine was made.
    pub fn dropped(&self) -> u32 {
        self.dropped
    }

    /// Move as many events as fit into `out`, oldest first, four numbers each.
    /// Returns how many were moved; any that did not fit stay for the next drain.
    pub fn drain_into(&mut self, out: &mut [f64]) -> u32 {
        let n = self.len.min(out.len() / EVENT_WIDTH);
        for (k, chunk) in out.as_chunks_mut::<EVENT_WIDTH>().0[..n]
            .iter_mut()
            .enumerate()
        {
            *chunk = self.buf[(self.head + k) % EVENT_CAPACITY];
        }
        self.head = (self.head + n) % EVENT_CAPACITY;
        self.len -= n;
        n as u32
    }
}

/// The one scene waiting for its boundary.
#[derive(Clone, Copy)]
pub struct PendingScene {
    pub request_id: u32,
    pub timing: Timing,
    /// The onset serial when the boundary was announced. Only an onset with a higher
    /// serial can apply it.
    pub queued_at: u64,
    /// For [`Timing::Linked`], the onset serial it commits on. Unused otherwise.
    pub due: u64,
    /// The snapshot, copied when queued.
    pub values: [f32; SCENE_LEN],
}

/// The one fill waiting for its bar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingFill {
    pub request_id: u32,
    /// Index into the track's `fills`.
    pub index: u32,
    /// 0: the next bar. 2, 4, 8 or 16: the bar that ends on a phrase line of that many
    /// bars, or on the loop's wrap.
    pub phrase_bars: u8,
    /// The onset serial its first step plays on: counted in onsets, so a tempo change
    /// moves nothing. Recomputed when the loop changes under it.
    pub start_serial: u64,
    /// The request it leads into, if any.
    pub link: Link,
}

/// What a fill is tied to (`docs/NIGHT8_PROTOCOL.md`): nothing, the scene it leads
/// into (Fill into), or the build whose last bar it plays (Rise + Fill).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Link {
    None,
    Scene(u32),
    Build(u32),
}

/// The fill playing now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActiveFill {
    pub request_id: u32,
    pub index: u32,
    /// Which of its sixteen steps the current onset plays, 0..16.
    pub pos: usize,
    /// The request it leads into, if any.
    pub link: Link,
}

/// The scheduler's state: the onset serial, the pending scene, the pending and
/// active fill, and the event ring.
#[derive(Default)]
pub struct Scheduler {
    /// Onsets fired since the engine was made. Never reset, never wraps in practice
    /// (2^64 sixteenths).
    serial: u64,
    scene: Option<PendingScene>,
    fill: Option<PendingFill>,
    active_fill: Option<ActiveFill>,
    pub events: EventRing,
}

impl Scheduler {
    /// Onsets counted so far. A pattern revision queued now applies on a later one.
    pub fn serial(&self) -> u64 {
        self.serial
    }

    pub fn pending(&self) -> Option<&PendingScene> {
        self.scene.as_ref()
    }

    /// Put `values` (already validated) in the pending slot.
    ///
    /// A request already pending is replaced, reported as `replaced`, and its
    /// announced boundary kept unless the new request is `Now`. Then `queued` is
    /// reported with the predicted bar and step, unless the boundary is `Now`.
    pub fn queue(&mut self, request_id: u32, timing: Timing, values: &[f32], t: &Transport) {
        let mut copy = [0.0f32; SCENE_LEN];
        copy.copy_from_slice(&values[..SCENE_LEN]);
        let (timing, queued_at) = match self.scene.take() {
            Some(old) => {
                self.events.push(
                    event::SCENE_REPLACED,
                    old.request_id,
                    request_id as f64,
                    0.0,
                );
                // A Fill into's scene replaced: its fill plays on as a plain fill, and
                // the new scene keeps its own timing, not the fill's end.
                self.unlink_fill(Link::Scene(old.request_id), reason::USER);
                if timing == Timing::Now || old.timing == Timing::Linked {
                    (timing, self.serial)
                } else {
                    (old.timing, old.queued_at)
                }
            }
            None => (timing, self.serial),
        };
        self.scene = Some(PendingScene {
            request_id,
            timing,
            queued_at,
            due: 0,
            values: copy,
        });
        self.announce(t);
    }

    /// Put `values` (already validated) in the pending slot as a Fill into's scene,
    /// committing on onset serial `due`. A scene already pending is replaced, as by
    /// [`Scheduler::queue`]. Announced with its fill, by [`Scheduler::announce_fill`].
    pub fn queue_linked(&mut self, request_id: u32, values: &[f32], due: u64) {
        let mut copy = [0.0f32; SCENE_LEN];
        copy.copy_from_slice(&values[..SCENE_LEN]);
        self.replace_pending(request_id);
        self.scene = Some(PendingScene {
            request_id,
            timing: Timing::Linked,
            queued_at: self.serial,
            due,
            values: copy,
        });
    }

    /// Report `queued` for the pending scene with a fresh prediction. Called when it
    /// is queued and again whenever the loop changes under it.
    pub fn announce(&mut self, t: &Transport) {
        let Some(p) = self.scene.as_ref() else { return };
        let Some(grid) = p.timing.grid() else { return };
        let step = predict(t, grid);
        self.events.push(
            event::SCENE_QUEUED,
            p.request_id,
            (step / 16 + 1) as f64,
            step as f64,
        );
    }

    /// Work out the pending fill's start onset afresh (the loop may have moved its
    /// phrase end) and report `fill queued` with the bar and step it starts on.
    ///
    /// A Fill into's scene moves with it, to the onset the fill ends on, and is
    /// re-announced (`scene queued`) with its landing. A build's fill is the build's to
    /// time and announce (`Engine::announce_build_fill`), so it is left alone here.
    #[inline(never)]
    pub fn announce_fill(&mut self, t: &Transport) {
        let serial = self.serial;
        let Some(f) = self.fill.as_mut() else { return };
        if matches!(f.link, Link::Build(_)) {
            return;
        }
        let ahead = fill_offset(t, f.phrase_bars);
        f.start_serial = serial + 1 + ahead as u64;
        let (id, start_serial, link) = (f.request_id, f.start_serial, f.link);
        let step = walk(t, ahead);
        self.events
            .push(event::FILL_QUEUED, id, (step / 16 + 1) as f64, step as f64);
        if let Link::Scene(scene) = link {
            if let Some(p) = self.scene.as_mut().filter(|p| p.request_id == scene) {
                p.due = start_serial + FILL_STEPS as u64;
                let land = walk(t, ahead + FILL_STEPS);
                self.events.push(
                    event::SCENE_QUEUED,
                    scene,
                    (land / 16 + 1) as f64,
                    land as f64,
                );
            }
        }
    }

    /// Whether a fill is queued or playing. A second one is refused while either is.
    pub fn fill_busy(&self) -> bool {
        self.fill.is_some() || self.active_fill.is_some()
    }

    pub fn pending_fill(&self) -> Option<&PendingFill> {
        self.fill.as_ref()
    }

    pub fn active_fill(&self) -> Option<&ActiveFill> {
        self.active_fill.as_ref()
    }

    /// Queue fill `index` (already checked against the track) for the bar
    /// `phrase_bars` picks ([`fill_offset`]), and report `fill queued`. The caller has
    /// already checked the arguments and refused a request while
    /// [`Scheduler::fill_busy`].
    ///
    /// `link` ties it to the request it leads into. A build's fill is not timed here:
    /// it waits, unarmed, until the build starts and [`Scheduler::arm_fill`] sets it.
    pub fn queue_fill(
        &mut self,
        request_id: u32,
        index: u32,
        phrase_bars: u8,
        link: Link,
        t: &Transport,
    ) {
        self.fill = Some(PendingFill {
            request_id,
            index,
            phrase_bars,
            start_serial: u64::MAX,
            link,
        });
        self.announce_fill(t);
    }

    /// Time the waiting fill tied to `partner` to start on onset serial `start`.
    pub fn arm_fill(&mut self, partner: Link, start: u64) {
        if let Some(f) = self.fill.as_mut().filter(|f| f.link == partner) {
            f.start_serial = start;
        }
    }

    /// Whether the fill slot is taken for a build's fill: a fill is waiting that is not
    /// `replacing`'s (the build the new one replaces, whose fill goes with it). A fill
    /// playing now does not count: it ends within a bar, and a build's fill plays the
    /// build's last bar, at least a bar after the build starts.
    pub fn fill_busy_for_build(&self, replacing: Option<u32>) -> bool {
        self.fill
            .is_some_and(|f| replacing.is_none_or(|id| f.link != Link::Build(id)))
    }

    /// The pending fill's id and link, and whether it is pending (true) or playing
    /// (false), if `request_id` is either.
    pub fn fill_state(&self, request_id: u32) -> Option<(bool, Link)> {
        if let Some(f) = self.fill.filter(|f| f.request_id == request_id) {
            return Some((true, f.link));
        }
        self.active_fill
            .filter(|a| a.request_id == request_id)
            .map(|a| (false, a.link))
    }

    /// The fill tied to `partner` loses it and carries on as a plain fill, waiting or
    /// playing: `fill unlinked` with `why`. Nothing if no fill is tied to it.
    #[inline(never)]
    pub fn unlink_fill(&mut self, partner: Link, why: u8) {
        let pending = self.fill.as_mut().map(|f| (&mut f.link, f.request_id));
        let active = self
            .active_fill
            .as_mut()
            .map(|a| (&mut a.link, a.request_id));
        for (link, id) in [pending, active].into_iter().flatten() {
            if *link == partner {
                *link = Link::None;
                self.events.push(event::FILL_UNLINKED, id, why as f64, 0.0);
            }
        }
    }

    /// The fill tied to `partner` goes with it: cancelled with `why` while it waits.
    /// One already playing runs its bar (Night 3) and is unlinked instead.
    #[inline(never)]
    pub fn drop_fill(&mut self, partner: Link, why: u8) {
        if let Some(f) = self.fill.filter(|f| f.link == partner) {
            self.fill = None;
            self.events
                .push(event::FILL_CANCELLED, f.request_id, why as f64, 0.0);
        }
        self.unlink_fill(partner, why);
    }

    /// The fill's part of an onset, run after [`Scheduler::on_onset`] has counted it
    /// and after any scene due here has been committed: end an active fill that has
    /// played its sixteen steps, then start a pending one whose bar this is. Leaves
    /// [`Scheduler::active_fill`] describing what this onset's drums play.
    #[inline]
    pub fn fill_onset(&mut self, step: usize) {
        if let Some(a) = self.active_fill.as_mut() {
            a.pos += 1;
            if a.pos >= FILL_STEPS {
                let id = a.request_id;
                self.active_fill = None;
                self.events
                    .push(event::FILL_ENDED, id, step as f64, reason::OK as f64);
            }
        }
        // Due on its own onset. The bar-line check only guards against a start that
        // somehow fell off the grid: the fill then waits for the next bar line.
        let due = self
            .fill
            .as_ref()
            .is_some_and(|f| self.serial >= f.start_serial && step.is_multiple_of(FILL_GRID));
        if due {
            if let Some(f) = self.fill.take() {
                self.active_fill = Some(ActiveFill {
                    request_id: f.request_id,
                    index: f.index,
                    pos: 0,
                    link: f.link,
                });
                self.events
                    .push(event::FILL_STARTED, f.request_id, step as f64, 0.0);
            }
        }
    }

    /// Cancel the pending fill if it is `request_id` (reason 10). False when it is
    /// not pending: never queued, already started, or already cancelled. A fill that
    /// is playing is not cut short by this; it runs its bar.
    pub fn cancel_fill(&mut self, request_id: u32) -> bool {
        match self.fill {
            Some(f) if f.request_id == request_id => {
                self.fill = None;
                self.events
                    .push(event::FILL_CANCELLED, request_id, reason::USER as f64, 0.0);
                true
            }
            _ => false,
        }
    }

    /// Cancel a pending fill (`fill cancelled`, reason `why`) and cut short an active
    /// one (`fill ended` with step -1 and `why`). True if there was either.
    #[inline(never)]
    pub fn end_fills(&mut self, why: u8) -> bool {
        let mut any = false;
        if let Some(f) = self.fill.take() {
            self.events
                .push(event::FILL_CANCELLED, f.request_id, why as f64, 0.0);
            any = true;
        }
        if let Some(a) = self.active_fill.take() {
            self.events
                .push(event::FILL_ENDED, a.request_id, -1.0, why as f64);
            any = true;
        }
        any
    }

    /// Count an onset on `step` and hand back the pending scene if this onset is its
    /// boundary. Runs on every onset: two comparisons when nothing is due.
    #[inline]
    pub fn on_onset(&mut self, step: usize) -> Option<PendingScene> {
        self.serial += 1;
        let due = self.scene.as_ref().is_some_and(|p| match p.timing {
            Timing::Linked => self.serial >= p.due,
            timing => {
                self.serial > p.queued_at
                    && timing.grid().is_some_and(|grid| step.is_multiple_of(grid))
            }
        });
        if due {
            self.scene.take()
        } else {
            None
        }
    }

    /// Hand back the pending scene if it is waiting for the next render call.
    #[inline]
    pub fn take_now(&mut self) -> Option<PendingScene> {
        if self.scene.as_ref().is_some_and(|p| p.timing == Timing::Now) {
            self.scene.take()
        } else {
            None
        }
    }

    /// Cancel the pending scene if it is `request_id`. False if it is not pending
    /// (never queued, already applied, already cancelled or replaced).
    pub fn cancel(&mut self, request_id: u32) -> bool {
        if self
            .scene
            .as_ref()
            .is_some_and(|p| p.request_id == request_id)
        {
            self.cancel_pending(reason::USER);
            // A Fill into is one request: its waiting fill goes too, and a playing one
            // runs its bar unlinked.
            self.drop_fill(Link::Scene(request_id), reason::USER);
            true
        } else {
            false
        }
    }

    /// Drop the pending scene because request `by` (a timed build) superseded it,
    /// reporting `replaced`. False if none was pending.
    pub fn replace_pending(&mut self, by: u32) -> bool {
        match self.scene.take() {
            Some(p) => {
                self.events
                    .push(event::SCENE_REPLACED, p.request_id, by as f64, 0.0);
                self.unlink_fill(Link::Scene(p.request_id), reason::USER);
                true
            }
            None => false,
        }
    }

    /// Cancel whatever scene is pending, reporting `reason`. False if none was.
    #[inline(never)]
    pub fn cancel_pending(&mut self, why: u8) -> bool {
        match self.scene.take() {
            Some(p) => {
                self.events
                    .push(event::SCENE_CANCELLED, p.request_id, why as f64, 0.0);
                true
            }
            None => false,
        }
    }
}

/// How many onsets from now (0: the next one) a fill asked for with `phrase_bars`
/// starts: the first bar line, walking the clock's own advance rule from the step due
/// next, whose bar ends on a phrase line or on the loop's wrap. Phrase lines sit on the
/// absolute grid from step 0, so every one of 2, 4, 8 and 16 bars also falls on the
/// song's own wrap. `phrase_bars` 0 takes the first bar line, as fills always have. A
/// bar line already passed is never waited for: the walk only looks ahead, so a late
/// press goes to the next phrase end. Bounded: a phrase end or the loop's last bar
/// turns up within one pass of the song.
pub fn fill_offset(t: &Transport, phrase_bars: u8) -> usize {
    let phrase = phrase_bars as usize * FILL_GRID;
    let loop_end = t.loop_start + t.loop_steps;
    let mut step = t.step;
    for ahead in 0..=STEPS {
        if step.is_multiple_of(FILL_GRID) {
            let end = step + FILL_GRID;
            if phrase == 0 || end.is_multiple_of(phrase) || (t.loop_steps > 0 && end == loop_end) {
                return ahead;
            }
        }
        step = t.following(step);
    }
    0
}

/// The step the clock plays `ahead` onsets from now (0: the step due next).
pub fn walk(t: &Transport, ahead: usize) -> usize {
    let mut step = t.step;
    for _ in 0..ahead {
        step = t.following(step);
    }
    step
}

/// The step the next eligible onset on `grid` will fire, walking the clock's own
/// advance rule (loops included) from the step due next. Bounded: a loop start is
/// always on a bar line, so a multiple of `grid` turns up within a bar.
pub fn predict(t: &Transport, grid: usize) -> usize {
    let mut step = t.step;
    for _ in 0..=STEPS {
        if step.is_multiple_of(grid) {
            return step;
        }
        step = t.following(step);
    }
    t.step
}

#[cfg(test)]
mod tests {
    use super::*;

    fn neutral() -> [f32; SCENE_LEN] {
        let mut v = [0.0f32; SCENE_LEN];
        for i in 0..8 {
            v[i * 4] = 0.8;
        }
        v[FX_BASE..].copy_from_slice(&[
            1.0, 0.85, 1.0, 1.0, 1.0, 0.75, 0.3, 0.24, 0.07, 0.32, 1.0, 0.5,
        ]);
        v
    }

    #[test]
    fn a_neutral_vector_is_valid() {
        assert!(valid(&neutral()));
    }

    #[test]
    fn every_kind_of_bad_value_is_refused() {
        assert!(!valid(&neutral()[..43]));
        let mut long = [0.0f32; 45];
        long[..44].copy_from_slice(&neutral());
        assert!(!valid(&long));
        for (i, bad) in [
            (0, f32::NAN),
            (1, f32::INFINITY),
            (0, 1.2),
            (1, -0.1),
            (2, 0.5),
            (3, 2.0),
            (33, 0.2),
            (34, 1.5),
            (37, 0.6),
            (38, 0.95),
            (40, 0.6),
            (41, 3.0),
            (42, 1.6),
            (43, -0.01),
        ] {
            let mut v = neutral();
            v[i] = bad;
            assert!(!valid(&v), "slot {i} = {bad} should be refused");
        }
    }

    #[test]
    fn the_echo_triplet_survives_f32() {
        let mut v = neutral();
        v[37] = (1.0f64 / 3.0) as f32;
        assert!(valid(&v));
    }

    #[test]
    fn the_ring_overwrites_its_oldest_when_full() {
        let mut ring = EventRing::default();
        for i in 0..(EVENT_CAPACITY as u32 + 3) {
            ring.push(event::SCENE_QUEUED, i, 0.0, 0.0);
        }
        assert_eq!(ring.len(), EVENT_CAPACITY);
        assert_eq!(ring.dropped(), 3);
        let mut out = [0.0f64; EVENT_CAPACITY * EVENT_WIDTH];
        assert_eq!(ring.drain_into(&mut out), EVENT_CAPACITY as u32);
        assert_eq!(out[1], 3.0, "the oldest three were overwritten");
        assert_eq!(ring.len(), 0);
    }

    #[test]
    fn a_short_drain_leaves_the_rest() {
        let mut ring = EventRing::default();
        for i in 0..5 {
            ring.push(event::SCENE_APPLIED, i, 0.0, 0.0);
        }
        let mut out = [0.0f64; 9];
        assert_eq!(ring.drain_into(&mut out), 2);
        assert_eq!(ring.len(), 3);
        assert_eq!(ring.drain_into(&mut out), 2);
        assert_eq!(
            out[1], 2.0,
            "the second drain starts where the first stopped"
        );
        assert_eq!(ring.len(), 1);
    }
}
