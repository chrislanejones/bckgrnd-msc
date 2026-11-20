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
//! - `lanes`: `build`, with every build carrying linked pattern lanes (the kick and
//!   hat lanes, alternating between two versions) that swap in on its end onset. The
//!   lanes are staged with `queue_patterns` just before each build, as the worklet does.
//! - `fills`: back-to-back Fill into (`docs/NIGHT8_PROTOCOL.md`) on a 2-bar phrase,
//!   each queued again as soon as nothing is pending, alternating between the two
//!   targets, so a linked fill and scene are waiting or playing nearly all the time.
//! - `night3`: the control for `fills`, the same music through Night 3 calls: a plain
//!   next-bar fill queued as soon as none is pending (so one bar in two, as `fills`),
//!   and a Next Bar scene queued on the onset it starts, so it lands where it ends.
//!   `fills` against `night3` is the cost of the linking, not of what plays.
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
/// `patterns applied`, as it comes out of the event ring.
const PATTERNS_APPLIED: f64 = bckgrnd_msc_engine::scene::event::PATTERNS_APPLIED as f64;

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
    Lanes,
    Fills,
    Night3,
}

impl Case {
    fn name(self) -> &'static str {
        match self {
            Case::Plain => "plain",
            Case::Build => "build",
            Case::Lanes => "lanes",
            Case::Fills => "fills",
            Case::Night3 => "night3",
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

/// A pattern payload (`docs/NIGHT4_PROTOCOL.md`) setting the kick lane to four on the
/// floor and the closed hat to `hat` on every off-beat eighth.
fn drum_payload(hat: f32) -> Vec<f32> {
    let steps = bckgrnd_msc_engine::STEPS;
    let mut out = vec![2.0];
    out.extend([0.0, 0.0, steps as f32]);
    out.extend((0..steps).map(|s| if s % 4 == 0 { 1.0 } else { 0.0 }));
    out.extend([2.0, 0.0, steps as f32]);
    out.extend((0..steps).map(|s| if s % 4 == 2 { hat } else { 0.0 }));
    out
}

/// Render one run of `case`, returning the time spent in `process` and the build
/// glue around it (not the engine's construction or the track load).
fn run(case: Case, track: &Track) -> Duration {
    let mut e = Engine::new(SR);
    let mut track = track.clone();
    if track.fills.is_empty() {
        track.fills = vec![bckgrnd_msc_engine::Fill {
            kick: vec![0.0; 16],
            clap: vec![0.7; 16],
            hat: vec![0.3; 16],
            hat_open: Vec::new(),
        }];
    }
    e.load_track(track);
    e.play();
    let (rise, back) = targets(&e);
    let mut l = [0.0f32; BLOCK];
    let mut r = [0.0f32; BLOCK];
    let mut events = [0.0f64; 4 * 64];
    let blocks = SR as usize * SECONDS / BLOCK;
    let mut next_id = 1u32;
    let payloads = [drum_payload(0.6), drum_payload(0.3)];
    let mut lanes_applied = 0usize;
    let mut scene_sent = false;

    let started = Instant::now();
    for _ in 0..blocks {
        if let Case::Build | Case::Lanes = case {
            if e.pending_build().is_none() && e.active_build().is_none() {
                if let Case::Lanes = case {
                    let data = &payloads[next_id as usize % 2];
                    let verdict = e.queue_patterns(next_id + 1000, 2, next_id, data);
                    assert_eq!(verdict, 0, "lanes for build {next_id} refused");
                }
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
        if let Case::Fills = case {
            if e.pending_fill().is_none() && e.active_fill().is_none() {
                let target: &[f32] = if next_id % 2 == 1 { &rise } else { &back };
                let verdict = e.queue_fill_into(next_id, 0, 2, 0, next_id + 1000, target);
                assert_eq!(verdict, 0, "fill into {next_id} refused");
                next_id += 1;
            }
        }
        if let Case::Night3 = case {
            if e.pending_fill().is_none() && e.active_fill().is_none() {
                assert_eq!(e.queue_fill(next_id, 0), 0, "fill {next_id} refused");
                next_id += 1;
            }
            if e.active_fill().is_some() && e.pending_scene().is_none() && !scene_sent {
                let target: &[f32] = if next_id % 2 == 1 { &rise } else { &back };
                assert_eq!(e.queue_scene(next_id + 1000, 2, target), 0);
                scene_sent = true;
            }
            if e.active_fill().is_none() {
                scene_sent = false;
            }
        }
        e.process(&mut l, &mut r);
        while e.event_count() > 0 {
            let n = e.take_events_into(&mut events) as usize;
            lanes_applied += events.as_chunks::<4>().0[..n]
                .iter()
                .filter(|ev| ev[0] == PATTERNS_APPLIED)
                .count();
        }
        black_box((&l, &r));
    }
    let spent = started.elapsed();
    if let Case::Build | Case::Lanes | Case::Fills | Case::Night3 = case {
        assert!(next_id > 4, "only {} requests ran", next_id - 1);
    }
    if let Case::Lanes = case {
        assert!(lanes_applied >= 3, "only {lanes_applied} lane sets landed");
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
    for case in [
        Case::Plain,
        Case::Build,
        Case::Lanes,
        Case::Fills,
        Case::Night3,
    ] {
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
