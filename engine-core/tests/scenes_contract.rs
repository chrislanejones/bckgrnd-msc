//! The engine's scene vector agrees with `contracts/scenes.json` and
//! `contracts/parameters.json`.
//!
//! The UI builds the 44-value vector from `sceneVector`, and the engine reads indices
//! 32..43 in its own order. If the two lists drift, a scene sets the wrong effect: the
//! filter lands on the resonance, and nothing errors. The validator's ranges have the
//! same problem against the registry, so both are held to the files here.

use bckgrnd_msc_engine::scene::{
    slot_kind, SlotKind, ECHO_TIME_OPTIONS, FX_BASE, SCENE_LEN, SCENE_PARAMS, STEM_FIELDS,
};
use bckgrnd_msc_engine::Stem;
use serde_json::Value;

fn read(name: &str) -> Value {
    let raw = std::fs::read_to_string(format!(
        "{}/../contracts/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap_or_else(|_| panic!("contracts/{name}"));
    serde_json::from_str(&raw).expect("valid JSON")
}

fn num(v: &Value) -> f32 {
    v.as_f64().unwrap_or_else(|| panic!("{v} is not a number")) as f32
}

#[test]
fn the_scene_vector_order_matches_the_contract() {
    let scenes = read("scenes.json");
    let listed: Vec<&str> = scenes["sceneVector"]
        .as_array()
        .expect("sceneVector")
        .iter()
        .map(|v| v.as_str().expect("a parameter id"))
        .collect();
    assert_eq!(listed, SCENE_PARAMS.to_vec());
    assert_eq!(FX_BASE + SCENE_PARAMS.len(), SCENE_LEN);
}

#[test]
fn the_stem_block_is_the_registry_stems_in_engine_order() {
    let registry = read("parameters.json");
    let stems: Vec<String> = registry["stems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let engine: Vec<String> = Stem::ALL
        .iter()
        .map(|s| format!("{s:?}").to_lowercase())
        .collect();
    assert_eq!(stems, engine);
    assert_eq!(stems.len() * STEM_FIELDS, FX_BASE);
    for (i, s) in Stem::ALL.iter().enumerate() {
        assert_eq!(s.index(), i);
    }
}

#[test]
fn every_slot_range_matches_the_registry() {
    let registry = read("parameters.json");
    let params = registry["parameters"].as_array().unwrap();
    for (k, id) in SCENE_PARAMS.iter().enumerate() {
        let p = params
            .iter()
            .find(|p| p["id"] == *id)
            .unwrap_or_else(|| panic!("{id} is not in the registry"));
        match slot_kind(FX_BASE + k).unwrap() {
            SlotKind::Range { min, max } => {
                assert_eq!(p["kind"], "continuous", "{id}");
                assert!((num(&p["min"]) - min).abs() < 1e-6, "{id} min");
                assert!((num(&p["max"]) - max).abs() < 1e-6, "{id} max");
            }
            SlotKind::EchoTime => {
                assert_eq!(p["kind"], "enum", "{id}");
                let options: Vec<f32> = p["options"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|o| num(&o["value"]))
                    .collect();
                assert_eq!(options, ECHO_TIME_OPTIONS.to_vec(), "{id} options");
            }
            SlotKind::Toggle => panic!("{id} is not a toggle"),
        }
    }

    let stem_params = registry["stemParameters"].as_array().unwrap();
    for (field, id) in ["volume", "send", "muted", "solo"].iter().enumerate() {
        let p = stem_params.iter().find(|p| p["id"] == *id).unwrap();
        for stem in 0..8 {
            let slot = slot_kind(stem * STEM_FIELDS + field).unwrap();
            match slot {
                SlotKind::Range { min, max } => {
                    assert_eq!(p["kind"], "continuous", "{id}");
                    assert!((num(&p["min"]) - min).abs() < 1e-6, "{id} min");
                    assert!((num(&p["max"]) - max).abs() < 1e-6, "{id} max");
                }
                SlotKind::Toggle => assert_eq!(p["kind"], "toggle", "{id}"),
                SlotKind::EchoTime => panic!("{id} is not an echo time"),
            }
        }
    }
    assert!(slot_kind(SCENE_LEN).is_none());
}
