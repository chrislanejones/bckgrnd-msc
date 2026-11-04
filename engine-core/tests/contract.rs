//! The engine agrees with `contracts/parameters.json`.
//!
//! The registry is what the UI builds its controls from and what a saved project is
//! clamped to. If the engine's own default or range for a parameter drifts from it, a
//! knob at "default" would not be the engine's default, and a value the UI allows
//! could be one the engine quietly clamps. This reads the file and holds every
//! engine-side constant against it.

use bckgrnd_msc_engine::{limits, Engine, Master, Stem};
use serde_json::Value;

fn registry() -> Value {
    let raw = std::fs::read_to_string(format!(
        "{}/../contracts/parameters.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("contracts/parameters.json");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn param(id: &str) -> Value {
    registry()["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or_else(|| panic!("{id} is not in the registry"))
        .clone()
}

fn num(v: &Value) -> f32 {
    v.as_f64().unwrap_or_else(|| panic!("{v} is not a number")) as f32
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-6
}

#[test]
fn defaults_and_ranges_match_the_engine() {
    let cases: [(&str, f32, f32, f32); 6] = [
        (
            "fx.filterQ",
            limits::FILTER_Q,
            limits::FILTER_Q_MIN,
            limits::FILTER_Q_MAX,
        ),
        (
            "fx.echoFeedback",
            limits::ECHO_FEEDBACK,
            0.0,
            limits::ECHO_FEEDBACK_MAX,
        ),
        ("fx.echoReturn", limits::ECHO_RETURN, 0.0, 1.0),
        ("fx.reverbMix", limits::VERB_WET, 0.0, limits::VERB_WET_MAX),
        (
            "fx.reverbDecay",
            limits::ROOM_RT60,
            limits::ROOM_RT60_MIN,
            limits::ROOM_RT60_MAX,
        ),
        ("fx.width", 1.0, 0.0, limits::WIDTH_MAX),
    ];
    for (id, default, min, max) in cases {
        let p = param(id);
        assert!(
            close(num(&p["default"]), default),
            "{id} default: registry {} engine {default}",
            p["default"]
        );
        assert!(
            close(num(&p["min"]), min),
            "{id} min: registry {} engine {min}",
            p["min"]
        );
        assert!(
            close(num(&p["max"]), max),
            "{id} max: registry {} engine {max}",
            p["max"]
        );
    }
}

#[test]
fn every_stem_send_default_matches_the_engine() {
    let send = registry()["stemParameters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "send")
        .expect("send")
        .clone();
    for stem in Stem::ALL {
        let name = format!("{stem:?}").to_lowercase();
        let registry = num(&send["defaults"][&name]);
        assert!(
            close(registry, stem.send()),
            "{name} send: registry {registry} engine {}",
            stem.send()
        );
    }
    // And a fresh engine starts there.
    let e = Engine::new(48_000.0);
    for stem in Stem::ALL {
        assert!(close(e.sends()[stem.index()], stem.send()));
    }
}

#[test]
fn the_filter_maps_as_the_ui_displays_it() {
    // The UI shows the filter position as a frequency with 240 * 75^open, and turns
    // a typed frequency back into a position with the inverse. Both ends must agree.
    let p = param("fx.filter");
    assert_eq!(p["taper"], "engine");
    assert!(close(Master::filter_freq(0.0), 240.0));
    assert!((Master::filter_freq(1.0) - 18_000.0).abs() < 0.5);
    let open = (1_000.0f32 / 240.0).ln() / (18_000.0f32 / 240.0).ln();
    assert!((Master::filter_freq(open) - 1_000.0).abs() < 0.5);
}

#[test]
fn the_pattern_lanes_and_limits_match_the_engine() {
    // contracts/patterns.json names each lane's engine index and kind; the engine's
    // payload parser (patterns.rs) relies on drum lanes being 0..4 and note lanes 4..9,
    // and on six pitches per note.
    let raw = std::fs::read_to_string(format!(
        "{}/../contracts/patterns.json",
        env!("CARGO_MANIFEST_DIR")
    ))
    .expect("contracts/patterns.json");
    let reg: Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(reg["steps"], 256);
    assert_eq!(reg["maxNotes"], 6);
    let lanes = reg["lanes"].as_array().unwrap();
    assert_eq!(lanes.len(), 9);
    for (i, lane) in lanes.iter().enumerate() {
        assert_eq!(lane["engine"], i, "{} is engine lane {i}", lane["id"]);
        let kind = if i < 4 { "drum" } else { "notes" };
        assert_eq!(lane["kind"], kind, "{} kind", lane["id"]);
    }
    let order: Vec<&str> = lanes.iter().map(|l| l["id"].as_str().unwrap()).collect();
    assert_eq!(
        order,
        ["kick", "clap", "hat", "hatOpen", "bass", "stab", "lead", "pad", "arp"]
    );
}
