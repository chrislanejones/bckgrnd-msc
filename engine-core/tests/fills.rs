//! The fills on the real library: every exported track carries one, the engine
//! reads it, and through the public API it starts on the next bar and ends sixteen
//! steps later (docs/NIGHT3_PROTOCOL.md, Fills).

use bckgrnd_msc_engine::scene::{event, reason, EVENT_CAPACITY, EVENT_WIDTH};
use bckgrnd_msc_engine::{Engine, Track, FILL_STEPS};

fn library() -> Vec<(String, Track)> {
    let dir = format!("{}/../public/library", env!("CARGO_MANIFEST_DIR"));
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("the library") {
        let path = entry.expect("an entry").path();
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        if name == "index" || path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).expect("json");
        let track = serde_json::from_value(doc["track"].clone()).expect("a track");
        out.push((name, track));
    }
    assert!(!out.is_empty(), "no library tracks found");
    out
}

#[test]
fn every_library_track_has_a_one_bar_fill() {
    for (name, t) in library() {
        assert_eq!(t.fills.len(), 1, "{name}");
        let f = &t.fills[0];
        for lane in [&f.kick, &f.clap, &f.hat, &f.hat_open] {
            assert_eq!(lane.len(), FILL_STEPS, "{name}");
            assert!(lane.iter().all(|v| (0.0..=1.0).contains(v)), "{name}");
        }
    }
}

#[test]
fn a_library_fill_plays_one_bar_through_the_public_api() {
    for (name, t) in library() {
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        while e.visual_step() < 3 {
            e.process(&mut l, &mut r);
        }
        assert_eq!(e.queue_fill(1, 0), reason::OK, "{name}");
        let mut seen = Vec::new();
        let mut buf = [0.0f64; EVENT_CAPACITY * EVENT_WIDTH];
        // Until step 33 has sounded, however slow the track.
        for _ in 0..(48_000 * 20 / 128) {
            if e.visual_step() >= 33 {
                break;
            }
            e.process(&mut l, &mut r);
            let n = e.take_events_into(&mut buf) as usize;
            seen.extend(
                buf[..n * EVENT_WIDTH]
                    .chunks(EVENT_WIDTH)
                    .map(|c| c.to_vec()),
            );
        }
        let kinds = [event::FILL_QUEUED, event::FILL_STARTED, event::FILL_ENDED];
        assert_eq!(
            seen,
            vec![
                vec![kinds[0] as f64, 1.0, 2.0, 16.0],
                vec![kinds[1] as f64, 1.0, 16.0, 0.0],
                vec![kinds[2] as f64, 1.0, 32.0, 0.0],
            ],
            "{name}"
        );
    }
}
