//! Pattern revisions against the real engine (docs/NIGHT4_PROTOCOL.md): when an edit
//! lands, in what order, what replaces or cancels it, and what it does to notes that
//! are already sounding.

use super::*;
use crate::patterns::{MAX_NOTES, NOTE_WIDTH};
use crate::scene_tests::{engine, ev, events, groove, render, render_until_fired, scene, RATES};
use crate::scheduler::{event, reason, timing};

/// A payload replacing drum lane `index` with `hits` (step, velocity).
fn drum(index: usize, hits: &[(usize, f32)]) -> Vec<f32> {
    let mut out = vec![1.0, index as f32, 0.0, STEPS as f32];
    let mut lane = vec![0.0f32; STEPS];
    for (s, v) in hits {
        lane[*s] = *v;
    }
    out.extend(lane);
    out
}

/// A payload replacing note lane `index` with `notes` (step, len, pitch).
fn notes(index: usize, notes: &[(usize, f32, f32)]) -> Vec<f32> {
    let mut out = vec![1.0, index as f32, 1.0, notes.len() as f32];
    for (step, len, pitch) in notes {
        out.extend([*step as f32, *len, 0.8, 0.0, 1.0, *pitch]);
        out.extend(std::iter::repeat_n(-1.0, MAX_NOTES - 1));
    }
    debug_assert_eq!(out.len(), 4 + notes.len() * NOTE_WIDTH);
    out
}

fn pattern_applies(e: &Engine) -> Vec<(u32, u64)> {
    e.trace
        .iter()
        .filter_map(|t| match *t {
            Trace::Patterns(id, at) => Some((id, at)),
            _ => None,
        })
        .collect()
}

fn kicks(e: &Engine) -> usize {
    e.trace
        .iter()
        .filter(|t| matches!(t, Trace::Drum(0, _, _)))
        .count()
}

#[test]
fn while_stopped_an_edit_applies_at_once_and_does_not_start_playback() {
    let mut e = engine(48_000.0);
    assert_eq!(
        e.queue_patterns(7, timing::BAR, 0, &drum(0, &[(3, 0.5)])),
        reason::OK
    );
    assert_eq!(e.track.kick[3], 0.5);
    assert_eq!(
        e.track.kick[0], 0.0,
        "the whole lane is the revision's, not a merge"
    );
    assert!(!e.transport.playing);
    assert_eq!(
        events(&mut e),
        vec![ev(event::PATTERNS_APPLIED, 7, -1.0, 0.0)]
    );
}

#[test]
fn while_playing_an_edit_lands_on_the_next_bar_before_that_steps_notes() {
    for sr in RATES {
        let mut e = engine(sr);
        e.play();
        render(&mut e, 37, 37);
        render_until_fired(&mut e, 5);
        let before = e.transport.step;
        assert_eq!(
            e.queue_patterns(9, timing::BAR, 0, &drum(0, &[(16, 0.7)])),
            reason::OK
        );
        assert_eq!(
            e.transport.step, before,
            "queuing an edit never moves the playhead"
        );
        assert_eq!(e.track.kick[0], 1.0, "nothing changes before the boundary");
        assert_eq!(
            events(&mut e),
            vec![ev(event::PATTERNS_QUEUED, 9, 2.0, 16.0)]
        );
        e.trace.clear();
        render_until_fired(&mut e, 16);
        let applied = pattern_applies(&e);
        assert_eq!(applied.len(), 1, "applied once");
        let (_, at) = applied[0];
        // The first trigger on that sample is step 16's, and it comes after the swap.
        let order: Vec<_> = e
            .trace
            .iter()
            .filter(|t| matches!(t, Trace::Patterns(_, a) | Trace::Trigger(_, a) if *a == at))
            .collect();
        assert!(matches!(order[0], Trace::Patterns(9, a) if *a == at));
        assert!(matches!(order[1], Trace::Trigger(16, a) if *a == at));
        assert!(
            e.trace
                .iter()
                .any(|t| matches!(t, Trace::Drum(0, 16, v) if (*v - 0.7).abs() < 1e-6)),
            "step 16 plays the edited kick"
        );
        assert_eq!(
            events(&mut e),
            vec![ev(event::PATTERNS_APPLIED, 9, 16.0, 0.0)]
        );
    }
}

#[test]
fn an_edit_to_a_later_bar_is_unheard_until_playback_reaches_it() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 2);
    // A kick on bar 9 only (step 128), applied at the next bar (step 16).
    e.queue_patterns(1, timing::BAR, 0, &drum(0, &[(128, 0.9)]));
    // Steps 4, 8 and 12 still play the old lane: the edit lands at bar 2.
    render_until_fired(&mut e, 15);
    e.trace.clear();
    render_until_fired(&mut e, 127);
    assert_eq!(
        kicks(&e),
        0,
        "bars 2..8 play the edited (empty) kick lane, not the old one"
    );
    render_until_fired(&mut e, 128);
    assert_eq!(
        kicks(&e),
        1,
        "bar 9 plays its new kick when the playhead gets there"
    );
}

#[test]
fn the_newest_edit_replaces_a_pending_one_and_keeps_its_boundary() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 3);
    e.queue_patterns(1, timing::BAR, 0, &drum(0, &[(16, 0.3)]));
    e.queue_patterns(2, timing::BAR, 0, &drum(0, &[(16, 0.6)]));
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::PATTERNS_QUEUED, 1, 2.0, 16.0),
            ev(event::PATTERNS_REPLACED, 1, 2.0, 0.0),
            ev(event::PATTERNS_QUEUED, 2, 2.0, 16.0),
        ]
    );
    e.trace.clear();
    render_until_fired(&mut e, 16);
    assert_eq!(
        pattern_applies(&e).iter().map(|a| a.0).collect::<Vec<_>>(),
        vec![2]
    );
    assert_eq!(e.track.kick[16], 0.6);
}

#[test]
fn a_refused_payload_changes_nothing_and_leaves_the_pending_edit_pending() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 3);
    e.queue_patterns(1, timing::BAR, 0, &drum(0, &[(16, 0.3)]));
    let mut bad = drum(0, &[]);
    bad[5] = 2.0;
    assert_eq!(e.queue_patterns(2, timing::BAR, 0, &bad), reason::INVALID);
    assert_eq!(
        e.queue_patterns(3, 9, 0, &drum(0, &[])),
        reason::INVALID,
        "unknown timing"
    );
    assert_eq!(e.pending_patterns(), Some(1));
    let got = events(&mut e);
    assert!(got.contains(&ev(
        event::PATTERNS_REJECTED,
        2,
        reason::INVALID as f64,
        0.0
    )));
}

#[test]
fn stop_applies_a_pending_edit_and_a_new_track_withdraws_it() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 3);
    e.queue_patterns(1, timing::BAR, 0, &drum(0, &[(3, 0.4)]));
    events(&mut e);
    e.stop();
    assert_eq!(
        e.track.kick[3], 0.4,
        "stopping keeps the edit: it is the user's music"
    );
    assert!(events(&mut e).contains(&ev(event::PATTERNS_APPLIED, 1, -1.0, 0.0)));

    e.play();
    render_until_fired(&mut e, 3);
    e.queue_patterns(2, timing::BAR, 0, &drum(0, &[(3, 0.2)]));
    events(&mut e);
    e.load_track(groove());
    assert_eq!(
        e.track.kick[3], 0.0,
        "an edit for the old track never reaches the new one"
    );
    assert_eq!(e.pending_patterns(), None);
    assert!(events(&mut e).contains(&ev(event::PATTERNS_CANCELLED, 2, reason::TRACK as f64, 0.0)));
}

#[test]
fn an_empty_lane_is_silence() {
    let mut e = engine(48_000.0);
    e.queue_patterns(1, timing::BAR, 0, &drum(0, &[]));
    e.play();
    e.trace.clear();
    render(&mut e, 48_000, 128);
    assert_eq!(
        kicks(&e),
        0,
        "an empty kick lane plays no kicks, not the factory's"
    );
}

/// The bass channel's energy over the next `seconds`.
fn bass_energy(e: &mut Engine, seconds: f32) -> f32 {
    let mut total = 0.0;
    for _ in 0..(seconds * e.sample_rate / 128.0) as usize {
        render(e, 128, 128);
        total += e.channels[Stem::Bass.index()].level;
    }
    total
}

fn held_bass() -> Track {
    let mut t = groove();
    t.kick = vec![0.0; STEPS];
    t.hat = vec![0.0; STEPS];
    // One long note from step 0 to the end of bar 2, and a lead note to edit.
    t.bass[0] = Some(NoteEvent::new(vec![45.0], 32.0, 0.9, false));
    t
}

#[test]
fn shortening_a_sounding_note_releases_it_and_leaves_unrelated_notes_alone() {
    let run = |payload: Option<Vec<f32>>| {
        let mut e = Engine::new(48_000.0);
        e.load_track(held_bass());
        e.play();
        render_until_fired(&mut e, 4);
        if let Some(p) = payload {
            e.queue_patterns(1, timing::NOW, 0, &p);
        }
        render(&mut e, 256, 128);
        bass_energy(&mut e, 0.3)
    };
    let untouched = run(None);
    let lead_edit = run(Some(notes(6, &[(8, 2.0, 72.0)])));
    let shortened = run(Some(notes(4, &[(0, 2.0, 45.0)])));
    assert!(untouched > 1.0, "the held bass sounds: {untouched}");
    assert!(
        (lead_edit - untouched).abs() < untouched * 0.02,
        "editing the lead leaves the held bass alone: {lead_edit} vs {untouched}"
    );
    assert!(
        shortened < untouched * 0.5,
        "a note shortened under it is released: {shortened} vs {untouched}"
    );
    assert!(
        shortened > 0.0,
        "released through its envelope, not cut dead"
    );
}

#[test]
fn a_fill_ends_into_the_updated_pattern() {
    let mut t = groove();
    t.fills = vec![Fill {
        clap: vec![0.8; 16],
        ..Fill::default()
    }];
    let mut e = Engine::new(48_000.0);
    e.load_track(t);
    e.play();
    render_until_fired(&mut e, 3);
    assert_eq!(e.queue_fill(1, 0), reason::OK);
    // While the fill is queued, the underlying kick changes to a single hit on step 32.
    e.queue_patterns(2, timing::BAR, 0, &drum(0, &[(32, 0.5)]));
    render_until_fired(&mut e, 31);
    e.trace.clear();
    render_until_fired(&mut e, 33);
    let kicks: Vec<_> = e
        .trace
        .iter()
        .filter_map(|t| match *t {
            Trace::Drum(0, step, v) => Some((step, v)),
            _ => None,
        })
        .collect();
    assert_eq!(
        kicks,
        vec![(32, 0.5)],
        "after the fill, the drums are the edited ones"
    );
}

#[test]
fn a_scenes_lanes_land_with_it_and_leave_with_it() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 3);
    // Lanes for scene 10, then scene 10.
    assert_eq!(
        e.queue_patterns(20, timing::BAR, 10, &drum(2, &[(16, 0.9)])),
        reason::OK
    );
    assert_eq!(e.queue_scene(10, timing::BAR, &scene(0.5)), reason::OK);
    e.trace.clear();
    render_until_fired(&mut e, 16);
    let scene_at = e
        .trace
        .iter()
        .find_map(|t| match *t {
            Trace::Apply(10, at) => Some(at),
            _ => None,
        })
        .expect("scene applied");
    assert_eq!(
        pattern_applies(&e),
        vec![(20, scene_at)],
        "the lanes apply on the scene's sample"
    );
    assert_eq!(e.track.hat[16], 0.9);

    // A scene replaced by one with no lanes takes its lanes with it.
    events(&mut e);
    e.queue_patterns(21, timing::BAR, 11, &drum(2, &[]));
    e.queue_scene(11, timing::BAR, &scene(0.4));
    e.queue_scene(12, timing::BAR, &scene(0.3));
    let got = events(&mut e);
    assert!(
        got.contains(&ev(event::PATTERNS_CANCELLED, 21, reason::USER as f64, 0.0)),
        "{got:?}"
    );

    // A cancelled scene too.
    e.queue_patterns(22, timing::BAR, 13, &drum(2, &[]));
    e.queue_scene(13, timing::BAR, &scene(0.4));
    events(&mut e);
    assert!(e.cancel_scene(13));
    assert!(events(&mut e).contains(&ev(event::PATTERNS_CANCELLED, 22, reason::USER as f64, 0.0)));
    render_until_fired(&mut e, 32);
    assert_eq!(e.track.hat[16], 0.9, "no withdrawn lanes were applied");
}

#[test]
fn an_edit_and_a_scene_on_one_boundary_apply_edit_first_so_the_scene_wins() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 3);
    e.queue_patterns(1, timing::BAR, 0, &drum(2, &[(16, 0.2)]));
    e.queue_patterns(2, timing::BAR, 5, &drum(2, &[(16, 0.8)]));
    e.queue_scene(5, timing::BAR, &scene(0.5));
    e.trace.clear();
    render_until_fired(&mut e, 16);
    assert_eq!(
        pattern_applies(&e).iter().map(|a| a.0).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(e.track.hat[16], 0.8, "the scene's lane wins");
}
