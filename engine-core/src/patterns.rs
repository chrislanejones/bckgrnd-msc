//! Pattern revisions: edited lanes handed to the engine, swapped in at a boundary.
//!
//! The UI compiles the lanes a revision changes into one flat `f32` payload
//! (`docs/NIGHT4_PROTOCOL.md`, "The pattern payload"):
//!
//! ```text
//! [laneCount, (laneIndex, kind, n, ...data) * laneCount]
//! drum lane  (index 0..=3, kind 0): n = 256, then 256 velocities, 0 = silent
//! note lane  (index 4..=8, kind 1): n events, NOTE_WIDTH floats each:
//!            step, len, vel, accent (0/1), count, pitch * MAX_NOTES (unused = -1)
//! ```
//!
//! [`PatternSet::parse`] validates the whole payload before anything is built and
//! refuses it as a whole. It runs from the worklet's message handler, outside the
//! render callback; it is the only place lanes are allocated. At the boundary the
//! engine swaps each staged lane into the track with `std::mem::swap`, which moves
//! pointers and allocates nothing, and keeps the lanes it swapped out until the next
//! message so nothing is freed on the audio path either.

use crate::track::{Hit, NoteEvent, Stem, STEPS};

/// Lanes, in engine order: kick, clap, closed hat, open hat, bass, stab, lead, pad,
/// arp (`contracts/patterns.json`, `engine`).
pub const LANES: usize = 9;
/// Lanes 0..DRUM_LANES are drum lanes; the rest are note lanes.
pub const DRUM_LANES: usize = 4;
/// Pitches a note event can carry.
pub const MAX_NOTES: usize = 6;
/// Floats per note event in the payload.
pub const NOTE_WIDTH: usize = 5 + MAX_NOTES;

/// One staged lane.
pub enum LaneData {
    Drum(Vec<Hit>),
    Notes(Vec<Option<NoteEvent>>),
}

/// The lanes one revision replaces. A lane not in the revision is `None` and is left
/// as it is.
#[derive(Default)]
pub struct PatternSet {
    pub lanes: [Option<LaneData>; LANES],
}

/// The note stem a note lane plays, by engine lane index.
pub fn note_stem(index: usize) -> Option<Stem> {
    match index {
        4 => Some(Stem::Bass),
        5 => Some(Stem::Stab),
        6 => Some(Stem::Lead),
        7 => Some(Stem::Pad),
        8 => Some(Stem::Arp),
        _ => None,
    }
}

fn whole(v: f32) -> Option<usize> {
    (v.is_finite() && v >= 0.0 && v.fract() == 0.0).then_some(v as usize)
}

impl PatternSet {
    /// Validate and build a revision from a payload, or `None` if anything in it is
    /// malformed: a count or index out of range, a lane twice, the wrong kind for a
    /// lane, a velocity outside 0..1, a step outside the song or used twice, a note
    /// that runs past the song's end, a pitch outside 0..127, unused pitch slots not
    /// -1, or a length that does not account for every float.
    pub fn parse(data: &[f32]) -> Option<PatternSet> {
        let count = whole(*data.first()?)?;
        if count == 0 || count > LANES {
            return None;
        }
        let mut set = PatternSet::default();
        let mut k = 1usize;
        for _ in 0..count {
            let index = whole(*data.get(k)?)?;
            let kind = whole(*data.get(k + 1)?)?;
            let n = whole(*data.get(k + 2)?)?;
            k += 3;
            if index >= LANES || set.lanes[index].is_some() {
                return None;
            }
            if index < DRUM_LANES {
                if kind != 0 || n != STEPS {
                    return None;
                }
                let values = data.get(k..k + STEPS)?;
                if values
                    .iter()
                    .any(|v| !v.is_finite() || *v < 0.0 || *v > 1.0)
                {
                    return None;
                }
                set.lanes[index] = Some(LaneData::Drum(values.to_vec()));
                k += STEPS;
            } else {
                if kind != 1 || n > STEPS {
                    return None;
                }
                let mut lane: Vec<Option<NoteEvent>> = vec![None; STEPS];
                for _ in 0..n {
                    let e = data.get(k..k + NOTE_WIDTH)?;
                    let step = whole(e[0])?;
                    let (len, vel, accent) = (e[1], e[2], e[3]);
                    let notes = whole(e[4])?;
                    if step >= STEPS || lane[step].is_some() {
                        return None;
                    }
                    if !len.is_finite() || len <= 0.0 || step as f32 + len > STEPS as f32 {
                        return None;
                    }
                    if !vel.is_finite()
                        || vel <= 0.0
                        || vel > 1.0
                        || (accent != 0.0 && accent != 1.0)
                    {
                        return None;
                    }
                    if notes == 0 || notes > MAX_NOTES {
                        return None;
                    }
                    let pitches = &e[5..5 + MAX_NOTES];
                    for (i, p) in pitches.iter().enumerate() {
                        let ok = if i < notes {
                            p.is_finite() && (0.0..=127.0).contains(p)
                        } else {
                            *p == -1.0
                        };
                        if !ok {
                            return None;
                        }
                    }
                    lane[step] = Some(NoteEvent::new(
                        pitches[..notes].to_vec(),
                        len,
                        vel,
                        accent == 1.0,
                    ));
                    k += NOTE_WIDTH;
                }
                set.lanes[index] = Some(LaneData::Notes(lane));
            }
        }
        (k == data.len()).then_some(set)
    }

    /// Whether the revision replaces lane `index`.
    #[cfg(test)]
    pub fn has(&self, index: usize) -> bool {
        self.lanes.get(index).is_some_and(|l| l.is_some())
    }
}

/// Whether two note events would sound the same from their onset: same pitches, same
/// length. A voice whose event changed in either way is released at the swap.
pub fn same_note(a: &NoteEvent, b: &NoteEvent) -> bool {
    a.notes == b.notes && a.len == b.len
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drum_lane(index: usize, hits: &[(usize, f32)]) -> Vec<f32> {
        let mut out = vec![index as f32, 0.0, STEPS as f32];
        let mut lane = vec![0.0f32; STEPS];
        for (s, v) in hits {
            lane[*s] = *v;
        }
        out.extend(lane);
        out
    }

    fn note(step: usize, len: f32, pitches: &[f32]) -> Vec<f32> {
        let mut e = vec![step as f32, len, 0.8, 0.0, pitches.len() as f32];
        for i in 0..MAX_NOTES {
            e.push(pitches.get(i).copied().unwrap_or(-1.0));
        }
        e
    }

    fn payload(lanes: &[Vec<f32>]) -> Vec<f32> {
        let mut out = vec![lanes.len() as f32];
        for l in lanes {
            out.extend(l);
        }
        out
    }

    #[test]
    fn a_drum_lane_and_a_chord_parse() {
        let mut bass = vec![4.0, 1.0, 2.0];
        bass.extend(note(0, 2.0, &[33.0, 45.0]));
        bass.extend(note(250, 6.0, &[40.0]));
        let set = PatternSet::parse(&payload(&[drum_lane(2, &[(2, 0.5)]), bass])).expect("valid");
        match set.lanes[2].as_ref() {
            Some(LaneData::Drum(v)) => assert_eq!(v[2], 0.5),
            _ => panic!("hat lane"),
        }
        match set.lanes[4].as_ref() {
            Some(LaneData::Notes(v)) => {
                let e = v[0].as_ref().expect("note on 0");
                assert_eq!(e.notes, vec![33.0, 45.0], "a chord keeps both pitches");
                assert!(v[250].is_some());
            }
            _ => panic!("bass lane"),
        }
        assert!(!set.has(0), "lanes not in the revision are left alone");
    }

    #[test]
    fn an_empty_note_lane_is_silence_not_missing() {
        let set = PatternSet::parse(&payload(&[vec![6.0, 1.0, 0.0]])).expect("valid");
        match set.lanes[6].as_ref() {
            Some(LaneData::Notes(v)) => assert!(v.iter().all(|e| e.is_none())),
            _ => panic!("an empty lead lane is a lane"),
        }
    }

    #[test]
    fn anything_malformed_is_refused_whole() {
        let good_hat = drum_lane(2, &[(2, 0.5)]);
        let cases: Vec<(&str, Vec<f32>)> = vec![
            ("empty", vec![]),
            ("zero lanes", vec![0.0]),
            ("count says two, one given", {
                let mut p = payload(std::slice::from_ref(&good_hat));
                p[0] = 2.0;
                p
            }),
            ("lane twice", payload(&[good_hat.clone(), good_hat.clone()])),
            (
                "drum velocity above 1",
                payload(&[drum_lane(0, &[(0, 1.5)])]),
            ),
            ("drum lane as notes", payload(&[vec![0.0, 1.0, 0.0]])),
            ("note lane as drums", payload(&[drum_lane(5, &[])])),
            ("note past the end", {
                let mut l = vec![4.0, 1.0, 1.0];
                l.extend(note(250, 7.0, &[40.0]));
                payload(&[l])
            }),
            ("two notes on a step", {
                let mut l = vec![4.0, 1.0, 2.0];
                l.extend(note(3, 1.0, &[40.0]));
                l.extend(note(3, 1.0, &[41.0]));
                payload(&[l])
            }),
            ("pitch above 127", {
                let mut l = vec![4.0, 1.0, 1.0];
                l.extend(note(3, 1.0, &[128.0]));
                payload(&[l])
            }),
            ("unused pitch slot not -1", {
                let mut l = vec![4.0, 1.0, 1.0];
                let mut e = note(3, 1.0, &[40.0]);
                e[6] = 0.0;
                l.extend(e);
                payload(&[l])
            }),
            ("NaN velocity", payload(&[drum_lane(1, &[(4, f32::NAN)])])),
            ("trailing floats", {
                let mut p = payload(std::slice::from_ref(&good_hat));
                p.push(0.0);
                p
            }),
        ];
        for (name, data) in cases {
            assert!(
                PatternSet::parse(&data).is_none(),
                "{name} should be refused"
            );
        }
    }
}
