//! Which stems actually make sound, across the real library.
//!
//! Uses the same arrangement JSON the backend serves, so this covers the tracks as
//! they actually ship rather than a synthetic pattern. Each stem is rendered soloed
//! over the whole 16-bar song: a stem that is silent here is either missing from the
//! arrangement, muted by the fader, or never spawned by the engine.

use std::collections::BTreeMap;

use bckgrnd_msc_engine::{Engine, Stem, Track};

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

fn library() -> BTreeMap<String, Track> {
    let raw = std::fs::read_to_string(format!(
        "{}/../tools/reference.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("reference.json");
    serde_json::from_str(&raw).expect("tracks")
}

/// Peak and RMS for one stem of one track, soloed, over the whole song.
///
/// A fixed wall-clock window is wrong here: it silently truncates the arrangement.
/// The intro withholds the chords, lead and arpeggio by design, so at 126 BPM an
/// 8-second window only reaches step ~67 and the groove — where those stems enter —
/// is never heard. Measuring a fixed number of *steps* covers the form at any tempo.
fn measure(track: &Track, stem: Stem) -> (f32, f32) {
    let sr = 48_000.0;
    let mut e = Engine::new(sr);
    e.load_track(track.clone());
    for other in STEMS {
        e.set_muted(other.0, other.0 != stem);
    }
    e.play();

    // Sixteen bars of 4/4, derived from the track's own tempo.
    let seconds = 16.0 * 4.0 * (60.0 / track.bpm.max(40.0));
    let blocks = (sr as usize * seconds as usize) / 128;
    let mut peak = 0.0f32;
    let mut sum = 0.0f32;
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
    }
    (peak, (sum / n.max(1) as f32).sqrt())
}

#[test]
fn every_stem_sounds_on_every_track() {
    let library = library();
    println!("\n{:<10}", "track");
    for (_, name) in STEMS {
        print!("{:>9}", name);
    }
    println!("   (peak dBFS, soloed)");

    let mut dead: Vec<String> = Vec::new();

    for (id, track) in &library {
        print!("{:<10}", id);
        for (stem, name) in STEMS {
            let (peak, _) = measure(track, stem);
            let db = if peak <= 1e-9 {
                -120.0
            } else {
                20.0 * peak.log10()
            };
            print!("{:>9}", format!("{db:.0}"));
            if db < -50.0 {
                dead.push(format!("{id}/{name} ({db:.0} dBFS)"));
            }
        }
        println!();
    }

    assert!(
        dead.is_empty(),
        "these stems never sounded:\n  {}",
        dead.join("\n  ")
    );
}

#[test]
fn each_stem_has_its_own_fader() {
    // The Cut button and the fader both address one channel strip, so a stem's level
    // must be controlled by *its own* fader and no other. Soloing a stem and pulling
    // that stem's fader to zero must silence it, and nothing else.
    //
    // (The weaker claim — "muting any stem lowers total RMS" — is false here, and
    // deliberately so. The master saturator is `tanh(x)/tanh(1.35)`, near-linear for
    // small inputs and limiting for large ones, so removing a loud stem can move the
    // rest of the mix into the boost region and raise overall RMS slightly.)
    let library = library();
    let track = &library["warehouse"];
    // Sixteen bars of the track's own tempo, so every stem's entrance is covered. A
    // fixed 8-second window stops at step ~67 and the groove — where the chords enter —
    // is never reached.
    let blocks = (48_000.0 * 16.0 * 4.0 * (60.0 / track.bpm.max(40.0))) as usize / 128;

    for (stem, name) in STEMS {
        // `upto` is the last step measured. The transition sounds at the Break and the
        // Drop are summed into the master outside every stem, the way the backspin
        // is, so a stem's own fader is checked against silence only before step 128,
        // where none of them sound. Every stem has entered by then.
        let render = |gain: f32, upto: i32| -> f32 {
            let mut e = Engine::new(48_000.0);
            e.load_track(track.clone());
            for other in STEMS {
                e.set_muted(other.0, other.0 != stem);
            }
            e.set_volume(stem, gain);
            e.play();
            let mut peak = 0.0f32;
            for _ in 0..blocks {
                let mut l = [0.0f32; 128];
                let mut r = [0.0f32; 128];
                e.process(&mut l, &mut r);
                if e.visual_step() > upto {
                    break;
                }
                for v in l.iter() {
                    peak = peak.max(v.abs());
                }
            }
            peak
        };

        let up = render(1.0, 255);
        let down = render(0.0, 127);

        assert!(
            up > 0.02,
            "{name}: soloed at unity it is inaudible (peak {up:.4})"
        );
        assert_eq!(
            down, 0.0,
            "{name}: its own fader at zero did not silence it ({down:.6})"
        );
    }
}
