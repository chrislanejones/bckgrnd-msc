//! Nothing on the audio path allocates or frees (`docs/NIGHT8_PROTOCOL.md`): a counting
//! allocator watches every `process()` call, and the event drain the worklet does inside
//! its render callback, through:
//!
//! - Night 8's requests (phrase fills, Fill into, Rise + Fill, crash accents) from queue
//!   to landing or cancel, and the request calls themselves, on Warehouse with all its
//!   lanes, tone stems included;
//! - every library track, from the top through fifteen of its sixteen bars: drums,
//!   percussion, every tuned stem and the section seams. Note voices are built on the
//!   audio path, so this is the test that keeps them off the heap;
//! - pattern lanes moving at a boundary, where a free would hide: a scene landing with
//!   its lanes, a build ending with its lanes and a landing scene, a scene committing
//!   over a running build (the build's lanes are parked, not dropped), and a refused
//!   request arriving while a scene with lanes is pending. Lanes are staged unarmed:
//!   message handlers may allocate.
//!
//! The count is per thread and only while a closure runs, so the test harness and
//! other tests running alongside are not counted.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use bckgrnd_msc_engine::scene::{event, EVENT_CAPACITY, EVENT_WIDTH, SCENE_LEN};
use bckgrnd_msc_engine::{Engine, Fill, Track, STEPS};

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

/// Warehouse, from the arrangement JSON the bench plays, with a one-bar fill.
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
    t.bpm = 180.0;
    t
}

/// A library track by id, as the static build serves it.
fn library(name: &str) -> Track {
    let path = format!(
        "{}/../public/library/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the track")).expect("json");
    serde_json::from_value(doc["track"].clone()).expect("a track")
}

/// Every library track's id, sorted.
fn library_names() -> Vec<String> {
    let dir = format!("{}/../public/library", env!("CARGO_MANIFEST_DIR"));
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("the library")
        .map(|e| e.expect("an entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .map(|p| p.file_stem().unwrap().to_string_lossy().to_string())
        .filter(|n| n != "index")
        .collect();
    names.sort();
    names
}

struct Rig {
    e: Engine,
    l: [f32; 128],
    r: [f32; 128],
    events: [f64; EVENT_CAPACITY * EVENT_WIDTH],
    /// Every event drained so far, recorded outside the counted window.
    seen: Vec<[f64; 4]>,
    /// Allocations counted so far, and where.
    allocs: Vec<(String, usize)>,
}

impl Rig {
    fn new() -> Self {
        Self::with_track(warehouse())
    }

    /// `track` playing at 48 kHz, warmed up a few steps past its first notes (voices,
    /// the ring and the meters all in use) before anything is counted.
    fn with_track(track: Track) -> Self {
        let mut e = Engine::new(48_000.0);
        e.load_track(track);
        e.play();
        let mut rig = Self {
            e,
            l: [0.0; 128],
            r: [0.0; 128],
            events: [0.0; EVENT_CAPACITY * EVENT_WIDTH],
            seen: Vec::with_capacity(8192),
            allocs: Vec::new(),
        };
        while rig.e.visual_step() < 3 {
            rig.block();
        }
        rig.allocs.clear();
        rig.seen.clear();
        rig
    }

    /// One counted render call, then the events drained (counted too), as the worklet
    /// does. Returns whether an event of `kind` came out.
    fn block_seeing(&mut self, kind: u8) -> bool {
        let Self {
            e, l, r, events, ..
        } = self;
        let ((seen, drained), n) = counted(|| {
            e.process(l, r);
            let n = e.take_events_into(events) as usize;
            let seen = events.as_chunks::<4>().0[..n]
                .iter()
                .any(|x| x[0] == kind as f64);
            (seen, n)
        });
        if n > 0 {
            self.allocs.push(("process".into(), n));
        }
        // Reserved up front, and outside the counted window either way.
        self.seen
            .extend_from_slice(&self.events.as_chunks::<4>().0[..drained]);
        seen
    }

    fn block(&mut self) {
        self.block_seeing(0);
    }

    /// Render until the playhead reaches `step` (at most 120 s).
    fn run_to(&mut self, step: i32) {
        for _ in 0..(48_000 * 120 / 128) {
            if self.e.visual_step() >= step {
                return;
            }
            self.block();
        }
        panic!("never reached step {step}");
    }

    /// Whether an event of `kind` about request `id` has come out.
    fn saw(&self, kind: u8, id: u32) -> bool {
        self.seen
            .iter()
            .any(|x| x[0] == kind as f64 && x[1] == id as f64)
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
            .queue_fill_into(2, 0, 2, 0, 3, &drop, 1)),
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
            .queue_fill_into(4, 0, 2, 0, 5, &back, 0)),
        0
    );
    rig.block();
    assert!(rig.call("cancel_fill", |e| e.cancel_fill(4)));
    assert_eq!(
        rig.call("queue_fill_into", |e| e
            .queue_fill_into(6, 0, 2, 0, 7, &back, 0)),
        0
    );
    rig.until(event::FILL_STARTED);
    assert!(rig.call("cancel_scene", |e| e.cancel_scene(7)));
    rig.until(event::FILL_ENDED);

    // Rise + Fill: queued, started, the fill on its last bar, landed.
    let rise = a_scene(&rig.e, 0.4);
    assert_eq!(
        rig.call("queue_build_with", |e| e
            .queue_build_with(8, 2, &rise, &drop, 9, 0, 1)),
        0
    );
    rig.call("set_loop", |e| e.set_loop(2));
    rig.until(event::BUILD_STARTED);
    rig.until(event::FILL_STARTED);
    rig.until(event::BUILD_APPLIED);
    rig.call("set_loop", |e| e.set_loop(0));

    // Cancelled in its last bar (the fill runs on, unlinked), and replaced by a scene
    // committing over it on the audio path (its fill cancelled there).
    assert_eq!(
        rig.call("queue_build_with", |e| e.queue_build_with(
            10,
            2,
            &rise,
            &[],
            11,
            0,
            0
        )),
        0
    );
    rig.until(event::FILL_STARTED);
    assert!(rig.call("cancel_build", |e| e.cancel_build(10)));
    rig.until(event::FILL_ENDED);
    assert_eq!(
        rig.call("queue_build_with", |e| e.queue_build_with(
            12,
            4,
            &rise,
            &[],
            13,
            0,
            0
        )),
        0
    );
    rig.until(event::BUILD_STARTED);
    assert_eq!(
        rig.call("queue_scene_with", |e| e.queue_scene_with(14, 2, &back, 1)),
        0
    );
    rig.until(event::BUILD_REPLACED);

    // Crash accents: a Now scene's fires in the render call, a Bar scene's on its onset.
    assert_eq!(
        rig.call("queue_scene_with", |e| e.queue_scene_with(15, 0, &drop, 1)),
        0
    );
    rig.until(event::ACCENT_FIRED);
    assert_eq!(
        rig.call("queue_scene_with", |e| e.queue_scene_with(16, 2, &back, 1)),
        0
    );
    rig.until(event::ACCENT_FIRED);

    assert!(rig.allocs.is_empty(), "allocated: {:?}", rig.allocs);
}

const BAR: u8 = 2;

/// A pattern payload (`docs/NIGHT4_PROTOCOL.md`) replacing drum lane `index` with one hit.
fn drum(index: usize, step: usize, velocity: f32) -> Vec<f32> {
    let mut out = vec![1.0, index as f32, 0.0, STEPS as f32];
    let mut lane = vec![0.0f32; STEPS];
    lane[step] = velocity;
    out.extend(lane);
    out
}

/// The engine's own base with every fader at `level`: always a valid scene.
fn faders(e: &Engine, level: f32) -> [f32; SCENE_LEN] {
    let mut v = [0.0f32; SCENE_LEN];
    assert!(e.base_into(&mut v));
    for stem in 0..8 {
        v[stem * 4] = level;
    }
    v
}

#[test]
fn the_counter_counts() {
    let ((), n) = counted(|| drop(std::hint::black_box(vec![1u8; 64])));
    assert_eq!(n, 2, "one allocation and one free");
}

/// Every tuned note builds its voices inside `process()`; before Night 9 each one cloned
/// its pitches and built its detune list and oscillators on the heap.
#[test]
fn every_library_track_plays_without_allocating_or_freeing() {
    let names = library_names();
    assert_eq!(names.len(), 20, "the library is 20 tracks");
    for name in names {
        let mut rig = Rig::with_track(library(&name));
        rig.run_to(15 * 16);
        assert!(rig.allocs.is_empty(), "{name} allocated: {:?}", rig.allocs);
    }
}

#[test]
fn a_scene_landing_with_its_lanes_allocates_and_frees_nothing() {
    let mut rig = Rig::with_track(library("warehouse"));
    assert_eq!(rig.e.queue_patterns(20, BAR, 10, &drum(2, 16, 0.9)), 0);
    let s = faders(&rig.e, 0.5);
    assert_eq!(rig.e.queue_scene(10, BAR, &s), 0);
    rig.run_to(20);
    assert!(rig.allocs.is_empty(), "allocated: {:?}", rig.allocs);
    assert!(rig.saw(event::PATTERNS_APPLIED, 20) && rig.saw(event::SCENE_APPLIED, 10));
}

#[test]
fn a_refused_request_over_a_pending_scene_allocates_and_frees_nothing_on_the_audio_path() {
    let mut rig = Rig::with_track(library("warehouse"));
    assert_eq!(rig.e.queue_patterns(20, BAR, 10, &drum(2, 16, 0.9)), 0);
    let s = faders(&rig.e, 0.5);
    assert_eq!(rig.e.queue_scene(10, BAR, &s), 0);
    // A scene and a build, each with lanes, each refused: staged lanes are withdrawn
    // in the message handler, and the pending scene keeps its own.
    assert_eq!(rig.e.queue_patterns(21, BAR, 11, &drum(2, 16, 0.1)), 0);
    assert_ne!(rig.e.queue_scene(11, 9, &s), 0);
    assert_eq!(rig.e.queue_patterns(22, BAR, 12, &drum(2, 16, 0.2)), 0);
    assert_ne!(rig.e.queue_build(12, 3, &s, &[]), 0);
    rig.run_to(20);
    assert!(rig.allocs.is_empty(), "allocated: {:?}", rig.allocs);
    assert!(rig.saw(event::PATTERNS_CANCELLED, 21) && rig.saw(event::PATTERNS_CANCELLED, 22));
    assert!(
        rig.saw(event::PATTERNS_APPLIED, 20) && rig.saw(event::SCENE_APPLIED, 10),
        "the pending scene landed with its lanes: {:?}",
        rig.seen
    );
}

#[test]
fn a_build_ending_with_lanes_and_a_landing_scene_allocates_and_frees_nothing() {
    for bars in [2u32, 4, 8] {
        let mut rig = Rig::with_track(library("cipher"));
        let target = faders(&rig.e, 0.9);
        let land = faders(&rig.e, 0.4);
        assert_eq!(rig.e.queue_patterns(20, BAR, 1, &drum(2, 16, 0.9)), 0);
        assert_eq!(rig.e.queue_build(1, bars, &target, &land), 0);
        rig.run_to(16 + bars as i32 * 16 + 4);
        assert!(
            rig.allocs.is_empty(),
            "{bars} bars allocated: {:?}",
            rig.allocs
        );
        assert!(
            rig.saw(event::BUILD_APPLIED, 1) && rig.saw(event::PATTERNS_APPLIED, 20),
            "{bars} bars"
        );
    }
}

#[test]
fn a_scene_committing_over_a_running_build_parks_the_builds_lanes() {
    let mut rig = Rig::with_track(library("boulevard"));
    let target = faders(&rig.e, 0.9);
    assert_eq!(rig.e.queue_patterns(20, BAR, 1, &drum(2, 16, 0.9)), 0);
    assert_eq!(rig.e.queue_build(1, 4, &target, &[]), 0);
    rig.run_to(37);
    let s = faders(&rig.e, 0.5);
    assert_eq!(rig.e.queue_patterns(22, BAR, 9, &drum(2, 16, 0.6)), 0);
    assert_eq!(rig.e.queue_scene(9, BAR, &s), 0);
    // The scene lands on step 48, on the audio path: the build is replaced there and
    // its lanes withdrawn there, and nothing may be freed doing it.
    rig.run_to(52);
    assert!(rig.allocs.is_empty(), "allocated: {:?}", rig.allocs);
    assert!(rig.saw(event::BUILD_REPLACED, 1) && rig.saw(event::PATTERNS_CANCELLED, 20));
    assert!(rig.saw(event::PATTERNS_APPLIED, 22) && rig.saw(event::SCENE_APPLIED, 9));
}

/// Beat Repeat (Night 10, kind 3): its slice buffer is allocated with the engine, so
/// holding one through every division (each change captures again), alongside Filter
/// Hold and Echo Throw, through its lease renewals, a seek, the release and a second
/// hold, allocates and frees nothing. The gesture calls are counted too.
#[test]
fn a_held_beat_repeat_across_divisions_allocates_and_frees_nothing() {
    use bckgrnd_msc_engine::perform::kind;
    let mut rig = Rig::with_track(library("warehouse"));
    assert!(rig.call("begin", |e| e.gesture_begin(30, kind::BEAT_REPEAT)));
    assert!(rig.call("begin", |e| e.gesture_begin(31, kind::FILTER_HOLD)));
    assert!(rig.call("begin", |e| e.gesture_begin(32, kind::ECHO_THROW)));
    for d in [8u8, 4, 16, 8] {
        assert!(rig.call("division", |e| e.set_repeat_division(d)));
        for _ in 0..(48_000 / 128) {
            rig.block();
        }
        assert!(rig.e.repeat_looping(), "1/{d} never looped");
        assert!(rig.call("renew", |e| e.gesture_renew(30)));
        rig.call("renew", |e| e.gesture_renew(31));
        rig.call("renew", |e| e.gesture_renew(32));
    }
    rig.call("seek", |e| e.jump(64));
    for _ in 0..200 {
        rig.block();
    }
    assert!(rig.call("end", |e| e.gesture_end(30)));
    for _ in 0..50 {
        rig.block();
    }
    assert!(rig.call("begin", |e| e.gesture_begin(33, kind::BEAT_REPEAT)));
    for _ in 0..400 {
        rig.block();
    }
    rig.call("release fx", |e| e.release_gestures());
    for _ in 0..50 {
        rig.block();
    }
    assert!(rig.allocs.is_empty(), "allocated: {:?}", rig.allocs);
}
