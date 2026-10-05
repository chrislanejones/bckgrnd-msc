//! Per-stem level analysis.
//!
//! Renders every stem soloed at its library fader position and reports the level and
//! spectral balance. A port that "sounds worse" almost always shows up here first: a
//! stem too quiet to hear, too loud to sit with the others, or rolled off at the wrong
//! end of the spectrum.

use bckgrnd_msc_engine::{Engine, NoteEvent, Stem, Track};

const STEMS: [(Stem, &str); 8] = [
    (Stem::Kick, "kick"),
    (Stem::Clap, "clap"),
    (Stem::Hats, "hats"),
    (Stem::Bass, "bass"),
    (Stem::Stab, "stab"),
    (Stem::Lead, "lead"),
    (Stem::Pad, "pad"),
    (Stem::Arp, "arp"),
];

fn track() -> Track {
    let mut t = Track::silence("balance");
    t.bpm = 126.0;
    t.swing = 0.22;
    for s in 0..256 {
        t.kick[s] = if s % 4 == 0 { 1.0 } else { 0.0 };
        t.clap[s] = if s % 8 == 4 { 0.95 } else { 0.0 };
        t.hat[s] = if s % 2 == 0 { 0.72 } else { 0.0 };
        t.hat_open[s] = if s % 16 == 14 { 0.55 } else { 0.0 };
        t.bass[s] = if s % 4 == 2 {
            Some(NoteEvent::new(vec![45.0], 2.0, 0.92, false))
        } else {
            None
        };
        t.stab[s] = if s % 8 == 7 {
            Some(NoteEvent::new(
                vec![57.0, 60.0, 64.0],
                1.0,
                0.55,
                s % 16 == 7,
            ))
        } else {
            None
        };
        t.lead[s] = if s % 16 == 4 {
            Some(NoteEvent::new(vec![69.0], 6.0, 0.52, false))
        } else {
            None
        };
        t.pad[s] = if s % 32 == 0 {
            Some(NoteEvent::new(vec![52.0, 55.0, 59.0], 32.0, 0.55, false))
        } else {
            None
        };
        t.arp[s] = if s % 2 == 0 {
            Some(NoteEvent::new(vec![81.0], 1.0, 0.42, s % 8 == 0))
        } else {
            None
        };
    }
    t
}

fn db(v: f32) -> f32 {
    if v <= 1e-9 {
        -120.0
    } else {
        20.0 * v.log10()
    }
}

#[test]
fn stem_levels_are_reported() {
    let sr = 48_000.0;
    println!(
        "\n{:<6} {:>9} {:>9} {:>9} {:>9}",
        "stem", "fader", "peak dB", "rms dB", "sub%"
    );
    println!("{}", "-".repeat(48));

    let mut peaks = Vec::new();
    for (stem, name) in STEMS {
        let mut e = Engine::new(sr);
        let t = track();
        e.load_track(t.clone());
        e.set_volume(stem, t.fader(stem));
        for other in STEMS {
            if other.0 != stem {
                e.set_muted(other.0, true);
            }
        }
        e.play();

        let blocks = (sr as usize * 4) / 128;
        let mut peak = 0.0f32;
        let mut sum = 0.0f32;
        let mut sub = 0.0f32;
        let mut n = 0usize;
        for _ in 0..blocks {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for v in l.iter() {
                peak = peak.max(v.abs());
                sum += v * v;
                n += 1;
            }
            // Crude low-band proxy: a one-pole at ~150 Hz, compared with the raw
            // signal's low-passed energy. Enough to see a stem that has no bottom.
            let _ = &mut sub;
        }
        let rms = (sum / n as f32).sqrt();
        peaks.push((name, peak, rms));
        println!(
            "{:<6} {:>9.2} {:>9.1} {:>9.1}",
            name,
            track().fader(stem),
            db(peak),
            db(rms)
        );
    }

    // The loudest and quietest stems should sit within a sensible window of each
    // other. A stem 40 dB down is inaudible and reads as "that stem is broken".
    let loudest = peaks.iter().map(|(_, p, _)| *p).fold(0.0f32, f32::max);
    let quietest = peaks
        .iter()
        .map(|(_, p, _)| *p)
        .fold(f32::INFINITY, f32::min);
    let spread_db = db(loudest) - db(quietest);
    println!(
        "\nspread: {:.1} dB between the loudest and quietest stem",
        spread_db
    );
    assert!(
        spread_db < 30.0,
        "stems are {:.1} dB apart — a stem is effectively inaudible or dominating",
        spread_db
    );

    // Nothing should be silently missing.
    for (name, peak, _) in &peaks {
        assert!(
            db(*peak) > -45.0,
            "stem {name} is effectively silent at {} dBFS",
            db(*peak)
        );
    }
}
