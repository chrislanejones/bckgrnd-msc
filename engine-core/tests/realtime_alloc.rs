//! The audio path neither allocates nor frees (ADR-016, `docs/NIGHT7_PROTOCOL.md`).
//!
//! A counting global allocator, armed only around `Engine::process` and the event
//! drain the worklet does inside its render callback. Every scenario here moves pattern
//! lanes at a boundary, which is where an allocation or a free would hide: a scene
//! landing with its lanes, a build ending with its lanes and a landing scene, a scene
//! committing over a running build (the build's lanes are parked, not dropped), and a
//! refused request arriving while a scene with lanes is pending (the Night 7B staging
//! slot). Requests are made unarmed: message handlers may allocate.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use bckgrnd_msc_engine::scene::{EVENT_CAPACITY, EVENT_WIDTH};
use bckgrnd_msc_engine::{Engine, Track, STEPS};

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static ALLOCS: Cell<u64> = const { Cell::new(0) };
    static FREES: Cell<u64> = const { Cell::new(0) };
}

struct Counting;

fn count(counter: &'static std::thread::LocalKey<Cell<u64>>) {
    // `try_with`: the allocator also runs while a thread is being torn down.
    if ARMED.try_with(Cell::get).unwrap_or(false) {
        let _ = counter.try_with(|c| c.set(c.get() + 1));
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(&ALLOCS);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count(&FREES);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count(&ALLOCS);
        count(&FREES);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const SCENE_LEN: usize = 44;
const BAR: u8 = 2;

fn track(name: &str) -> Track {
    let path = format!(
        "{}/../public/library/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("the track")).expect("json");
    serde_json::from_value(doc["track"].clone()).expect("a track")
}

/// A payload replacing drum lane `index` with one hit.
fn drum(index: usize, step: usize, velocity: f32) -> Vec<f32> {
    let mut out = vec![1.0, index as f32, 0.0, STEPS as f32];
    let mut lane = vec![0.0f32; STEPS];
    lane[step] = velocity;
    out.extend(lane);
    out
}

/// The engine's own base with every fader at `level`: always a valid scene.
fn scene(e: &Engine, level: f32) -> Vec<f32> {
    let mut v = vec![0.0f32; SCENE_LEN];
    assert!(e.base_into(&mut v));
    for stem in 0..8 {
        v[stem * 4] = level;
    }
    v
}

struct Rig {
    e: Engine,
    l: [f32; 128],
    r: [f32; 128],
    events: Vec<f64>,
    seen: Vec<[f64; 4]>,
}

impl Rig {
    fn new(name: &str) -> Self {
        let mut e = Engine::new(48_000.0);
        e.load_track(track(name));
        e.play();
        let mut rig = Rig {
            e,
            l: [0.0; 128],
            r: [0.0; 128],
            events: vec![0.0; EVENT_CAPACITY * EVENT_WIDTH],
            seen: Vec::with_capacity(4096),
        };
        // Past the first notes, so voices and buses are warm before anything is counted.
        rig.run_to(3);
        rig.seen.clear();
        rig
    }

    /// Render until `step` has been reached, counting every allocation and free made
    /// by `process` and the event drain. Returns (allocations, frees).
    fn run_to(&mut self, step: i32) -> (u64, u64) {
        ALLOCS.with(|c| c.set(0));
        FREES.with(|c| c.set(0));
        for _ in 0..(48_000 * 120 / 128) {
            if self.e.visual_step() >= step {
                break;
            }
            ARMED.with(|a| a.set(true));
            self.e.process(&mut self.l, &mut self.r);
            let n = self.e.take_events_into(&mut self.events) as usize;
            ARMED.with(|a| a.set(false));
            for k in 0..n {
                let at = k * EVENT_WIDTH;
                // `seen` was reserved up front; this push is outside the armed window.
                self.seen.push([
                    self.events[at],
                    self.events[at + 1],
                    self.events[at + 2],
                    self.events[at + 3],
                ]);
            }
        }
        assert!(self.e.visual_step() >= step, "never reached step {step}");
        (ALLOCS.with(Cell::get), FREES.with(Cell::get))
    }

    fn saw(&self, kind: f64, id: f64) -> bool {
        self.seen.iter().any(|x| x[0] == kind && x[1] == id)
    }
}

const PATTERNS_APPLIED: f64 = 32.0;
const PATTERNS_CANCELLED: f64 = 33.0;
const SCENE_APPLIED: f64 = 2.0;
const BUILD_APPLIED: f64 = 42.0;
const BUILD_REPLACED: f64 = 44.0;

#[test]
fn the_counter_counts() {
    ALLOCS.with(|c| c.set(0));
    FREES.with(|c| c.set(0));
    ARMED.with(|a| a.set(true));
    let v = std::hint::black_box(vec![1u8; 64]);
    drop(v);
    ARMED.with(|a| a.set(false));
    assert_eq!((ALLOCS.with(Cell::get), FREES.with(Cell::get)), (1, 1));
}

#[test]
fn a_scene_landing_with_its_lanes_allocates_and_frees_nothing() {
    let mut rig = Rig::new("warehouse");
    assert_eq!(rig.e.queue_patterns(20, BAR, 10, &drum(2, 16, 0.9)), 0);
    let s = scene(&rig.e, 0.5);
    assert_eq!(rig.e.queue_scene(10, BAR, &s), 0);
    assert_eq!(rig.run_to(20), (0, 0));
    assert!(rig.saw(PATTERNS_APPLIED, 20.0) && rig.saw(SCENE_APPLIED, 10.0));
}

#[test]
fn a_refused_request_over_a_pending_scene_allocates_and_frees_nothing_on_the_audio_path() {
    let mut rig = Rig::new("warehouse");
    assert_eq!(rig.e.queue_patterns(20, BAR, 10, &drum(2, 16, 0.9)), 0);
    let s = scene(&rig.e, 0.5);
    assert_eq!(rig.e.queue_scene(10, BAR, &s), 0);
    // A scene and a build, each with lanes, each refused: staged lanes are withdrawn
    // in the message handler, and the pending scene keeps its own.
    assert_eq!(rig.e.queue_patterns(21, BAR, 11, &drum(2, 16, 0.1)), 0);
    assert_ne!(rig.e.queue_scene(11, 9, &s), 0);
    assert_eq!(rig.e.queue_patterns(22, BAR, 12, &drum(2, 16, 0.2)), 0);
    assert_ne!(rig.e.queue_build(12, 3, &s, &[]), 0);
    assert_eq!(rig.run_to(20), (0, 0));
    assert!(rig.saw(PATTERNS_CANCELLED, 21.0) && rig.saw(PATTERNS_CANCELLED, 22.0));
    assert!(
        rig.saw(PATTERNS_APPLIED, 20.0) && rig.saw(SCENE_APPLIED, 10.0),
        "the pending scene landed with its lanes: {:?}",
        rig.seen
    );
}

#[test]
fn a_build_ending_with_lanes_and_a_landing_scene_allocates_and_frees_nothing() {
    for bars in [2u32, 4, 8] {
        let mut rig = Rig::new("cipher");
        let target = scene(&rig.e, 0.9);
        let land = scene(&rig.e, 0.4);
        assert_eq!(rig.e.queue_patterns(20, BAR, 1, &drum(2, 16, 0.9)), 0);
        assert_eq!(rig.e.queue_build(1, bars, &target, &land), 0);
        let end = 16 + bars as i32 * 16;
        assert_eq!(rig.run_to(end + 4), (0, 0), "{bars} bars");
        assert!(
            rig.saw(BUILD_APPLIED, 1.0) && rig.saw(PATTERNS_APPLIED, 20.0),
            "{bars} bars"
        );
    }
}

#[test]
fn a_scene_committing_over_a_running_build_parks_the_builds_lanes() {
    let mut rig = Rig::new("boulevard");
    let target = scene(&rig.e, 0.9);
    assert_eq!(rig.e.queue_patterns(20, BAR, 1, &drum(2, 16, 0.9)), 0);
    assert_eq!(rig.e.queue_build(1, 4, &target, &[]), 0);
    assert_eq!(rig.run_to(37), (0, 0));
    let s = scene(&rig.e, 0.5);
    assert_eq!(rig.e.queue_patterns(22, BAR, 9, &drum(2, 16, 0.6)), 0);
    assert_eq!(rig.e.queue_scene(9, BAR, &s), 0);
    // The scene lands on step 48, on the audio path: the build is replaced there and
    // its lanes withdrawn there, and nothing may be freed doing it.
    assert_eq!(rig.run_to(52), (0, 0));
    assert!(rig.saw(BUILD_REPLACED, 1.0) && rig.saw(PATTERNS_CANCELLED, 20.0));
    assert!(rig.saw(PATTERNS_APPLIED, 22.0) && rig.saw(SCENE_APPLIED, 9.0));
}

/// Every library track, from the top, through fifteen of its sixteen bars: drums, percussion,
/// every tuned stem and the section seams. Note voices are built on the audio path,
/// so this is the test that keeps them off the heap.
#[test]
fn every_library_track_plays_without_allocating_or_freeing() {
    let dir = format!("{}/../public/library", env!("CARGO_MANIFEST_DIR"));
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("the library")
        .map(|e| e.expect("an entry").path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .map(|p| p.file_stem().unwrap().to_string_lossy().to_string())
        .filter(|n| n != "index")
        .collect();
    names.sort();
    assert_eq!(names.len(), 20, "the library is 20 tracks");
    for name in names {
        let mut rig = Rig::new(&name);
        assert_eq!(rig.run_to(15 * 16), (0, 0), "{name}");
    }
}
