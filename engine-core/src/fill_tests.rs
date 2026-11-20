//! Night 8 fills against the real engine (`docs/NIGHT8_PROTOCOL.md`): phrase-ending
//! fills, Fill into, Rise + Fill and the crash accent. Like `scene_tests`, these read
//! the engine's test-only trace and its event ring.

use super::*;
use crate::build_tests::{lane_ids, target_from};
use crate::pattern_tests::drum;
use crate::scene::fill::detail;
use crate::scene_tests::{applies, ev, events, groove, render, render_until_fired, scene};
use crate::scheduler::{event, reason, timing};

const KICK: usize = 0;
const CLAP: usize = 1;
const HATS: usize = 2;

/// The drum voices spawned on `step`, as (stem index, velocity), in trace order.
pub(crate) fn drums_on(e: &Engine, step: usize) -> Vec<(usize, f32)> {
    e.trace
        .iter()
        .filter_map(|t| match *t {
            Trace::Drum(stem, s, vel) if s == step => Some((stem, vel)),
            _ => None,
        })
        .collect()
}

/// The sample `step` was last triggered on.
pub(crate) fn trigger_sample(e: &Engine, step: usize) -> u64 {
    e.trace
        .iter()
        .rev()
        .find_map(|t| match *t {
            Trace::Trigger(s, at) if s == step => Some(at),
            _ => None,
        })
        .unwrap_or_else(|| panic!("step {step} never triggered"))
}

/// Whether the trace has the scene `id` committed on `sample`, before that sample's
/// notes.
pub(crate) fn committed_before_notes(e: &Engine, id: u32, sample: u64) -> bool {
    let apply = e.trace.iter().position(|t| *t == Trace::Apply(id, sample));
    let notes = e
        .trace
        .iter()
        .position(|t| matches!(t, Trace::Trigger(_, s) if *s == sample));
    apply.is_some() && apply < notes
}

/// The groove (kick on the beat, hats on every step, no clap) with one fill whose every
/// step is a clap and whose kick and closed hats are silent, at 200 bpm so a pass of the
/// song is under 20 s.
pub(crate) fn fill_track() -> Track {
    let mut t = groove();
    t.bpm = 200.0;
    t.swing = 0.0;
    t.fills = vec![Fill {
        kick: vec![0.0; 16],
        clap: vec![0.7; 16],
        hat: vec![0.0; 16],
        hat_open: Vec::new(),
    }];
    t
}

pub(crate) fn fill_engine() -> Engine {
    let mut e = Engine::new(48_000.0);
    e.load_track(fill_track());
    e
}

/// Playing, with `step` just fired, the trace and the ring empty.
pub(crate) fn playing_at(step: i32) -> Engine {
    let mut e = fill_engine();
    e.play();
    render(&mut e, 37, 37);
    render_until_fired(&mut e, step);
    e.trace.clear();
    events(&mut e);
    e
}

/// Render 128-frame blocks until an event of `kind` for `id` turns up, and return
/// every event seen on the way (the block that held it included).
pub(crate) fn run_until(e: &mut Engine, kind: u8, id: u32) -> Vec<[f64; 4]> {
    let mut seen = Vec::new();
    for _ in 0..(e.sample_rate as usize * 45 / 128) {
        render(e, 128, 128);
        let got = events(e);
        let hit = got.iter().any(|x| x[0] == kind as f64 && x[1] == id as f64);
        seen.extend(got);
        if hit {
            return seen;
        }
    }
    panic!("no event {kind} for {id}; saw {seen:?}");
}

/// The first event of `kind` for `id` in `seen`.
pub(crate) fn find(seen: &[[f64; 4]], kind: u8, id: u32) -> Option<[f64; 4]> {
    seen.iter()
        .copied()
        .find(|x| x[0] == kind as f64 && x[1] == id as f64)
}

/// Every phrase length: queued from the top and again on the onset each one ends, the
/// fill plays the bar before every phrase line of the song (2 bars: 16, 48, 80 ...; 4
/// bars: 48, 112, 176, 240; 8 bars: 112, 240; 16 bars: 240), ends on the line, and
/// `fill started` carries b = 0 (the first recipe position: one-bar fills only).
#[test]
fn a_phrase_fill_plays_the_bar_before_every_phrase_line() {
    for bars in [2u8, 4, 8, 16] {
        let phrase = bars as usize * 16;
        let mut e = fill_engine();
        e.play();
        for (id, line) in (1u32..).zip((phrase..=STEPS).step_by(phrase)) {
            let start = line - 16;
            assert_eq!(e.queue_fill_at(id, 0, bars, 0), reason::OK, "{bars} bars");
            let seen = run_until(&mut e, event::FILL_ENDED, id);
            assert_eq!(
                find(&seen, event::FILL_QUEUED, id),
                Some(ev(
                    event::FILL_QUEUED,
                    id,
                    (start / 16 + 1) as f64,
                    start as f64
                )),
                "{bars} bars, line {line}"
            );
            assert_eq!(
                find(&seen, event::FILL_STARTED, id),
                Some(ev(event::FILL_STARTED, id, start as f64, 0.0)),
                "{bars} bars, line {line}"
            );
            assert_eq!(
                find(&seen, event::FILL_ENDED, id),
                Some(ev(event::FILL_ENDED, id, (line % STEPS) as f64, 0.0)),
                "{bars} bars, line {line}"
            );
        }
    }
}

/// Any other phrase length or fill length is refused as invalid, and so is a fill the
/// track does not have; nothing is queued.
#[test]
fn bad_phrase_or_length_is_refused() {
    let mut e = playing_at(5);
    for (bars, length, index) in [
        (1u8, 0u8, 0u32),
        (3, 0, 0),
        (5, 0, 0),
        (32, 0, 0),
        (255, 0, 0),
        (4, 1, 0),
        (0, 4, 0),
        (4, 0, 1),
    ] {
        assert_eq!(
            e.queue_fill_at(7, index, bars, length),
            reason::INVALID,
            "{bars} bars, length {length}, fill {index}"
        );
        assert_eq!(
            events(&mut e),
            vec![ev(event::FILL_REJECTED, 7, reason::INVALID as f64, 0.0)]
        );
        assert_eq!(e.pending_fill(), None);
    }
}

/// A press in the last bar of a phrase, or on its last bar line, is late for that
/// phrase: it goes to the next phrase end, never refused. One step earlier it still
/// makes this one.
#[test]
fn a_late_press_rolls_to_the_next_phrase() {
    for (fired, start) in [(47, 48usize), (48, 112), (50, 112), (63, 112), (64, 112)] {
        let mut e = playing_at(fired);
        assert_eq!(e.queue_fill_at(1, 0, 4, 0), reason::OK, "after {fired}");
        let seen = run_until(&mut e, event::FILL_STARTED, 1);
        assert_eq!(
            seen[0],
            ev(event::FILL_QUEUED, 1, (start / 16 + 1) as f64, start as f64),
            "after {fired}"
        );
        assert_eq!(
            find(&seen, event::FILL_STARTED, 1),
            Some(ev(event::FILL_STARTED, 1, start as f64, 0.0)),
            "after {fired}"
        );
    }
}

/// The loop's wrap is a phrase end too. A 1-bar loop plays the fill on the next bar
/// line, a 2-bar loop on its last bar (bar 6 of 64..96, which is not a 4-bar line), a
/// phrase-aligned 4-bar loop on its last bar whatever the phrase, and the fill ends on
/// the loop's first step.
#[test]
fn a_loop_wrap_is_a_phrase_end() {
    // (fired before the loop is set, loop bars, phrase bars, start, ends on)
    for (fired, loop_bars, bars, start, end) in [
        (35, 1u32, 4u8, 32usize, 32usize),
        (70, 2, 4, 80, 64),
        (70, 4, 4, 112, 64),
        (70, 4, 16, 112, 64),
        (70, 4, 2, 80, 96),
        (130, 8, 8, 240, 128),
    ] {
        let label = format!("{loop_bars}-bar loop, {bars}-bar phrase");
        let mut e = playing_at(fired);
        e.set_loop(loop_bars);
        assert_eq!(e.queue_fill_at(1, 0, bars, 0), reason::OK, "{label}");
        let seen = run_until(&mut e, event::FILL_ENDED, 1);
        assert_eq!(
            seen[0],
            ev(event::FILL_QUEUED, 1, (start / 16 + 1) as f64, start as f64),
            "{label}"
        );
        assert_eq!(
            find(&seen, event::FILL_STARTED, 1),
            Some(ev(event::FILL_STARTED, 1, start as f64, 0.0)),
            "{label}"
        );
        assert_eq!(
            find(&seen, event::FILL_ENDED, 1),
            Some(ev(event::FILL_ENDED, 1, end as f64, 0.0)),
            "{label}"
        );
    }
}

/// A tempo change while the fill waits moves nothing: it starts on the onset it was
/// announced for, whatever the clock did in between.
#[test]
fn a_tempo_change_while_waiting_moves_nothing() {
    for bpm in [70.0, 140.0, 199.0] {
        let mut e = playing_at(5);
        assert_eq!(e.queue_fill_at(1, 0, 4, 0), reason::OK);
        let want = e.scheduler.serial() + 43;
        assert_eq!(
            events(&mut e),
            vec![ev(event::FILL_QUEUED, 1, 4.0, 48.0)],
            "{bpm}"
        );
        render_until_fired(&mut e, 20);
        e.set_bpm(bpm);
        render_until_fired(&mut e, 40);
        e.set_bpm(200.0);
        let seen = run_until(&mut e, event::FILL_STARTED, 1);
        assert_eq!(
            seen,
            vec![ev(event::FILL_STARTED, 1, 48.0, 0.0)],
            "{bpm}: started off its onset"
        );
        assert_eq!(e.scheduler.serial(), want, "{bpm}: counted in onsets");
    }
}

/// A loop set or cleared under a waiting phrase fill works its start out again and
/// re-announces it, and it starts where the new announcement says.
#[test]
fn a_loop_change_re_announces_a_phrase_fill() {
    let mut e = playing_at(5);
    assert_eq!(e.queue_fill_at(1, 0, 4, 0), reason::OK);
    e.set_loop(1);
    e.set_loop(0);
    e.set_loop(2);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::FILL_QUEUED, 1, 4.0, 48.0),
            // A 1-bar loop on bar 1: its wrap is the phrase end, so the next bar line.
            ev(event::FILL_QUEUED, 1, 1.0, 0.0),
            ev(event::FILL_QUEUED, 1, 4.0, 48.0),
            // A 2-bar loop on bars 1-2: its last bar.
            ev(event::FILL_QUEUED, 1, 2.0, 16.0),
        ]
    );
    let seen = run_until(&mut e, event::FILL_ENDED, 1);
    assert_eq!(
        seen,
        vec![
            ev(event::FILL_STARTED, 1, 16.0, 0.0),
            ev(event::FILL_ENDED, 1, 0.0, 0.0),
        ]
    );
}

/// `queue_fill` is `queue_fill_at` with phrase 0: the next bar line, as in Night 3,
/// and the phrase fill plays the same sixteen steps of the recipe.
#[test]
fn phrase_zero_is_the_next_bar() {
    for fired in [5, 15, 16, 47] {
        let mut a = playing_at(fired);
        let mut b = playing_at(fired);
        assert_eq!(a.queue_fill(1, 0), reason::OK);
        assert_eq!(b.queue_fill_at(1, 0, 0, 0), reason::OK);
        let sa = run_until(&mut a, event::FILL_ENDED, 1);
        let sb = run_until(&mut b, event::FILL_ENDED, 1);
        assert_eq!(sa, sb, "after {fired}");
        let next = (fired as usize / 16 + 1) * 16;
        assert_eq!(
            find(&sa, event::FILL_STARTED, 1),
            Some(ev(event::FILL_STARTED, 1, next as f64, 0.0))
        );
    }
}

// -- Fill into ------------------------------------------------------------------

/// The Drop: the kick fader at 0.9, and a kick lane whose only hit is a 0.55 on the
/// landing step (64), so the landing kick can only be the scene's: the track's own is
/// 1.0 and the fill's is silent.
fn drop_lanes() -> Vec<f32> {
    drum(0, &[(64, 0.55)])
}

/// Playing with step 5 just fired; a Fill into queued (fill 1, scene 2, phrase 4, lanes
/// 30), so the fill plays 48..63 and the scene lands on 64. The ring is drained.
fn fill_into() -> Engine {
    let mut e = playing_at(5);
    assert_eq!(e.queue_patterns(30, timing::BAR, 2, &drop_lanes()), 0);
    assert_eq!(e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 0), reason::OK);
    events(&mut e);
    e
}

/// The scene commits on the onset the fill ends, with its lanes, before that step's
/// notes; the fill played the phrase's last bar; the landing kick is the scene's, not
/// silence and not the fill. Events: queued, scene queued with the landing, linked,
/// then on the line the lanes, the scene, and the fill's end, in that order.
#[test]
fn fill_into_lands_the_scene_on_the_onset_the_fill_ends() {
    let mut e = playing_at(5);
    assert_eq!(e.queue_patterns(30, timing::BAR, 2, &drop_lanes()), 0);
    assert_eq!(e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 0), reason::OK);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::FILL_QUEUED, 1, 4.0, 48.0),
            ev(event::SCENE_QUEUED, 2, 5.0, 64.0),
            ev(event::FILL_LINKED, 1, 2.0, 64.0),
        ]
    );
    assert_eq!((e.pending_fill(), e.pending_scene()), (Some(1), Some(2)));
    render_until_fired(&mut e, 65);
    let at = trigger_sample(&e, 64);
    assert_eq!(applies(&e), vec![(2, at)], "committed once, on 64");
    assert!(committed_before_notes(&e, 2, at));
    assert_eq!(lane_ids(&e), vec![30]);
    for step in 48..64 {
        assert_eq!(drums_on(&e, step), vec![(CLAP, 0.7)], "step {step}");
    }
    assert_eq!(drums_on(&e, 64), vec![(KICK, 0.55), (HATS, 0.4)]);
    assert_eq!(e.channels[KICK].vol, 0.9);
    let got = events(&mut e);
    let landing: Vec<_> = got.iter().copied().filter(|x| x[2] == 64.0).collect();
    assert_eq!(
        landing,
        vec![
            ev(event::PATTERNS_APPLIED, 30, 64.0, 0.0),
            ev(event::SCENE_APPLIED, 2, 64.0, 0.0),
            ev(event::FILL_ENDED, 1, 64.0, 0.0),
        ]
    );
    assert!(got.contains(&ev(event::FILL_STARTED, 1, 48.0, 0.0)));
    assert_eq!(
        (e.pending_fill(), e.active_fill(), e.pending_scene()),
        (None, None, None)
    );
}

/// Phrase 0: the fill plays the next bar and the scene lands on the bar after.
#[test]
fn fill_into_at_phrase_zero_plays_the_next_bar() {
    let mut e = playing_at(5);
    assert_eq!(e.queue_fill_into(1, 0, 0, 0, 2, &scene(0.9), 0), reason::OK);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::FILL_QUEUED, 1, 2.0, 16.0),
            ev(event::SCENE_QUEUED, 2, 3.0, 32.0),
            ev(event::FILL_LINKED, 1, 2.0, 32.0),
        ]
    );
    let seen = run_until(&mut e, event::SCENE_APPLIED, 2);
    assert!(seen.contains(&ev(event::SCENE_APPLIED, 2, 32.0, 0.0)));
    assert!(seen.contains(&ev(event::FILL_ENDED, 1, 32.0, 0.0)));
}

/// No gap on the line: the sound just after the landing onset is as full as the same
/// scene launched on that bar line without a fill (not silence while the fill hands
/// over).
#[test]
fn fill_into_leaves_no_gap_on_the_line() {
    let energy_after_64 = |linked: bool| -> f32 {
        let mut e = playing_at(5);
        e.queue_patterns(30, timing::BAR, 2, &drop_lanes());
        if linked {
            assert_eq!(e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 0), 0);
            render_until_fired(&mut e, 63);
        } else {
            render_until_fired(&mut e, 50);
            assert_eq!(e.queue_scene(2, timing::BAR, &scene(0.9)), 0);
            render_until_fired(&mut e, 63);
        }
        render_until_fired(&mut e, 64);
        let mut l = vec![0.0f32; 1_440];
        let mut r = vec![0.0f32; 1_440];
        e.process(&mut l, &mut r);
        l.iter().chain(r.iter()).map(|v| v.abs()).sum()
    };
    let plain = energy_after_64(false);
    let linked = energy_after_64(true);
    assert!(plain > 1.0, "the plain launch was silent: {plain}");
    assert!(
        linked > plain * 0.6,
        "the first 30 ms after the line: {linked} with a fill, {plain} without"
    );
}

/// Every way a Fill into is refused refuses both parts, with the same reason and the
/// part at fault, withdraws only its own staged lanes, and leaves a scene (with its
/// lanes) and a fill already pending exactly as they were.
#[test]
fn a_refused_fill_into_changes_nothing() {
    type Send = fn(&mut Engine) -> u8;
    let cases: [(&str, Send, u8, u8); 5] = [
        (
            "short scene",
            |e| e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9)[..43], 0),
            reason::INVALID,
            detail::SCENE,
        ),
        (
            "no such fill",
            |e| e.queue_fill_into(1, 3, 4, 0, 2, &scene(0.9), 0),
            reason::INVALID,
            detail::FILL,
        ),
        (
            "3-bar phrase",
            |e| e.queue_fill_into(1, 0, 3, 0, 2, &scene(0.9), 0),
            reason::INVALID,
            detail::FILL,
        ),
        (
            "beat length",
            |e| e.queue_fill_into(1, 0, 4, 1, 2, &scene(0.9), 0),
            reason::INVALID,
            detail::FILL,
        ),
        (
            "a fill already queued",
            |e| {
                assert_eq!(e.queue_fill_at(9, 0, 4, 0), 0);
                events(e);
                e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 0)
            },
            reason::ALREADY_PLAYING,
            detail::FILL,
        ),
    ];
    for (name, send, why, part) in cases {
        let mut e = playing_at(5);
        e.queue_patterns(50, timing::BAR, 5, &drum(2, &[(16, 0.9)]));
        assert_eq!(e.queue_scene(5, timing::BAR, &scene(0.3)), 0);
        events(&mut e);
        e.queue_patterns(30, timing::BAR, 2, &drop_lanes());
        assert_eq!(send(&mut e), why, "{name}");
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::FILL_REJECTED, 1, why as f64, part as f64),
                ev(event::SCENE_REJECTED, 2, why as f64, part as f64),
                ev(event::PATTERNS_CANCELLED, 30, why as f64, 0.0),
            ],
            "{name}"
        );
        assert_eq!(e.pending_scene(), Some(5), "{name}");
        let busy = why == reason::ALREADY_PLAYING;
        assert_eq!(e.pending_fill(), busy.then_some(9), "{name}");
        let seen = run_until(&mut e, event::SCENE_APPLIED, 5);
        assert!(
            seen.contains(&ev(event::SCENE_APPLIED, 5, 16.0, 0.0)),
            "{name}"
        );
        assert_eq!(lane_ids(&e), vec![50], "{name}");
        assert_eq!(e.track.hat[16], 0.9, "{name}");
        if busy {
            let seen = run_until(&mut e, event::FILL_ENDED, 9);
            assert!(
                seen.contains(&ev(event::FILL_STARTED, 9, 48.0, 0.0)),
                "{name}"
            );
        }
        assert!(!applies(&e).iter().any(|a| a.0 == 2), "{name}");
    }

    // The whole request: stopped, and under a scratch. Both parts, part 0.
    let mut stopped = fill_engine();
    stopped.queue_patterns(30, timing::BAR, 2, &drop_lanes());
    assert_eq!(
        stopped.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 0),
        reason::NOT_PLAYING
    );
    assert_eq!(
        events(&mut stopped),
        vec![
            ev(event::FILL_REJECTED, 1, 7.0, 0.0),
            ev(event::SCENE_REJECTED, 2, 7.0, 0.0),
            ev(event::PATTERNS_CANCELLED, 30, 7.0, 0.0),
        ]
    );
    assert!(stopped.scene_lanes.is_none() && stopped.staged.is_none());
    let mut held = playing_at(5);
    held.scratch_start();
    events(&mut held);
    assert_eq!(
        held.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 0),
        reason::TRANSPORT
    );
    assert_eq!(
        events(&mut held),
        vec![
            ev(event::FILL_REJECTED, 1, 3.0, 0.0),
            ev(event::SCENE_REJECTED, 2, 3.0, 0.0),
        ]
    );
}

/// Cancelled before the fill starts, from either part: both cancelled (10), the lanes
/// with them, and nothing plays or lands.
#[test]
fn cancel_before_the_fill_starts_cancels_both() {
    for by_fill in [true, false] {
        let mut e = fill_into();
        render_until_fired(&mut e, 30);
        events(&mut e);
        let cancelled = if by_fill {
            e.cancel_fill(1)
        } else {
            e.cancel_scene(2)
        };
        assert!(cancelled, "by fill {by_fill}");
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::SCENE_CANCELLED, 2, 10.0, 0.0),
                ev(event::FILL_CANCELLED, 1, 10.0, 0.0),
                ev(event::PATTERNS_CANCELLED, 30, 10.0, 0.0),
            ],
            "by fill {by_fill}"
        );
        assert!(!e.cancel_fill(1) && !e.cancel_scene(2), "by fill {by_fill}");
        render_until_fired(&mut e, 70);
        let got = events(&mut e);
        assert!(got.is_empty(), "by fill {by_fill}: {got:?}");
        assert!(applies(&e).is_empty() && lane_ids(&e).is_empty());
        assert_eq!(
            drums_on(&e, 48),
            vec![(KICK, 1.0), (HATS, 0.4)],
            "the track's own drums on 48, no fill"
        );
    }
}

/// Cancelled while the fill plays, from either part: the scene is cancelled (10) with
/// its lanes, and the fill plays out its bar, unlinked (52), into the track's own drums.
#[test]
fn cancel_while_the_fill_plays_cancels_the_scene_only() {
    for by_fill in [true, false] {
        let mut e = fill_into();
        render_until_fired(&mut e, 52);
        assert_eq!(e.active_fill(), Some(1));
        events(&mut e);
        let cancelled = if by_fill {
            e.cancel_fill(1)
        } else {
            e.cancel_scene(2)
        };
        assert!(cancelled, "by fill {by_fill}");
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::SCENE_CANCELLED, 2, 10.0, 0.0),
                ev(event::FILL_UNLINKED, 1, 10.0, 0.0),
                ev(event::PATTERNS_CANCELLED, 30, 10.0, 0.0),
            ],
            "by fill {by_fill}"
        );
        assert_eq!(e.active_fill(), Some(1));
        let seen = run_until(&mut e, event::FILL_ENDED, 1);
        assert_eq!(seen, vec![ev(event::FILL_ENDED, 1, 64.0, 0.0)]);
        render_until_fired(&mut e, 65);
        assert_eq!(drums_on(&e, 63), vec![(CLAP, 0.7)]);
        assert_eq!(drums_on(&e, 64), vec![(KICK, 1.0), (HATS, 0.4)]);
        assert!(applies(&e).is_empty() && lane_ids(&e).is_empty());
        // A playing plain fill is not cancelled.
        assert!(!e.cancel_fill(1));
    }
}

/// Stop, seek, scratch, brake, backspin, a track load, panic and the host's cancel end
/// both parts with their reason, waiting or with the fill playing, and the lanes go
/// with the scene. Nothing is unlinked: both are gone.
#[test]
fn interruptions_end_both_parts() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, u8); 8] = [
        ("stop", |e| e.stop(), reason::STOPPED),
        ("seek", |e| e.jump(0), reason::TRANSPORT),
        ("scratch", |e| e.scratch_start(), reason::TRANSPORT),
        ("brake", |e| e.brake(), reason::TRANSPORT),
        ("backspin", |e| e.backspin(), reason::TRANSPORT),
        ("load", |e| e.load_track(fill_track()), reason::TRACK),
        ("panic", |e| e.panic(), reason::PANIC),
        (
            "host",
            |e| {
                e.cancel_pending(reason::TRACK);
            },
            reason::TRACK,
        ),
    ];
    for playing_fill in [false, true] {
        for (name, action, why) in cases {
            let label = format!("{name}, fill playing {playing_fill}");
            let mut e = fill_into();
            render_until_fired(&mut e, if playing_fill { 50 } else { 30 });
            events(&mut e);
            action(&mut e);
            let got = events(&mut e);
            let fill = if playing_fill {
                ev(event::FILL_ENDED, 1, -1.0, why as f64)
            } else {
                ev(event::FILL_CANCELLED, 1, why as f64, 0.0)
            };
            for want in [
                ev(event::SCENE_CANCELLED, 2, why as f64, 0.0),
                fill,
                ev(event::PATTERNS_CANCELLED, 30, why as f64, 0.0),
            ] {
                assert!(
                    got.contains(&want),
                    "{label}: {want:?} missing from {got:?}"
                );
            }
            assert!(
                !got.iter().any(|x| x[0] == event::FILL_UNLINKED as f64),
                "{label}"
            );
            assert_eq!(
                (e.pending_fill(), e.active_fill(), e.pending_scene()),
                (None, None, None),
                "{label}"
            );
            assert!(e.scene_lanes.is_none(), "{label}");
        }
    }
}

/// Another scene launched while linked replaces the scene (latest wins) on its own
/// timing, and the fill unlinks (52, 10) and plays as a plain phrase fill; waiting or
/// playing.
#[test]
fn another_scene_replaces_the_linked_scene_and_unlinks_the_fill() {
    for playing_fill in [false, true] {
        let mut e = fill_into();
        render_until_fired(&mut e, if playing_fill { 50 } else { 20 });
        events(&mut e);
        assert_eq!(e.queue_scene(3, timing::BEAT, &scene(0.2)), 0);
        let next_beat = if playing_fill { 52.0 } else { 24.0 };
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::SCENE_REPLACED, 2, 3.0, 0.0),
                ev(event::FILL_UNLINKED, 1, 10.0, 0.0),
                ev(
                    event::SCENE_QUEUED,
                    3,
                    (next_beat as usize / 16 + 1) as f64,
                    next_beat
                ),
                ev(event::PATTERNS_CANCELLED, 30, 10.0, 0.0),
            ],
            "fill playing {playing_fill}"
        );
        let seen = run_until(&mut e, event::FILL_ENDED, 1);
        assert!(seen.contains(&ev(event::SCENE_APPLIED, 3, next_beat, 0.0)));
        assert!(playing_fill || seen.contains(&ev(event::FILL_STARTED, 1, 48.0, 0.0)));
        assert_eq!(seen.last(), Some(&ev(event::FILL_ENDED, 1, 64.0, 0.0)));
        assert!(!applies(&e).iter().any(|a| a.0 == 2));
        assert_eq!(e.channels[KICK].vol, 0.2);
    }
}

/// A Rise queued while linked replaces the scene (Night 7) and the fill unlinks.
#[test]
fn a_rise_queued_while_linked_replaces_the_scene_and_unlinks_the_fill() {
    let mut e = fill_into();
    let target = target_from(&e.base());
    assert_eq!(e.queue_build(3, 2, &target, &[]), 0);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::SCENE_REPLACED, 2, 3.0, 0.0),
            ev(event::FILL_UNLINKED, 1, 10.0, 0.0),
            ev(event::PATTERNS_CANCELLED, 30, 10.0, 0.0),
            ev(event::BUILD_QUEUED, 3, 2.0, 16.0),
        ]
    );
    let seen = run_until(&mut e, event::FILL_ENDED, 1);
    assert!(seen.contains(&ev(event::BUILD_APPLIED, 3, 48.0, 0.0)));
    assert!(seen.contains(&ev(event::FILL_STARTED, 1, 48.0, 0.0)));
    assert!(!applies(&e).iter().any(|a| a.0 == 2));
}

/// A Rise running when the Fill into lands: the scene commits on the phrase line and
/// replaces the build (Night 7); the fill played on top.
#[test]
fn fill_into_landing_on_a_running_rise_replaces_it() {
    let mut e = playing_at(5);
    let target = target_from(&e.base());
    assert_eq!(e.queue_build(3, 4, &target, &[]), 0);
    assert_eq!(e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 0), 0);
    let seen = run_until(&mut e, event::SCENE_APPLIED, 2);
    let tail: Vec<_> = seen
        .iter()
        .copied()
        .filter(|x| x[2] == 64.0 || x[0] == 44.0)
        .collect();
    assert_eq!(
        tail,
        vec![
            ev(event::BUILD_REPLACED, 3, 2.0, 0.0),
            ev(event::SCENE_APPLIED, 2, 64.0, 0.0),
            ev(event::FILL_ENDED, 1, 64.0, 0.0),
        ]
    );
    assert_eq!(e.channels[KICK].vol, 0.9);
}

/// A pattern edit while linked is its own (Night 4): it lands on its bar line, and on
/// the line where both land, the scene's lanes win on a lane both set.
#[test]
fn a_pattern_edit_while_linked_is_unaffected() {
    let mut e = fill_into();
    render_until_fired(&mut e, 50);
    assert_eq!(
        e.queue_patterns(40, timing::BAR, 0, &drum(0, &[(64, 0.3), (68, 0.3)])),
        0
    );
    render_until_fired(&mut e, 65);
    let at = trigger_sample(&e, 64);
    assert_eq!(lane_ids(&e), vec![40, 30], "the edit, then the scene's");
    assert!(committed_before_notes(&e, 2, at));
    assert_eq!(drums_on(&e, 64)[0], (KICK, 0.55), "the scene's lane wins");
}

/// A loop change while waiting moves both parts together and re-announces them; a
/// tempo change moves neither.
#[test]
fn loop_and_tempo_changes_while_linked() {
    let mut e = fill_into();
    e.set_loop(1);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::FILL_QUEUED, 1, 1.0, 0.0),
            ev(event::SCENE_QUEUED, 2, 1.0, 0.0),
        ],
        "a 1-bar loop on bar 1: the fill plays it, the scene lands on its wrap"
    );
    let seen = run_until(&mut e, event::SCENE_APPLIED, 2);
    assert!(seen.contains(&ev(event::FILL_STARTED, 1, 0.0, 0.0)));
    assert!(seen.contains(&ev(event::SCENE_APPLIED, 2, 0.0, 0.0)));
    assert!(seen.contains(&ev(event::FILL_ENDED, 1, 0.0, 0.0)));

    let mut e = fill_into();
    let due = e.scheduler.serial() + 59;
    render_until_fired(&mut e, 20);
    e.set_bpm(90.0);
    render_until_fired(&mut e, 40);
    e.set_bpm(200.0);
    let seen = run_until(&mut e, event::SCENE_APPLIED, 2);
    assert!(seen.contains(&ev(event::SCENE_APPLIED, 2, 64.0, 0.0)));
    assert_eq!(e.scheduler.serial(), due, "landed on its onset");
}

// -- Rise + Fill ----------------------------------------------------------------

/// The lanes a Rise lands with: a kick lane whose only hit is a 0.55 on `step`.
fn rise_lanes(step: usize) -> Vec<f32> {
    drum(0, &[(step, 0.55)])
}

/// Playing with step 5 just fired; a 2-bar Rise (build 2, lanes 30) into scene(0.9)
/// finishing with fill 1: it starts on 16, the fill plays 32..47, and it lands on 48.
fn rise_with_fill() -> Engine {
    let mut e = playing_at(5);
    let target = target_from(&e.base());
    assert_eq!(e.queue_patterns(30, timing::BAR, 2, &rise_lanes(48)), 0);
    assert_eq!(
        e.queue_build_with(2, 2, &target, &scene(0.9), 1, 0, 0),
        reason::OK
    );
    events(&mut e);
    e
}

/// For 2, 4 and 8 bars: the fill plays the Rise's last bar, and the landing scene and
/// its lanes commit on the next downbeat, the onset the build ends, before that step's
/// notes, as the fill ends. The landing kick is the scene's lanes'.
#[test]
fn rise_with_fill_plays_the_last_bar_and_lands_on_the_downbeat() {
    for bars in [2u32, 4, 8] {
        let end = 16 + bars as usize * 16;
        let fill = end - 16;
        let mut e = playing_at(5);
        let target = target_from(&e.base());
        assert_eq!(e.queue_patterns(30, timing::BAR, 2, &rise_lanes(end)), 0);
        assert_eq!(
            e.queue_build_with(2, bars, &target, &scene(0.9), 1, 0, 0),
            reason::OK
        );
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::BUILD_QUEUED, 2, 2.0, 16.0),
                ev(event::FILL_QUEUED, 1, (fill / 16 + 1) as f64, fill as f64),
                ev(event::FILL_LINKED, 1, 2.0, end as f64),
            ],
            "{bars} bars"
        );
        assert_eq!(e.pending_fill(), Some(1));
        render_until_fired(&mut e, end as i32 + 1);
        let at = trigger_sample(&e, end);
        assert!(committed_before_notes(&e, 2, at), "{bars} bars");
        for step in fill..end {
            assert_eq!(drums_on(&e, step), vec![(CLAP, 0.7)], "{bars} bars, {step}");
        }
        assert_eq!(
            drums_on(&e, fill - 1),
            vec![(HATS, 0.4)],
            "{bars} bars: no fill before the last bar"
        );
        assert_eq!(
            drums_on(&e, end),
            vec![(KICK, 0.55), (HATS, 0.4)],
            "{bars} bars"
        );
        assert_eq!(e.channels[KICK].vol, 0.9, "{bars} bars: the landing scene");
        let got = events(&mut e);
        assert!(got.contains(&ev(event::FILL_STARTED, 1, fill as f64, 0.0)));
        let landing: Vec<_> = got.iter().copied().filter(|x| x[2] == end as f64).collect();
        assert_eq!(
            landing,
            vec![
                ev(event::PATTERNS_APPLIED, 30, end as f64, 0.0),
                ev(event::BUILD_APPLIED, 2, end as f64, 1.0),
                ev(event::FILL_ENDED, 1, end as f64, 0.0),
            ],
            "{bars} bars"
        );
    }
}

/// Every part a Rise + Fill can be refused for refuses all of it: `fill rejected` and
/// `build rejected` with the same reason and part, its own lanes withdrawn, and a scene,
/// its lanes and a fill already pending left exactly as they were.
#[test]
fn a_refused_rise_with_fill_changes_nothing() {
    use crate::scene::build::detail as part;
    type Send = fn(&mut Engine, &[f32; SCENE_LEN]) -> u8;
    let cases: [(&str, Send, u8, u8); 5] = [
        (
            "3 bars",
            |e, t| e.queue_build_with(2, 3, t, &[], 1, 0, 0),
            reason::INVALID,
            part::BARS,
        ),
        (
            "bad target",
            |e, _| e.queue_build_with(2, 2, &scene(f32::NAN), &[], 1, 0, 0),
            reason::INVALID,
            part::TARGET,
        ),
        (
            "bad landing",
            |e, t| e.queue_build_with(2, 2, t, &scene(0.9)[..9], 1, 0, 0),
            reason::INVALID,
            part::LAND,
        ),
        (
            "no such fill",
            |e, t| e.queue_build_with(2, 2, t, &[], 1, 4, 0),
            reason::INVALID,
            part::FILL,
        ),
        (
            "a fill already queued",
            |e, t| {
                assert_eq!(e.queue_fill_at(9, 0, 4, 0), 0);
                events(e);
                e.queue_build_with(2, 2, t, &[], 1, 0, 0)
            },
            reason::ALREADY_PLAYING,
            part::FILL,
        ),
    ];
    for (name, send, why, at) in cases {
        let mut e = playing_at(5);
        let target = target_from(&e.base());
        e.queue_patterns(50, timing::BAR, 5, &drum(2, &[(16, 0.9)]));
        assert_eq!(e.queue_scene(5, timing::BAR, &scene(0.3)), 0);
        events(&mut e);
        e.queue_patterns(30, timing::BAR, 2, &rise_lanes(48));
        assert_eq!(send(&mut e, &target), why, "{name}");
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::FILL_REJECTED, 1, why as f64, at as f64),
                ev(event::BUILD_REJECTED, 2, why as f64, at as f64),
                ev(event::PATTERNS_CANCELLED, 30, why as f64, 0.0),
            ],
            "{name}"
        );
        assert_eq!(
            (e.pending_build(), e.pending_scene()),
            (None, Some(5)),
            "{name}"
        );
        let busy = why == reason::ALREADY_PLAYING;
        assert_eq!(e.pending_fill(), busy.then_some(9), "{name}");
        let seen = run_until(&mut e, event::SCENE_APPLIED, 5);
        assert!(
            seen.contains(&ev(event::SCENE_APPLIED, 5, 16.0, 0.0)),
            "{name}"
        );
        assert_eq!(lane_ids(&e), vec![50], "{name}");
    }

    let mut stopped = fill_engine();
    let target = target_from(&stopped.base());
    assert_eq!(
        stopped.queue_build_with(2, 2, &target, &[], 1, 0, 0),
        reason::NOT_PLAYING
    );
    assert_eq!(
        events(&mut stopped),
        vec![
            ev(event::FILL_REJECTED, 1, 7.0, 0.0),
            ev(event::BUILD_REJECTED, 2, 7.0, 0.0),
        ]
    );
    // Without a fill, a refused build reports as it always has: no fill event.
    let mut plain = playing_at(5);
    assert_eq!(plain.queue_build_with(2, 3, &target, &[], 0, 0, 0), 1);
    assert_eq!(
        events(&mut plain),
        vec![ev(event::BUILD_REJECTED, 2, 1.0, 1.0)]
    );
}

/// Cancel ends both. Before the fill starts, from either part, the build is cancelled
/// (and restored), its lanes withdrawn and the fill cancelled, all with 10. In the last
/// bar the same, except that the fill runs its bar, unlinked.
#[test]
fn cancelling_a_rise_with_fill_ends_both() {
    for by_fill in [false, true] {
        for in_last_bar in [false, true] {
            let label = format!("by fill {by_fill}, in the last bar {in_last_bar}");
            let mut e = rise_with_fill();
            let before = e.base();
            render_until_fired(&mut e, if in_last_bar { 36 } else { 20 });
            events(&mut e);
            let cancelled = if by_fill {
                e.cancel_fill(1)
            } else {
                e.cancel_build(2)
            };
            assert!(cancelled, "{label}");
            let fill = if in_last_bar {
                ev(event::FILL_UNLINKED, 1, 10.0, 0.0)
            } else {
                ev(event::FILL_CANCELLED, 1, 10.0, 0.0)
            };
            assert_eq!(
                events(&mut e),
                vec![
                    ev(event::BUILD_CANCELLED, 2, 10.0, 0.0),
                    ev(event::PATTERNS_CANCELLED, 30, 10.0, 0.0),
                    fill,
                ],
                "{label}"
            );
            render_until_fired(&mut e, 49);
            let got = events(&mut e);
            if in_last_bar {
                assert_eq!(got, vec![ev(event::FILL_ENDED, 1, 48.0, 0.0)], "{label}");
            } else {
                assert!(got.is_empty(), "{label}: {got:?}");
            }
            assert_eq!(e.base(), before, "{label}: restored");
            assert!(applies(&e).is_empty() && lane_ids(&e).is_empty(), "{label}");
            assert_eq!(drums_on(&e, 48), vec![(KICK, 1.0), (HATS, 0.4)], "{label}");
        }
    }
}

/// Stop, seek, scratch, brake, backspin, a track load, panic and the host's cancel end
/// both parts with their reason, waiting, running, or in the fill's bar.
#[test]
fn interruptions_end_a_rise_with_fill() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, u8); 6] = [
        ("stop", |e| e.stop(), reason::STOPPED),
        ("seek", |e| e.jump(0), reason::TRANSPORT),
        ("scratch", |e| e.scratch_start(), reason::TRANSPORT),
        ("brake", |e| e.brake(), reason::TRANSPORT),
        ("load", |e| e.load_track(fill_track()), reason::TRACK),
        ("panic", |e| e.panic(), reason::PANIC),
    ];
    for at in [10, 20, 40] {
        for (name, action, why) in cases {
            let label = format!("{name} after step {at}");
            let mut e = rise_with_fill();
            render_until_fired(&mut e, at);
            events(&mut e);
            action(&mut e);
            let got = events(&mut e);
            let fill = if at == 40 {
                ev(event::FILL_ENDED, 1, -1.0, why as f64)
            } else {
                ev(event::FILL_CANCELLED, 1, why as f64, 0.0)
            };
            for want in [
                ev(event::BUILD_CANCELLED, 2, why as f64, 0.0),
                ev(event::PATTERNS_CANCELLED, 30, why as f64, 0.0),
                fill,
            ] {
                assert!(
                    got.contains(&want),
                    "{label}: {want:?} missing from {got:?}"
                );
            }
            assert_eq!(
                (
                    e.pending_build(),
                    e.active_build(),
                    e.pending_fill(),
                    e.active_fill()
                ),
                (None, None, None, None),
                "{label}"
            );
        }
    }
}

/// Replaced, the Rise's fill goes with it, reason 11 (linked): cancelled while it
/// waits, unlinked and played out if it is already playing. A scene committing over the
/// Rise, and a newer Rise (which may finish with a fill of its own), both replace it.
#[test]
fn a_replaced_rise_takes_its_fill_along() {
    // A Bar scene committing on 32, the first step of the fill's bar.
    let mut e = rise_with_fill();
    render_until_fired(&mut e, 20);
    assert_eq!(e.queue_scene(3, timing::BAR, &scene(0.2)), 0);
    events(&mut e);
    let seen = run_until(&mut e, event::SCENE_APPLIED, 3);
    for want in [
        ev(event::BUILD_REPLACED, 2, 3.0, 0.0),
        ev(event::PATTERNS_CANCELLED, 30, 10.0, 0.0),
        ev(event::FILL_CANCELLED, 1, 11.0, 0.0),
        ev(event::SCENE_APPLIED, 3, 32.0, 0.0),
    ] {
        assert!(seen.contains(&want), "{want:?} missing from {seen:?}");
    }
    assert!(!seen.iter().any(|x| x[0] == event::FILL_STARTED as f64));

    // A Beat scene committing on 36, inside the fill's bar: the fill runs on, unlinked.
    let mut e = rise_with_fill();
    render_until_fired(&mut e, 33);
    assert_eq!(e.queue_scene(3, timing::BEAT, &scene(0.2)), 0);
    events(&mut e);
    let seen = run_until(&mut e, event::FILL_ENDED, 1);
    for want in [
        ev(event::BUILD_REPLACED, 2, 3.0, 0.0),
        ev(event::FILL_UNLINKED, 1, 11.0, 0.0),
        ev(event::SCENE_APPLIED, 3, 36.0, 0.0),
        ev(event::FILL_ENDED, 1, 48.0, 0.0),
    ] {
        assert!(seen.contains(&want), "{want:?} missing from {seen:?}");
    }

    // A newer Rise with its own fill, while the first waits: accepted (latest wins).
    let mut e = rise_with_fill();
    let target = target_from(&e.base());
    assert_eq!(e.queue_build_with(3, 4, &target, &[], 4, 0, 0), reason::OK);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::BUILD_REPLACED, 2, 3.0, 0.0),
            ev(event::PATTERNS_CANCELLED, 30, 10.0, 0.0),
            ev(event::FILL_CANCELLED, 1, 11.0, 0.0),
            ev(event::BUILD_QUEUED, 3, 2.0, 16.0),
            ev(event::FILL_QUEUED, 4, 5.0, 64.0),
            ev(event::FILL_LINKED, 4, 3.0, 80.0),
        ]
    );
    let seen = run_until(&mut e, event::BUILD_APPLIED, 3);
    assert!(seen.contains(&ev(event::FILL_STARTED, 4, 64.0, 0.0)));
    assert!(seen.contains(&ev(event::FILL_ENDED, 4, 80.0, 0.0)));
    assert!(seen.contains(&ev(event::BUILD_APPLIED, 3, 80.0, 0.0)));
}

/// A loop change while the Rise waits re-announces both parts; the build's count is in
/// onsets, so in a 1-bar loop a 2-bar Rise starts on the loop's bar line, the fill plays
/// the second pass, and the landing is the third. A tempo change moves nothing.
#[test]
fn loop_and_tempo_changes_under_a_rise_with_fill() {
    let mut e = rise_with_fill();
    e.set_loop(1);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::BUILD_QUEUED, 2, 1.0, 0.0),
            ev(event::FILL_QUEUED, 1, 1.0, 0.0),
        ]
    );
    let seen = run_until(&mut e, event::BUILD_APPLIED, 2);
    let at: Vec<_> = seen
        .iter()
        .copied()
        .filter(|x| x[1] == 1.0 || x[1] == 2.0)
        .filter(|x| x[0] != event::BUILD_PROGRESS as f64)
        .collect();
    assert_eq!(
        at,
        vec![
            ev(event::BUILD_STARTED, 2, 0.0, 2.0),
            ev(event::FILL_STARTED, 1, 0.0, 0.0),
            ev(event::BUILD_APPLIED, 2, 0.0, 1.0),
            ev(event::FILL_ENDED, 1, 0.0, 0.0),
        ]
    );

    // Running: the loop moves where the fill's onset falls, so it is re-announced; the
    // onset itself stays put.
    let mut e = rise_with_fill();
    render_until_fired(&mut e, 20);
    let due = e.scheduler.serial() + 12;
    events(&mut e);
    e.set_bpm(120.0);
    e.set_loop(1);
    assert_eq!(events(&mut e), vec![ev(event::FILL_QUEUED, 1, 2.0, 16.0)]);
    let seen = run_until(&mut e, event::FILL_STARTED, 1);
    assert!(seen.contains(&ev(event::FILL_STARTED, 1, 16.0, 0.0)));
    assert_eq!(e.scheduler.serial(), due, "started on its counted onset");
}

/// While a Rise holds the fill slot for its last bar, a plain fill or a Fill into is
/// refused (8): one waiting fill, no stacking.
#[test]
fn a_rise_with_fill_holds_the_fill_slot() {
    let mut e = rise_with_fill();
    assert_eq!(e.queue_fill(7, 0), reason::ALREADY_PLAYING);
    assert_eq!(
        e.queue_fill_into(8, 0, 4, 0, 9, &scene(0.5), 0),
        reason::ALREADY_PLAYING
    );
    assert_eq!(e.pending_fill(), Some(1));
    assert_eq!(e.pending_build(), Some(2));
}

// -- Crash accents --------------------------------------------------------------

/// A scene carrying the crash accent plays the transition crash once, on the onset it
/// commits, for Next Bar, Next Beat and Now (which has no onset: `a` = -1); and the
/// same scene without the accent makes no sound of its own: never automatic.
#[test]
fn an_accented_scene_crashes_once_on_its_commit() {
    use crate::scene::accent;
    for (code, step) in [
        (timing::BAR, 16.0),
        (timing::BEAT, 8.0),
        (timing::NOW, -1.0),
    ] {
        for with in [accent::CRASH, accent::NONE] {
            let label = format!("timing {code}, accent {with}");
            let mut e = playing_at(5);
            assert_eq!(e.queue_scene_with(3, code, &scene(0.5), with), 0, "{label}");
            events(&mut e);
            let seen = run_until(&mut e, event::SCENE_APPLIED, 3);
            let crash = ev(event::ACCENT_FIRED, 3, step, 1.0);
            if with == accent::CRASH {
                let applied = seen
                    .iter()
                    .position(|x| x[0] == event::SCENE_APPLIED as f64);
                let fired = seen.iter().position(|x| *x == crash);
                assert!(applied.is_some() && applied < fired, "{label}: {seen:?}");
                assert_eq!(e.transitions.crashes, 1, "{label}");
                assert!(e.transitions.active(), "{label}: the crash is sounding");
            } else {
                assert!(!seen.iter().any(|x| x[0] == event::ACCENT_FIRED as f64));
                assert_eq!(e.transitions.crashes, 0, "{label}");
            }
            // Once: nothing more over the next two bars.
            render_until_fired(&mut e, 40);
            assert_eq!(e.transitions.crashes, u32::from(with), "{label}");
            assert!(!events(&mut e)
                .iter()
                .any(|x| x[0] == event::ACCENT_FIRED as f64));
        }
    }
}

/// An accented scene landing on the Drop's natural crossing (191 -> 192) crashes once,
/// not twice: `b` = 2, merged. On 192 reached by a loop's wrap, which is not a
/// crossing and has no crash of its own, the accent plays (`b` = 1).
#[test]
fn an_accent_on_the_drop_merges_with_its_crash() {
    let mut e = playing_at(5);
    e.jump(176);
    render_until_fired(&mut e, 180);
    let before = e.transitions.crashes;
    assert_eq!(e.queue_scene_with(3, timing::BAR, &scene(0.5), 1), 0);
    events(&mut e);
    render_until_fired(&mut e, 193);
    assert_eq!(e.transitions.crashes, before + 1, "one crash on 192");
    let got = events(&mut e);
    assert!(got.contains(&ev(event::SCENE_APPLIED, 3, 192.0, 0.0)));
    assert!(
        got.contains(&ev(event::ACCENT_FIRED, 3, 192.0, 2.0)),
        "{got:?}"
    );

    // A 1-bar loop on 192: the wrap back to it is not a crossing.
    e.set_loop(1);
    assert_eq!(e.transport.loop_start, 192);
    render_until_fired(&mut e, 200);
    let before = e.transitions.crashes;
    assert_eq!(e.queue_scene_with(4, timing::BAR, &scene(0.6), 1), 0);
    events(&mut e);
    let seen = run_until(&mut e, event::ACCENT_FIRED, 4);
    assert!(
        seen.contains(&ev(event::ACCENT_FIRED, 4, 192.0, 1.0)),
        "{seen:?}"
    );
    assert_eq!(e.transitions.crashes, before + 1);
}

/// Under a solo (here the scene's own) the accent is counted and silent, as the
/// transition sounds are; applied while stopped it does nothing at all.
#[test]
fn an_accent_is_silent_under_solo_and_absent_when_stopped() {
    let mut soloed = scene(0.5);
    soloed[Stem::Kick.index() * 4 + 3] = 1.0;
    let mut e = playing_at(5);
    assert_eq!(e.queue_scene_with(3, timing::BAR, &soloed, 1), 0);
    events(&mut e);
    let seen = run_until(&mut e, event::SCENE_APPLIED, 3);
    assert!(
        seen.contains(&ev(event::ACCENT_FIRED, 3, 16.0, 0.0)),
        "{seen:?}"
    );
    assert_eq!(e.transitions.crashes, 0);
    assert!(!e.transitions.active());

    let mut stopped = fill_engine();
    assert_eq!(stopped.queue_scene_with(3, timing::BAR, &scene(0.5), 1), 0);
    assert_eq!(
        events(&mut stopped),
        vec![ev(event::SCENE_APPLIED, 3, -1.0, 0.0)]
    );
    assert_eq!(stopped.transitions.crashes, 0);
}

/// A Rise's landing and a Fill into's scene carry the accent too: a crash on the
/// onset they land, after the commit (and the fill's end).
#[test]
fn an_accent_on_a_rise_landing_and_on_fill_into() {
    for with_fill in [0u32, 1] {
        let mut e = playing_at(5);
        let target = target_from(&e.base());
        assert_eq!(
            e.queue_build_with(2, 2, &target, &scene(0.9), with_fill, 0, 1),
            0
        );
        let seen = run_until(&mut e, event::BUILD_APPLIED, 2);
        let tail: Vec<_> = seen.iter().copied().filter(|x| x[2] == 48.0).collect();
        let mut want = vec![ev(event::BUILD_APPLIED, 2, 48.0, 1.0)];
        if with_fill == 1 {
            want.push(ev(event::FILL_ENDED, 1, 48.0, 0.0));
        }
        want.push(ev(event::ACCENT_FIRED, 2, 48.0, 1.0));
        assert_eq!(tail, want, "fill {with_fill}");
        assert_eq!(e.transitions.crashes, 1);
    }

    let mut e = playing_at(5);
    assert_eq!(e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.9), 1), 0);
    let seen = run_until(&mut e, event::SCENE_APPLIED, 2);
    let tail: Vec<_> = seen.iter().copied().filter(|x| x[2] == 64.0).collect();
    assert_eq!(
        tail,
        vec![
            ev(event::SCENE_APPLIED, 2, 64.0, 0.0),
            ev(event::FILL_ENDED, 1, 64.0, 0.0),
            ev(event::ACCENT_FIRED, 2, 64.0, 1.0),
        ]
    );
    assert_eq!(e.transitions.crashes, 1);
}

/// An accent other than 0 or 1 is refused as invalid by all three requests (the
/// scene's part, the landing's part); and an accented request that never lands (here
/// replaced, then cancelled) never crashes.
#[test]
fn a_bad_accent_is_refused_and_an_unlanded_one_is_silent() {
    use crate::scene::build::detail as build_part;
    let mut e = playing_at(5);
    let target = target_from(&e.base());
    assert_eq!(e.queue_scene_with(3, timing::BAR, &scene(0.5), 2), 1);
    assert_eq!(e.queue_fill_into(1, 0, 4, 0, 2, &scene(0.5), 2), 1);
    assert_eq!(e.queue_build_with(4, 2, &target, &[], 0, 0, 7), 1);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::SCENE_REJECTED, 3, 1.0, 0.0),
            ev(event::FILL_REJECTED, 1, 1.0, detail::SCENE as f64),
            ev(event::SCENE_REJECTED, 2, 1.0, detail::SCENE as f64),
            ev(event::BUILD_REJECTED, 4, 1.0, build_part::LAND as f64),
        ]
    );
    assert_eq!(e.queue_scene_with(5, timing::BAR, &scene(0.5), 1), 0);
    assert_eq!(e.queue_scene(6, timing::BAR, &scene(0.4)), 0);
    assert_eq!(e.queue_fill_into(7, 0, 4, 0, 8, &scene(0.5), 1), 0);
    assert!(e.cancel_fill(7));
    render_until_fired(&mut e, 70);
    assert!(!events(&mut e)
        .iter()
        .any(|x| x[0] == event::ACCENT_FIRED as f64));
    assert_eq!(e.transitions.crashes, 0);
}
