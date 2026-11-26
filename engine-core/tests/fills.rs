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
                    .map(|c| c[..4].to_vec()),
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

/// Night 10: every exported track carries four beat fills beside it (`beatFillStyles`),
/// 16-step bars silent before step 12. Loaded after the four styles, as the host does,
/// each plays through the public API with length 1 on the bar's last beat only: queued
/// from step 3 it starts on 12 (`fill started` b = 12) and ends on the downbeat, 16.
#[test]
fn library_beat_fills_play_the_last_beat_through_the_public_api() {
    let dir = format!("{}/../public/library", env!("CARGO_MANIFEST_DIR"));
    for (name, mut t) in library() {
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(format!("{dir}/{name}.json")).unwrap())
                .unwrap();
        let styles: Vec<bckgrnd_msc_engine::Fill> =
            serde_json::from_value(doc["fillStyles"].clone()).expect("fillStyles");
        let beats: Vec<bckgrnd_msc_engine::Fill> =
            serde_json::from_value(doc["beatFillStyles"].clone()).expect("beatFillStyles");
        assert_eq!((styles.len(), beats.len()), (4, 4), "{name}");
        for f in &beats {
            for lane in [&f.kick, &f.clap, &f.hat, &f.hat_open] {
                assert_eq!(lane.len(), FILL_STEPS, "{name}");
                assert!(
                    lane[..12].iter().all(|v| *v == 0.0),
                    "{name}: silent before 12"
                );
            }
        }
        t.fills = styles.into_iter().chain(beats).collect();
        for i in 4..8u32 {
            let mut e = Engine::new(48_000.0);
            e.load_track(t.clone());
            e.play();
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            while e.visual_step() < 3 {
                e.process(&mut l, &mut r);
            }
            assert_eq!(e.queue_fill_at(1, i, 0, 1), reason::OK, "{name} {i}");
            let mut seen = Vec::new();
            let mut buf = [0.0f64; EVENT_CAPACITY * EVENT_WIDTH];
            for _ in 0..(48_000 * 20 / 128) {
                if e.visual_step() >= 17 {
                    break;
                }
                e.process(&mut l, &mut r);
                let n = e.take_events_into(&mut buf) as usize;
                seen.extend(
                    buf[..n * EVENT_WIDTH]
                        .chunks(EVENT_WIDTH)
                        .map(|c| c[..4].to_vec()),
                );
            }
            assert_eq!(
                seen,
                vec![
                    vec![event::FILL_QUEUED as f64, 1.0, 1.0, 12.0],
                    vec![event::FILL_STARTED as f64, 1.0, 12.0, 12.0],
                    vec![event::FILL_ENDED as f64, 1.0, 16.0, 0.0],
                ],
                "{name} {i}"
            );
        }
    }
}
