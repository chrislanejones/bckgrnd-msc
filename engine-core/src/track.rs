//! Track model and the stem registry the engine routes through.

use serde::{Deserialize, Serialize};

/// The eight stems, in mixer order. Index into [`Track::mix`] with `as usize`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Stem {
    Kick,
    Clap,
    Hats,
    Bass,
    Stab,
    Lead,
    Pad,
    Arp,
}

impl Stem {
    pub const ALL: [Stem; 8] = [
        Stem::Kick,
        Stem::Clap,
        Stem::Hats,
        Stem::Bass,
        Stem::Stab,
        Stem::Lead,
        Stem::Pad,
        Stem::Arp,
    ];

    /// The stem's name, as used by the JSON contract with the backend.
    pub fn as_str(self) -> &'static str {
        match self {
            Stem::Kick => "kick",
            Stem::Clap => "clap",
            Stem::Hats => "hats",
            Stem::Bass => "bass",
            Stem::Stab => "stab",
            Stem::Lead => "lead",
            Stem::Pad => "pad",
            Stem::Arp => "arp",
        }
    }

    /// Parse a stem name, as used when deserialising the backend's fader map.
    pub fn parse(name: &str) -> Option<Stem> {
        Stem::ALL.iter().copied().find(|s| s.as_str() == name)
    }

    /// The melodic stems that take note events rather than drum hits.
    pub const TUNED: [Stem; 5] = [Stem::Bass, Stem::Stab, Stem::Lead, Stem::Pad, Stem::Arp];

    pub fn index(self) -> usize {
        self as usize
    }

    /// Per-stem delay send, in gain units.
    pub fn send(self) -> f32 {
        match self {
            Stem::Kick | Stem::Bass => 0.0,
            Stem::Clap => 0.05,
            Stem::Hats => 0.06,
            Stem::Stab => 0.16,
            Stem::Pad => 0.2,
            Stem::Lead => 0.3,
            Stem::Arp => 0.28,
        }
    }

    /// Stems that get ducked under the kick, per track flavour.
    pub fn ducks_under(kind: TrackKind) -> &'static [Stem] {
        match kind {
            TrackKind::House | TrackKind::Deep => {
                &[Stem::Bass, Stem::Stab, Stem::Pad, Stem::Lead, Stem::Arp]
            }
            TrackKind::Acid => &[Stem::Pad, Stem::Stab, Stem::Arp],
            TrackKind::Lofi => &[Stem::Bass, Stem::Pad],
        }
    }

    /// How hard the kick pumps the other stems, and how long it takes to recover.
    /// House pumps shallow and fast; lo-fi breathes.
    pub fn duck_shape(kind: TrackKind) -> (f32, f32) {
        let (floor, beats) = match kind {
            TrackKind::Lofi => (0.78, 0.3),
            TrackKind::Deep => (0.42, 0.7),
            TrackKind::Acid => (0.34, 0.55),
            TrackKind::House => (0.22, 0.55),
        };
        (floor, beats)
    }
}

/// Track flavour, which selects the voicing, filter and decay character per stem.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    House,
    Deep,
    Acid,
    Lofi,
}

/// Fader position for all eight stems.
///
/// Deserialises from either a JSON object keyed by stem name (`{"kick": 0.9, ...}`)
/// or a plain sequence in [`Stem::ALL`] order. The backend emits the keyed form,
/// which is the one to prefer: a positional array is silently corrupted if the two
/// languages ever disagree about stem order, whereas a misnamed key is a loud error.
#[derive(Clone, Debug, PartialEq)]
pub struct Mix(pub [f32; 8]);

impl Mix {
    pub fn get(&self, stem: Stem) -> f32 {
        self.0[stem.index()]
    }

    pub fn uniform(value: f32) -> Self {
        Self([value; 8])
    }
}

impl Default for Mix {
    fn default() -> Self {
        Self::uniform(0.8)
    }
}

impl Serialize for Mix {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(8))?;
        for stem in Stem::ALL {
            map.serialize_entry(stem.as_str(), &self.0[stem.index()])?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for Mix {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::{MapAccess, SeqAccess, Visitor};
        use std::fmt;

        struct MixVisitor;

        impl<'de> Visitor<'de> for MixVisitor {
            type Value = Mix;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a stem-keyed object or an array of 8 gains")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Mix, A::Error> {
                use serde::de::Error;
                let mut gains = [0.8f32; 8];
                while let Some(key) = access.next_key::<String>()? {
                    let value: f32 = access.next_value()?;
                    let stem = Stem::parse(&key).ok_or_else(|| {
                        const NAMES: [&str; 8] =
                            ["kick", "clap", "hats", "bass", "stab", "lead", "pad", "arp"];
                        A::Error::unknown_variant(&key, &NAMES)
                    })?;
                    gains[stem.index()] = value;
                }
                Ok(Mix(gains))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Mix, A::Error> {
                use serde::de::Error;
                let mut gains = [0.8f32; 8];
                for (i, slot) in gains.iter_mut().enumerate() {
                    *slot = access
                        .next_element::<f32>()?
                        .ok_or_else(|| A::Error::invalid_length(i, &self))?;
                }
                Ok(Mix(gains))
            }
        }

        deserializer.deserialize_any(MixVisitor)
    }
}

/// A single melodic hit: the pitches sounded, how long the gate is, how hard, and
/// whether the arrangement marked it as an accent.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NoteEvent {
    pub notes: Vec<f32>,
    pub len: f32,
    pub vel: f32,
    #[serde(default)]
    pub accent: bool,
}

impl NoteEvent {
    pub fn new(notes: Vec<f32>, len: f32, vel: f32, accent: bool) -> Self {
        Self {
            notes,
            len,
            vel,
            accent,
        }
    }

    pub fn first(&self, fallback: f32) -> f32 {
        self.notes.first().copied().unwrap_or(fallback)
    }
}

/// One step of a drum lane. Zero means silent; anything else is a velocity.
pub type Hit = f32;

/// The resolved arrangement the engine plays: 256 steps (16 bars of 16ths), nine
/// lanes. Produced by the Laravel backend so song form and library content live in
/// one place rather than being duplicated in the UI bundle.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    pub bpm: f32,
    pub swing: f32,
    /// Fader position per stem.
    pub mix: Mix,
    pub kick: Vec<Hit>,
    pub clap: Vec<Hit>,
    pub hat: Vec<Hit>,
    pub hat_open: Vec<Hit>,
    pub bass: Vec<Option<NoteEvent>>,
    pub stab: Vec<Option<NoteEvent>>,
    pub lead: Vec<Option<NoteEvent>>,
    pub pad: Vec<Option<NoteEvent>>,
    pub arp: Vec<Option<NoteEvent>>,
}

pub const STEPS: usize = 256;

impl Track {
    /// A silent track of the correct shape, used until a real one is loaded.
    pub fn silence(id: &str) -> Self {
        Self {
            id: id.to_string(),
            name: "Silence".to_string(),
            kind: TrackKind::House,
            bpm: 126.0,
            swing: 0.0,
            mix: Mix::uniform(0.8),
            kick: vec![0.0; STEPS],
            clap: vec![0.0; STEPS],
            hat: vec![0.0; STEPS],
            hat_open: vec![0.0; STEPS],
            bass: vec![None; STEPS],
            stab: vec![None; STEPS],
            lead: vec![None; STEPS],
            pad: vec![None; STEPS],
            arp: vec![None; STEPS],
        }
    }

    /// Note event on a melodic lane at a step.
    pub fn note(&self, stem: Stem, step: usize) -> Option<&NoteEvent> {
        if step >= STEPS {
            return None;
        }
        match stem {
            Stem::Kick | Stem::Clap | Stem::Hats => None,
            Stem::Bass => self.bass[step].as_ref(),
            Stem::Stab => self.stab[step].as_ref(),
            Stem::Lead => self.lead[step].as_ref(),
            Stem::Pad => self.pad[step].as_ref(),
            Stem::Arp => self.arp[step].as_ref(),
        }
    }

    /// Drum velocity at a step, folding open and closed hats onto one lane so the
    /// engine only has to check one source for the hats bus.
    pub fn hit(&self, stem: Stem, step: usize) -> Option<Hit> {
        if step >= STEPS {
            return None;
        }
        let v = match stem {
            Stem::Kick => self.kick[step],
            Stem::Clap => self.clap[step],
            Stem::Hats => {
                let open = self.hat_open[step];
                if open > 0.0 {
                    return Some(open);
                }
                self.hat[step]
            }
            _ => return None,
        };
        (v > 0.0).then_some(v)
    }

    /// Whether a stem has any content at all, so idle channels can be skipped.
    pub fn stem_active(&self, stem: Stem) -> bool {
        match stem {
            Stem::Kick => self.kick.iter().any(|v| *v > 0.0),
            Stem::Clap => self.clap.iter().any(|v| *v > 0.0),
            Stem::Hats => {
                self.hat.iter().any(|v| *v > 0.0) || self.hat_open.iter().any(|v| *v > 0.0)
            }
            _ => {
                let lane = match stem {
                    Stem::Bass => &self.bass,
                    Stem::Stab => &self.stab,
                    Stem::Lead => &self.lead,
                    Stem::Pad => &self.pad,
                    _ => &self.arp,
                };
                lane.iter().any(|e| e.is_some())
            }
        }
    }

    pub fn fader(&self, stem: Stem) -> f32 {
        self.mix.get(stem)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hat_open_takes_precedence_over_closed() {
        let mut t = Track::silence("t");
        t.hat[3] = 0.4;
        t.hat_open[3] = 0.8;
        assert!((t.hit(Stem::Hats, 3).unwrap() - 0.8).abs() < 1e-6);
        t.hat_open[3] = 0.0;
        assert!((t.hit(Stem::Hats, 3).unwrap() - 0.4).abs() < 1e-6);
    }

    #[test]
    fn hits_outside_the_grid_are_silent() {
        let t = Track::silence("t");
        assert!(t.hit(Stem::Kick, STEPS).is_none());
    }

    #[test]
    fn stem_activity_reflects_content() {
        let mut t = Track::silence("t");
        assert!(!t.stem_active(Stem::Arp));
        t.arp[10] = Some(NoteEvent::new(vec![60.0], 1.0, 0.5, false));
        assert!(t.stem_active(Stem::Arp));
    }

    #[test]
    fn drum_stems_have_no_delayed_send() {
        assert_eq!(Stem::Kick.send(), 0.0);
        assert_eq!(Stem::Bass.send(), 0.0);
    }

    #[test]
    fn note_reads_melodic_lanes_and_refuses_drums() {
        let mut t = Track::silence("t");
        t.kick[0] = 1.0;
        t.arp[2] = Some(NoteEvent::new(vec![60.0], 1.0, 0.5, false));
        assert_eq!(t.note(Stem::Arp, 2).unwrap().notes, vec![60.0]);
        assert!(t.note(Stem::Arp, 1).is_none());
        assert!(t.note(Stem::Kick, 0).is_none());
    }

    #[test]
    fn silence_has_uniform_faders() {
        let t = Track::silence("t");
        for stem in Stem::ALL {
            assert!((t.fader(stem) - 0.8).abs() < 1e-6);
        }
    }

    #[test]
    fn mix_reads_a_keyed_object() {
        let json = r#"{"kick":1.0,"clap":0.1,"hats":0.2,"bass":0.3,"stab":0.4,"lead":0.5,"pad":0.6,"arp":0.7}"#;
        let mix: Mix = serde_json::from_str(json).unwrap();
        assert!((mix.get(Stem::Kick) - 1.0).abs() < 1e-6);
        assert!((mix.get(Stem::Arp) - 0.7).abs() < 1e-6);
    }

    #[test]
    fn mix_reads_a_positional_array_too() {
        let json = "[1.0,0.1,0.2,0.3,0.4,0.5,0.6,0.7]";
        let mix: Mix = serde_json::from_str(json).unwrap();
        assert!((mix.get(Stem::Kick) - 1.0).abs() < 1e-6);
        assert!((mix.get(Stem::Arp) - 0.7).abs() < 1e-6);
    }

    #[test]
    fn mix_rejects_an_unknown_stem_name() {
        let json = r#"{"kick":1.0,"kazoo":0.5}"#;
        assert!(serde_json::from_str::<Mix>(json).is_err());
    }

    #[test]
    fn mix_roundtrips_as_a_keyed_object() {
        let mix = Mix::uniform(0.42);
        let json = serde_json::to_string(&mix).unwrap();
        let back: Mix = serde_json::from_str(&json).unwrap();
        assert_eq!(mix, back);
        assert!(json.contains("\"kick\""), "keys should be stem names");
    }
}
