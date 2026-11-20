//! Night 8 fills against the real engine (`docs/NIGHT8_PROTOCOL.md`): phrase-ending
//! fills, Fill into, Rise + Fill and the crash accent. Like `scene_tests`, these read
//! the engine's test-only trace and its event ring.

use super::*;
use crate::scene_tests::{ev, events, groove, render, render_until_fired};
use crate::scheduler::{event, reason};

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
