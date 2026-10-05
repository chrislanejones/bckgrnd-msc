//! The hand percussion on the real library: the JSON the backend exports carries
//! it, the engine plays it, and it rides the hats stem.

use bckgrnd_msc_engine::{Engine, Perc, Stem, Track};

fn library_track(id: &str) -> Track {
    let raw = std::fs::read_to_string(format!(
        "{}/../public/library/{id}.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap_or_else(|e| panic!("read {id}: {e}"));
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("json");
    serde_json::from_value(doc["track"].clone()).expect("a track")
}

/// Over the Groove (steps 64..128), with only the hats stem up: the hats channel's
/// meter summed per block, and the output RMS.
///
/// The meter shows the channel alone; the output also carries the lo-fi hiss and
/// crackle, which sit outside the stems. The Groove has no transition sounds.
///
/// Rendered a sample at a time, so the meter, which reads the bus once per call,
/// sees every sample rather than the last of each block.
fn groove(track: Track) -> (f32, f32) {
    let mut e = Engine::new(48_000.0);
    e.load_track(track);
    e.set_solo(Stem::Hats, true);
    e.play();
    e.jump(64);
    let (mut meter, mut ss, mut n) = (0.0f32, 0.0f64, 0usize);
    let mut l = [0.0f32; 1];
    let mut r = [0.0f32; 1];
    loop {
        e.process(&mut l, &mut r);
        let at = e.visual_step();
        if at >= 128 {
            break;
        }
        if at >= 64 {
            for (a, b) in l.iter().zip(r.iter()) {
                assert!(a.is_finite() && b.is_finite());
                ss += (0.5 * (a * a + b * b)) as f64;
                n += 1;
            }
            meter += e.levels()[Stem::Hats.index()];
        }
    }
    (meter, (ss / n.max(1) as f64).sqrt() as f32)
}

#[test]
fn the_percussion_tracks_play_it_on_the_hats_stem() {
    for id in [
        "southside",
        "pirate",
        "bricks",
        "ravetape",
        "rain",
        "study",
        "porch",
        "tape",
        "nightbus",
        "kettle",
    ] {
        let track = library_track(id);
        assert!(
            [
                &track.perc.shaker,
                &track.perc.rim,
                &track.perc.conga_hi,
                &track.perc.conga_lo
            ]
            .iter()
            .any(|lane| lane.len() == 256),
            "{id}: no percussion in the export"
        );
        let (with, _) = groove(track.clone());
        let mut bare = track;
        bare.perc = Perc::default();
        let (without, _) = groove(bare);
        assert!(
            with > without * 1.02,
            "{id}: percussion added nothing to the hats stem ({without:.2} -> {with:.2})"
        );
    }
}

/// On the club tracks (no hiss to get in the way), the percussion on its own is
/// quieter than the hats on their own.
#[test]
fn the_percussion_sits_under_the_hats() {
    for id in ["southside", "pirate", "bricks", "ravetape"] {
        let track = library_track(id);
        let mut perc_only = track.clone();
        perc_only.hat = vec![0.0; 256];
        perc_only.hat_open = vec![0.0; 256];
        let mut hats_only = track;
        hats_only.perc = Perc::default();
        let (_, perc) = groove(perc_only);
        let (_, hats) = groove(hats_only);
        println!("PERCRMS {id}: perc {perc:.5} hats {hats:.5}");
        assert!(
            perc > 0.0 && perc < hats,
            "{id}: percussion {perc:.5} over the hats {hats:.5}"
        );
    }
}

#[test]
fn the_four_on_the_floor_tracks_have_none() {
    for id in ["warehouse", "basement", "tunnel", "drive", "glass", "acid"] {
        let t = library_track(id);
        assert!(
            t.perc.shaker.is_empty()
                && t.perc.rim.is_empty()
                && t.perc.conga_hi.is_empty()
                && t.perc.conga_lo.is_empty(),
            "{id} has percussion"
        );
    }
}
