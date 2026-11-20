//! Nothing on the audio path allocates or frees (`docs/NIGHT8_PROTOCOL.md`): a counting
//! allocator watches every `process()` call through Night 8's requests from queue to
//! landing or cancel, and the request calls themselves, on a real library track.
//!
//! The count is per thread and only while a closure runs, so the test harness and
//! other tests running alongside are not counted.
//!
//! The track is Warehouse's drums alone. Triggering a tone note allocates today, before
//! Night 8 and outside it (`Engine::trigger` clones the `NoteEvent`, whose pitches are a
//! `Vec`, and `tone::voicing` builds a `Vec` of detunes): parked in `PARKING_LOT.md`.
//! With the melodic lanes cleared, plain playback allocates nothing, so any count here
//! is Night 8's.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use bckgrnd_msc_engine::scene::{event, EVENT_CAPACITY, EVENT_WIDTH, SCENE_LEN};
use bckgrnd_msc_engine::{Engine, Fill, Track};

struct Counting;

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static COUNT: Cell<usize> = const { Cell::new(0) };
}

fn note() {
    let _ = ON.try_with(|on| {
        if on.get() {
            COUNT.with(|c| c.set(c.get() + 1));
        }
    });
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        note();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        note();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        note();
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        note();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

/// Run `f`, returning what it returned and how many allocations, reallocations and
/// frees it made on this thread.
fn counted<R>(f: impl FnOnce() -> R) -> (R, usize) {
    COUNT.with(|c| c.set(0));
    ON.with(|on| on.set(true));
    let r = f();
    ON.with(|on| on.set(false));
    (r, COUNT.with(|c| c.get()))
}

/// Warehouse's drums, from the arrangement JSON the bench plays, with a one-bar fill.
fn warehouse() -> Track {
    let path = format!("{}/../tools/reference.json", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).expect("reference.json");
    let mut tracks: std::collections::BTreeMap<String, Track> =
        serde_json::from_str(&raw).expect("tracks");
    let mut t = tracks.remove("warehouse").expect("warehouse");
    t.fills = vec![Fill {
        kick: vec![0.0; 16],
        clap: vec![0.7; 16],
        hat: vec![0.3; 16],
        hat_open: Vec::new(),
    }];
    for lane in [
        &mut t.bass,
        &mut t.stab,
        &mut t.lead,
        &mut t.pad,
        &mut t.arp,
    ] {
        lane.iter_mut().for_each(|n| *n = None);
    }
    t.bpm = 180.0;
    t
}

struct Rig {
    e: Engine,
    l: [f32; 128],
    r: [f32; 128],
    events: [f64; EVENT_CAPACITY * EVENT_WIDTH],
    /// Allocations counted so far, and where.
    allocs: Vec<(String, usize)>,
}

impl Rig {
    fn new() -> Self {
        let mut e = Engine::new(48_000.0);
        e.load_track(warehouse());
        e.play();
        let mut rig = Self {
            e,
            l: [0.0; 128],
            r: [0.0; 128],
            events: [0.0; EVENT_CAPACITY * EVENT_WIDTH],
            allocs: Vec::new(),
        };
        // Warm up: voices, the ring and the meters all in use.
        for _ in 0..375 {
            rig.block();
        }
        rig
    }

    /// One counted render call, then the events drained (counted too), as the worklet
    /// does. Returns whether an event of `kind` came out.
    fn block_seeing(&mut self, kind: u8) -> bool {
        let Self {
            e, l, r, events, ..
        } = self;
        let (seen, n) = counted(|| {
            e.process(l, r);
            let n = e.take_events_into(events) as usize;
            events.as_chunks::<4>().0[..n]
                .iter()
                .any(|x| x[0] == kind as f64)
        });
        if n > 0 {
            self.allocs.push(("process".into(), n));
        }
        seen
    }

    fn block(&mut self) {
        self.block_seeing(0);
    }

    /// Render until an event of `kind` comes out (at most 30 s).
    fn until(&mut self, kind: u8) {
        for _ in 0..(48_000 * 30 / 128) {
            if self.block_seeing(kind) {
                return;
            }
        }
        panic!("event {kind} never came");
    }

    /// A counted request call.
    fn call<R>(&mut self, what: &str, f: impl FnOnce(&mut Engine) -> R) -> R {
        let (r, n) = counted(|| f(&mut self.e));
        if n > 0 {
            self.allocs.push((what.into(), n));
        }
        r
    }
}

fn a_scene(e: &Engine, kick: f32) -> [f32; SCENE_LEN] {
    let mut v = [0.0f32; SCENE_LEN];
    assert!(e.base_into(&mut v));
    v[0] = kick;
    v
}

#[test]
fn night_8_requests_neither_allocate_nor_free_on_the_audio_path() {
    let mut rig = Rig::new();
    // The control: plain playback of these drums allocates nothing.
    for _ in 0..1_000 {
        rig.block();
    }
    assert!(
        rig.allocs.is_empty(),
        "plain playback allocated: {:?}",
        rig.allocs
    );

    // A phrase fill: queued, waiting, playing, ended.
    assert_eq!(
        rig.call("queue_fill_at", |e| e.queue_fill_at(1, 0, 4, 0)),
        0
    );
    rig.until(event::FILL_STARTED);
    rig.until(event::FILL_ENDED);

    // Fill into: queued, a loop change re-announcing it, then landing.
    let drop = a_scene(&rig.e, 0.9);
    assert_eq!(
        rig.call("queue_fill_into", |e| e
            .queue_fill_into(2, 0, 2, 0, 3, &drop)),
        0
    );
    rig.call("set_loop", |e| e.set_loop(4));
    rig.until(event::FILL_STARTED);
    rig.until(event::SCENE_APPLIED);
    rig.call("set_loop", |e| e.set_loop(0));

    // Fill into cancelled while waiting, and while its fill plays.
    let back = a_scene(&rig.e, 0.5);
    assert_eq!(
        rig.call("queue_fill_into", |e| e
            .queue_fill_into(4, 0, 2, 0, 5, &back)),
        0
    );
    rig.block();
    assert!(rig.call("cancel_fill", |e| e.cancel_fill(4)));
    assert_eq!(
        rig.call("queue_fill_into", |e| e
            .queue_fill_into(6, 0, 2, 0, 7, &back)),
        0
    );
    rig.until(event::FILL_STARTED);
    assert!(rig.call("cancel_scene", |e| e.cancel_scene(7)));
    rig.until(event::FILL_ENDED);

    assert!(rig.allocs.is_empty(), "allocated: {:?}", rig.allocs);
}
