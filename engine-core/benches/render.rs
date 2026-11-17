//! Render bench: 60 s of a library track at 48 kHz in 128-frame blocks, the block
//! size an `AudioWorkletProcessor` gets. No bench framework (the crate takes no new
//! dependencies for it): each case is timed with `std::time::Instant`, seven runs,
//! and the best is reported, which is the least disturbed by whatever else the machine
//! is doing.
//!
//! ```text
//! cargo bench --bench render
//! ```
//!
//! Cases:
//!
//! - `plain`: Warehouse playing, nothing queued.
//! - `build`: the same, with back-to-back 8-bar timed builds (`docs/NIGHT7_PROTOCOL.md`),
//!   each queued again on the onset the last one ends, alternating between two targets
//!   and landing a scene on every other one. The next one starts on the following bar
//!   line, so the build path runs on 8 of every 9 bars.
//!
//! Events are drained every block, as the worklet does.

use std::hint::black_box;
use std::time::{Duration, Instant};

use bckgrnd_msc_engine::scene::SCENE_LEN;
use bckgrnd_msc_engine::{Engine, Track};

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;
const SECONDS: usize = 60;
const RUNS: usize = 7;

/// The library track the bench plays, by id, from the same arrangement JSON the
/// backend serves and the integration tests read.
fn warehouse() -> Track {
    let path = format!("{}/../tools/reference.json", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let mut tracks: std::collections::BTreeMap<String, Track> =
        serde_json::from_str(&raw).expect("reference.json deserializes as tracks");
    tracks
        .remove("warehouse")
        .expect("warehouse is in the library")
}

/// What each case does between blocks.
#[derive(Clone, Copy)]
enum Case {
    Plain,
    Build,
}

impl Case {
    fn name(self) -> &'static str {
        match self {
            Case::Plain => "plain",
            Case::Build => "build",
        }
    }
}

/// Two build targets a long way apart, from the engine's own starting base: the
/// filter closing with the room and the sends up, and the base back again.
fn targets(e: &Engine) -> ([f32; SCENE_LEN], [f32; SCENE_LEN]) {
    let mut base = [0.0f32; SCENE_LEN];
    assert!(e.base_into(&mut base));
    let mut rise = base;
    let fx = bckgrnd_msc_engine::scene::FX_BASE;
    rise[fx] = 0.2; // filter
    rise[fx + 2] = 0.4; // low isolator
    rise[fx + 6] = 0.5; // echo feedback
    rise[fx + 8] = 0.4; // room mix
    for stem in 0..8 {
        rise[stem * 4 + 1] = 0.5; // send
    }
    rise[0] = 0.3; // kick fader
    (rise, base)
}

/// Render one run of `case`, returning the time spent in `process` and the build
/// glue around it (not the engine's construction or the track load).
fn run(case: Case, track: &Track) -> Duration {
    let mut e = Engine::new(SR);
    e.load_track(track.clone());
    e.play();
    let (rise, back) = targets(&e);
    let mut l = [0.0f32; BLOCK];
    let mut r = [0.0f32; BLOCK];
    let mut events = [0.0f64; 4 * 64];
    let blocks = SR as usize * SECONDS / BLOCK;
    let mut next_id = 1u32;

    let started = Instant::now();
    for _ in 0..blocks {
        if let Case::Build = case {
            if e.pending_build().is_none() && e.active_build().is_none() {
                let (target, land): (&[f32], &[f32]) = if next_id % 2 == 1 {
                    (&rise, &[])
                } else {
                    (&back, &back)
                };
                let verdict = e.queue_build(next_id, 8, target, land);
                assert_eq!(verdict, 0, "build {next_id} refused");
                next_id += 1;
            }
        }
        e.process(&mut l, &mut r);
        while e.event_count() > 0 {
            e.take_events_into(&mut events);
        }
        black_box((&l, &r));
    }
    let spent = started.elapsed();
    if let Case::Build = case {
        assert!(next_id > 4, "only {} builds ran", next_id - 1);
    }
    spent
}

fn main() {
    // `cargo bench` passes `--bench`; `cargo test --all-targets` does not, and a
    // minute of rendering per case has no place in the test run.
    if !std::env::args().any(|a| a == "--bench") {
        println!("render bench: skipped (run it with `cargo bench --bench render`)");
        return;
    }
    let track = warehouse();
    println!(
        "render: {} s of Warehouse at {} Hz in {}-frame blocks, best of {}",
        SECONDS, SR as u32, BLOCK, RUNS
    );
    for case in [Case::Plain, Case::Build] {
        let mut times: Vec<Duration> = (0..RUNS).map(|_| run(case, &track)).collect();
        times.sort();
        let best = times[0].as_secs_f64() * 1e3;
        let median = times[RUNS / 2].as_secs_f64() * 1e3;
        println!(
            "{:<6} best {:>8.1} ms  median {:>8.1} ms  ({:.0}x real time)",
            case.name(),
            best,
            median,
            SECONDS as f64 * 1e3 / best
        );
    }
}
