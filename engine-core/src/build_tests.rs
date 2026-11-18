//! Timed builds against the real engine (`docs/NIGHT7_PROTOCOL.md`): where a build
//! starts and ends, how the base moves between, what lands on the end, and what
//! cancels or replaces it. Like `scene_tests`, these read the engine's test-only trace
//! for what happened on which sample.

use super::*;
use crate::pattern_tests::{drum, pattern_applies};
use crate::perform::kind;
use crate::scene::build::detail;
use crate::scene_tests::{
    applies, engine, ev, events, groove, render, render_until_fired, scene, triggers_at, RATES,
};
use crate::scheduler::{event, reason, timing, FX_BASE};

const FILTER: usize = FX_BASE;
const LOW: usize = FX_BASE + 2;
const ECHO_TIME: usize = FX_BASE + 5;
const FEEDBACK: usize = FX_BASE + 6;
const RETURN: usize = FX_BASE + 7;
const ROOM: usize = FX_BASE + 8;

fn at(stem: Stem, field: usize) -> usize {
    stem.index() * 4 + field
}

/// Playing, with step 5 just fired (so the next bar line is step 16), the trace and
/// the event ring empty.
fn playing(sr: f32) -> Engine {
    let mut e = engine(sr);
    e.play();
    // An odd block first, so block edges and onsets do not line up by accident.
    render(&mut e, 37, 37);
    render_until_fired(&mut e, 5);
    e.trace.clear();
    events(&mut e);
    e
}

/// `base` with the filter closing, the kick down, the clap's send and the room up
/// and the low isolator down: values from every kind of continuous slot.
fn target_from(base: &[f32; SCENE_LEN]) -> [f32; SCENE_LEN] {
    let mut t = *base;
    t[at(Stem::Kick, 0)] = 0.3;
    t[at(Stem::Clap, 1)] = 0.6;
    t[FILTER] = 0.2;
    t[LOW] = 0.4;
    t[ROOM] = 0.4;
    t
}

/// Render one sample at a time until the next step fires. Returns the step and the
/// sample it fired on.
fn next_onset(e: &mut Engine) -> (usize, u64) {
    let mut l = [0.0f32; 1];
    let mut r = [0.0f32; 1];
    for _ in 0..(e.sample_rate as usize * 4) {
        let mark = e.trace.len();
        e.process(&mut l, &mut r);
        let fired = e.trace[mark..].iter().find_map(|t| match *t {
            Trace::Trigger(step, s) => Some((step, s)),
            _ => None,
        });
        if let Some(found) = fired {
            return found;
        }
    }
    panic!("no step fired");
}

/// Walk onsets until `step` has fired, returning the events seen on the way.
fn walk_to(e: &mut Engine, step: usize) -> Vec<[f64; 4]> {
    let mut seen = Vec::new();
    for _ in 0..(STEPS * 2) {
        let (fired, _) = next_onset(e);
        seen.extend(events(e));
        if fired == step {
            return seen;
        }
    }
    panic!("step {step} never fired");
}

fn is_build(event: &[f64; 4]) -> bool {
    (41.0..=47.0).contains(&event[0])
}

fn build_events(seen: &[[f64; 4]]) -> Vec<[f64; 4]> {
    seen.iter().copied().filter(is_build).collect()
}

fn starts(e: &Engine) -> Vec<(u32, u64)> {
    e.trace
        .iter()
        .filter_map(|t| match *t {
            Trace::BuildStart(id, s) => Some((id, s)),
            _ => None,
        })
        .collect()
}

/// A stem's audible level as the base has it: its fader, or nothing while muted.
fn audible(base: &[f32; SCENE_LEN], stem: Stem) -> f32 {
    if base[at(stem, 2)] == 1.0 {
        0.0
    } else {
        base[at(stem, 0)]
    }
}

/// Queued mid-bar, a build waits for the bar line, starts on that onset's own sample
/// before its notes, and moves nothing until then. The start onset is progress 0; the
/// first step after it has moved one thirty-second of the way on a two-bar build.
#[test]
fn a_build_starts_on_the_next_bar_line_and_moves_nothing_before_it() {
    for sr in RATES {
        let mut e = playing(sr);
        let base0 = e.base();
        let target = target_from(&base0);
        assert_eq!(e.queue_build(1, 2, &target, &[]), 0);
        assert_eq!(events(&mut e), vec![ev(event::BUILD_QUEUED, 1, 2.0, 16.0)]);
        assert_eq!((e.pending_build(), e.active_build()), (Some(1), None));

        for _ in 6..16 {
            let (step, _) = next_onset(&mut e);
            assert_eq!(e.base(), base0, "{sr} Hz: moved on step {step}");
        }
        let (step, sample) = next_onset(&mut e);
        assert_eq!(step, 16);
        assert_eq!(starts(&e), vec![(1, sample)], "{sr} Hz");
        let start = e
            .trace
            .iter()
            .position(|t| matches!(t, Trace::BuildStart(1, _)));
        let notes = e
            .trace
            .iter()
            .position(|t| *t == Trace::Trigger(16, sample));
        assert!(start < notes, "{sr} Hz: notes before the build started");
        assert_eq!(e.base(), base0, "{sr} Hz: the start onset is progress 0");
        assert_eq!(events(&mut e), vec![ev(event::BUILD_STARTED, 1, 16.0, 2.0)]);
        assert_eq!((e.pending_build(), e.active_build()), (None, Some(1)));

        next_onset(&mut e);
        let want = 1.0 + (0.2 - 1.0) / 32.0;
        assert!(
            (e.fx_base[0] - want).abs() < 1e-6,
            "{sr} Hz: {}",
            e.fx_base[0]
        );
    }
}

/// Across 2, 4 and 8 bars every slot moves one way only, the end is exactly `bars`
/// bars after the start, the target is reached exactly on it, and the progress events
/// count the bars. Mutes switch where the stem is silent, solo and the echo time on the
/// end onset. Nothing moves after.
#[test]
fn every_value_moves_steadily_toward_the_target_and_lands_on_it_exactly() {
    for bars in [2u32, 4, 8] {
        let mut e = playing(48_000.0);
        e.set_muted(Stem::Bass, true);
        let base0 = e.base();
        let mut target = target_from(&base0);
        target[at(Stem::Bass, 2)] = 0.0;
        target[at(Stem::Bass, 0)] = 0.7;
        target[at(Stem::Stab, 2)] = 1.0;
        target[at(Stem::Pad, 3)] = 1.0;
        target[ECHO_TIME] = 1.0;
        assert_eq!(e.queue_build(1, bars, &target, &[]), 0);
        let mut seen = walk_to(&mut e, 16);
        let end = 16 + bars as usize * 16;
        let mut prev = e.base();
        assert_eq!(audible(&prev, Stem::Bass), 0.0, "unmuted at 0 on the start");
        assert_eq!(
            prev[at(Stem::Bass, 2)],
            0.0,
            "{bars} bars: unmuted on the start"
        );
        for k in 1..=(bars as usize * 16) {
            let (step, _) = next_onset(&mut e);
            seen.extend(events(&mut e));
            assert_eq!(step, 16 + k, "{bars} bars");
            let now = e.base();
            if step == end {
                assert_eq!(
                    now, target,
                    "{bars} bars: not exactly the target on the end"
                );
                break;
            }
            assert!(
                now[FILTER] < prev[FILTER],
                "{bars} bars, step {step}: filter"
            );
            assert!(now[at(Stem::Kick, 0)] <= prev[at(Stem::Kick, 0)]);
            assert!(now[at(Stem::Clap, 1)] >= prev[at(Stem::Clap, 1)]);
            assert!(now[LOW] <= prev[LOW] && now[ROOM] >= prev[ROOM]);
            assert!(audible(&now, Stem::Bass) >= audible(&prev, Stem::Bass));
            assert!(audible(&now, Stem::Stab) <= audible(&prev, Stem::Stab));
            assert_eq!(now[at(Stem::Stab, 2)], 0.0, "muted only on the end");
            assert_eq!(now[at(Stem::Pad, 3)], 0.0, "solo only on the end");
            assert_eq!(
                now[ECHO_TIME], base0[ECHO_TIME],
                "echo time only on the end"
            );
            for i in 0..SCENE_LEN {
                let (lo, hi) = (base0[i].min(target[i]), base0[i].max(target[i]));
                let lo = if i == at(Stem::Bass, 0) { 0.0 } else { lo };
                let lo = if i == at(Stem::Stab, 0) { 0.0 } else { lo };
                assert!(
                    now[i] >= lo - 1e-6 && now[i] <= hi + 1e-6,
                    "slot {i} at {} outside {lo}..{hi}",
                    now[i]
                );
            }
            prev = now;
        }
        let mut want = vec![
            ev(event::BUILD_QUEUED, 1, 2.0, 16.0),
            ev(event::BUILD_STARTED, 1, 16.0, bars as f64),
        ];
        for k in 2..=bars {
            want.push(ev(event::BUILD_PROGRESS, 1, k as f64, bars as f64));
        }
        want.push(ev(event::BUILD_APPLIED, 1, end as f64, 0.0));
        assert_eq!(build_events(&seen), want, "{bars} bars");
        assert_eq!(e.active_build(), None);

        let mut after = Vec::new();
        for _ in 0..16 {
            next_onset(&mut e);
            after.extend(events(&mut e));
            assert_eq!(e.base(), target, "{bars} bars: moved after the end");
        }
        assert!(build_events(&after).is_empty(), "{after:?}");
    }
}

/// The landing scene is committed whole on the end onset's own sample, before that
/// step's notes, whatever the block size, and the build reports it landed.
#[test]
fn the_landing_scene_lands_on_the_end_onset_before_its_notes() {
    for sr in RATES {
        for block in [128usize, 37] {
            let mut e = playing(sr);
            let target = target_from(&e.base());
            let land = scene(0.25);
            assert_eq!(e.queue_build(3, 2, &target, &land), 0);
            let mut seen = events(&mut e);
            let mut landed = None;
            for _ in 0..(sr as usize * 10 / block) {
                render(&mut e, block, block);
                seen.extend(events(&mut e));
                if let Some(found) = applies(&e).first() {
                    landed = Some(*found);
                    break;
                }
            }
            let (id, sample) = landed.expect("the landing scene applied");
            assert_eq!(id, 3);
            assert_eq!(triggers_at(&e, sample), vec![48], "{sr} Hz, block {block}");
            let apply = e.trace.iter().position(|t| matches!(t, Trace::Apply(3, _)));
            let notes = e
                .trace
                .iter()
                .position(|t| *t == Trace::Trigger(48, sample));
            assert!(apply < notes, "{sr} Hz: notes before the landing");
            assert!(
                !e.trace
                    .iter()
                    .any(|t| matches!(t, Trace::Trigger(48, s) if *s < sample)),
                "{sr} Hz: step 48 fired before the landing"
            );
            assert_eq!(e.channels[0].vol, 0.25);
            assert_eq!(
                e.base().to_vec(),
                land,
                "{sr} Hz: the landing is the whole scene"
            );
            assert_eq!(
                build_events(&seen).last(),
                Some(&ev(event::BUILD_APPLIED, 3, 48.0, 1.0))
            );
            assert!(
                !seen.iter().any(|x| x[0] == event::SCENE_APPLIED as f64),
                "the landing reports through the build"
            );
        }
    }
}

/// Cancelled mid-build, the base goes back to exactly where it started and glides
/// there rather than snapping; `cancelled` is the last word, and nothing about the
/// build is heard of again.
#[test]
fn cancel_mid_build_restores_the_start_and_says_nothing_after() {
    for sr in RATES {
        let mut e = playing(sr);
        let base0 = e.base();
        let target = target_from(&base0);
        assert_eq!(e.queue_build(4, 4, &target, &scene(0.1)), 0);
        let seen = walk_to(&mut e, 37);
        assert_eq!(
            build_events(&seen).last(),
            Some(&ev(event::BUILD_PROGRESS, 4, 2.0, 4.0))
        );
        assert_ne!(e.base(), base0);
        let swept = e.master.sweep_open_value();
        assert!(swept < 0.95, "{sr} Hz: the filter had moved ({swept})");

        assert!(e.cancel_build(4));
        assert!(!e.cancel_build(4), "cancelling twice");
        assert_eq!(
            events(&mut e),
            vec![ev(event::BUILD_CANCELLED, 4, reason::USER as f64, 0.0)]
        );
        assert_eq!(e.base(), base0, "{sr} Hz");
        assert_eq!(e.master.sweep_target(), 1.0);
        render(&mut e, 128, 128);
        let glide = e.master.sweep_open_value();
        assert!(
            glide > swept && glide < 1.0 - 1e-3,
            "{sr} Hz: the filter snapped back ({swept} -> {glide} in one block)"
        );

        e.trace.clear();
        render(&mut e, sr as usize * 12, 128);
        assert!(build_events(&events(&mut e)).is_empty(), "{sr} Hz");
        assert!(applies(&e).is_empty(), "{sr} Hz: the landing landed anyway");
        assert_eq!(e.base(), base0);
        assert_eq!((e.pending_build(), e.active_build()), (None, None));
    }
}

/// Every transport and structural path that cancels a pending scene cancels a build,
/// waiting or running, with its reason, and a running one is restored.
#[test]
fn stop_seek_and_the_other_transport_paths_cancel_the_build() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, u8); 10] = [
        ("stop", |e| e.stop(), reason::STOPPED),
        ("jump", |e| e.jump(0), reason::TRANSPORT),
        ("play again", |e| e.play(), reason::TRANSPORT),
        ("scratch", |e| e.scratch_start(), reason::TRANSPORT),
        ("scratch end", |e| e.scratch_end(32), reason::TRANSPORT),
        ("brake", |e| e.brake(), reason::TRANSPORT),
        ("backspin", |e| e.backspin(), reason::TRANSPORT),
        ("load track", |e| e.load_track(groove()), reason::TRACK),
        ("panic", |e| e.panic(), reason::PANIC),
        (
            "host",
            |e| {
                e.cancel_pending(reason::MIXING);
            },
            reason::MIXING,
        ),
    ];
    for (name, action, why) in cases {
        for running in [false, true] {
            for sr in RATES {
                let mut e = playing(sr);
                let base0 = e.base();
                assert_eq!(e.queue_build(5, 2, &target_from(&base0), &scene(0.15)), 0);
                if running {
                    walk_to(&mut e, 37);
                } else {
                    render(&mut e, 64, 64);
                }
                events(&mut e);
                action(&mut e);
                assert_eq!(
                    events(&mut e),
                    vec![ev(event::BUILD_CANCELLED, 5, why as f64, 0.0)],
                    "{name}, running {running}, {sr} Hz"
                );
                assert_eq!(e.base(), base0, "{name}, running {running}, {sr} Hz");
                assert_eq!((e.pending_build(), e.active_build()), (None, None));
                e.scratch_release();
                if !e.is_playing() {
                    e.play();
                }
                e.trace.clear();
                render(&mut e, sr as usize * 10, 128);
                assert!(build_events(&events(&mut e)).is_empty(), "{name}");
                assert!(applies(&e).is_empty(), "{name}: the landing landed later");
                assert_eq!(e.base(), base0, "{name}");
            }
        }
    }
}

/// A scene committed over a running build replaces it (no restore; the scene is
/// whole), including one due on the same bar line as the build's next progress step.
#[test]
fn a_scene_that_lands_during_a_build_replaces_it() {
    for (code, lands) in [(timing::BAR, 48usize), (timing::BEAT, 40)] {
        let mut e = playing(48_000.0);
        let target = target_from(&e.base());
        e.queue_build(1, 4, &target, &[]);
        walk_to(&mut e, 37);
        assert_eq!(e.queue_scene(9, code, &scene(0.4)), 0);
        events(&mut e);
        let seen = walk_to(&mut e, lands);
        assert_eq!(
            seen,
            vec![
                ev(event::BUILD_REPLACED, 1, 9.0, 0.0),
                ev(event::SCENE_APPLIED, 9, lands as f64, 0.0),
            ],
            "timing {code}"
        );
        assert_eq!(e.base().to_vec(), scene(0.4));
        let after = walk_to(&mut e, 96);
        assert!(build_events(&after).is_empty(), "{after:?}");
        assert_eq!(
            e.base().to_vec(),
            scene(0.4),
            "the build moved on regardless"
        );
    }

    // Now: on the next render call.
    let mut e = playing(48_000.0);
    e.queue_build(1, 2, &target_from(&e.base()), &[]);
    walk_to(&mut e, 20);
    e.queue_scene(9, timing::NOW, &scene(0.4));
    render(&mut e, 1, 1);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::BUILD_REPLACED, 1, 9.0, 0.0),
            ev(event::SCENE_APPLIED, 9, -1.0, 0.0),
        ]
    );
}

/// A scene queued during a build and cancelled before its boundary changes nothing:
/// the build carries on to its end.
#[test]
fn a_scene_queued_and_cancelled_during_a_build_leaves_it_running() {
    let mut e = playing(48_000.0);
    let target = target_from(&e.base());
    e.queue_build(1, 2, &target, &[]);
    walk_to(&mut e, 37);
    e.queue_scene(9, timing::BAR, &scene(0.4));
    assert!(e.cancel_scene(9));
    events(&mut e);
    let seen = walk_to(&mut e, 48);
    assert_eq!(
        build_events(&seen),
        vec![ev(event::BUILD_APPLIED, 1, 48.0, 0.0)]
    );
    assert_eq!(e.base(), target);
}

/// Latest wins between builds, and over a pending scene, each reported as `replaced`
/// with the newer request's id.
#[test]
fn a_newer_build_replaces_a_build_or_a_pending_scene() {
    // A waiting build: replaced at once, and the new one keeps the bar line.
    let mut e = playing(48_000.0);
    let base0 = e.base();
    e.queue_build(1, 2, &target_from(&base0), &[]);
    let mut other = target_from(&base0);
    other[FILTER] = 0.5;
    assert_eq!(e.queue_build(2, 4, &other, &[]), 0);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::BUILD_QUEUED, 1, 2.0, 16.0),
            ev(event::BUILD_REPLACED, 1, 2.0, 0.0),
            ev(event::BUILD_QUEUED, 2, 2.0, 16.0),
        ]
    );
    let seen = walk_to(&mut e, 16);
    assert_eq!(
        build_events(&seen),
        vec![ev(event::BUILD_STARTED, 2, 16.0, 4.0)]
    );

    // A pending scene: replaced by the build, and its bar never comes.
    let mut e = playing(48_000.0);
    e.queue_scene(9, timing::BAR, &scene(0.4));
    assert_eq!(e.queue_build(1, 2, &target_from(&base0), &[]), 0);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::SCENE_QUEUED, 9, 2.0, 16.0),
            ev(event::SCENE_REPLACED, 9, 1.0, 0.0),
            ev(event::BUILD_QUEUED, 1, 2.0, 16.0),
        ]
    );
    assert_eq!(e.pending_scene(), None);
    walk_to(&mut e, 48);
    assert!(!applies(&e).iter().any(|(id, _)| *id == 9));

    // A running build: replaced at once, the mix holds where it got to until the new
    // build's bar line, the new one rises from there, and cancelling it goes all the way
    // back to before the first.
    let mut e = playing(48_000.0);
    e.queue_build(1, 4, &target_from(&base0), &[]);
    walk_to(&mut e, 37);
    let mid = e.base();
    events(&mut e);
    let mut second = base0;
    second[ROOM] = 0.3;
    assert_eq!(e.queue_build(2, 2, &second, &[]), 0);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::BUILD_REPLACED, 1, 2.0, 0.0),
            ev(event::BUILD_QUEUED, 2, 4.0, 48.0),
        ]
    );
    for _ in 38..48 {
        next_onset(&mut e);
        assert_eq!(
            e.base(),
            mid,
            "the handed-over mix moved before the new bar"
        );
    }
    let seen = walk_to(&mut e, 48);
    assert_eq!(
        build_events(&seen),
        vec![ev(event::BUILD_STARTED, 2, 48.0, 2.0)]
    );
    walk_to(&mut e, 53);
    assert!(
        e.base()[FILTER] > mid[FILTER],
        "rising from the handed-over mix"
    );
    assert!(e.cancel_build(2));
    assert_eq!(e.base(), base0, "cancel undoes both builds");
}

/// Bars other than 2, 4 or 8, a bad target or a bad landing are refused with
/// `invalid` and the part named; stopped and mid-gesture are refused too. A refusal
/// leaves a build already queued where it was.
#[test]
fn invalid_requests_are_rejected_with_a_reason() {
    let mut e = playing(48_000.0);
    let good = target_from(&e.base());
    assert_eq!(e.queue_build(1, 2, &good, &[]), 0);
    events(&mut e);
    let mut nan = good;
    nan[FILTER] = f32::NAN;
    let mut toggle = good;
    toggle[2] = 0.5;
    let short = &good[..43];
    /// Name, bars, target, landing, the part `b` names.
    type Case<'a> = (&'a str, u32, &'a [f32], &'a [f32], u8);
    let cases: [Case; 9] = [
        ("0 bars", 0, &good, &[], detail::BARS),
        ("1 bar", 1, &good, &[], detail::BARS),
        ("3 bars", 3, &good, &[], detail::BARS),
        ("16 bars", 16, &good, &[], detail::BARS),
        ("2^32 - 2 bars", u32::MAX - 1, &good, &[], detail::BARS),
        ("NaN target", 2, &nan, &[], detail::TARGET),
        ("short target", 2, short, &[], detail::TARGET),
        ("half toggle landing", 2, &good, &toggle, detail::LAND),
        ("short landing", 2, &good, short, detail::LAND),
    ];
    for (name, bars, target, land, part) in cases {
        let before = e.base();
        assert_eq!(
            e.queue_build(7, bars, target, land),
            reason::INVALID,
            "{name}"
        );
        assert_eq!(
            events(&mut e),
            vec![ev(
                event::BUILD_REJECTED,
                7,
                reason::INVALID as f64,
                part as f64
            )],
            "{name}"
        );
        assert_eq!(e.pending_build(), Some(1), "{name}: the queued build stays");
        assert_eq!(e.base(), before, "{name}");
    }

    let mut stopped = engine(48_000.0);
    assert_eq!(stopped.queue_build(8, 2, &good, &[]), reason::NOT_PLAYING);
    assert_eq!(
        events(&mut stopped),
        vec![ev(
            event::BUILD_REJECTED,
            8,
            reason::NOT_PLAYING as f64,
            0.0
        )]
    );
    for gesture in [Engine::scratch_start, Engine::brake, Engine::backspin] {
        let mut e = engine(48_000.0);
        e.play();
        render(&mut e, 48_000, 128);
        gesture(&mut e);
        events(&mut e);
        assert_eq!(e.queue_build(9, 2, &good, &[]), reason::TRANSPORT);
        assert_eq!(
            events(&mut e),
            vec![ev(event::BUILD_REJECTED, 9, reason::TRANSPORT as f64, 0.0)]
        );
    }
}

/// In a one-bar loop every bar line is step 0. The build still starts once, counts
/// its two bars, ends once and lands once; and one queued on the very sample a bar
/// line fired waits for the next pass.
#[test]
fn a_looping_bar_cannot_end_the_build_twice() {
    for sr in RATES {
        let mut e = playing(sr);
        e.set_loop(1);
        let land = scene(0.45);
        assert_eq!(e.queue_build(1, 2, &target_from(&e.base()), &land), 0);
        assert_eq!(events(&mut e), vec![ev(event::BUILD_QUEUED, 1, 1.0, 0.0)]);
        render(&mut e, sr as usize * 20, 128);
        assert_eq!(
            build_events(&events(&mut e)),
            vec![
                ev(event::BUILD_STARTED, 1, 0.0, 2.0),
                ev(event::BUILD_PROGRESS, 1, 2.0, 2.0),
                ev(event::BUILD_APPLIED, 1, 0.0, 1.0),
            ],
            "{sr} Hz"
        );
        assert_eq!(starts(&e).len(), 1);
        assert_eq!(applies(&e).len(), 1, "{sr} Hz: landed twice");
        assert_eq!(e.base().to_vec(), land);

        // Queued on the sample step 0 fired: that onset is gone.
        render_until_fired(&mut e, 0);
        let fired = e.clock - 1;
        e.trace.clear();
        e.queue_build(2, 2, &target_from(&e.base()), &[]);
        render(&mut e, sr as usize * 3, 128);
        let begun = starts(&e);
        assert_eq!(begun.len(), 1, "{sr} Hz");
        let between = e
            .trace
            .iter()
            .filter(|t| matches!(t, Trace::Trigger(_, s) if *s > fired && *s < begun[0].1))
            .count();
        assert_eq!(between, 15, "{sr} Hz: started on the bar it was queued on");
    }
}

/// Tempo changes while a build runs change how long it takes, never where it ends:
/// exactly `bars * 16` onsets after it started.
#[test]
fn a_tempo_change_mid_build_moves_nothing_in_onsets() {
    for sr in RATES {
        let mut e = playing(sr);
        assert_eq!(e.queue_build(1, 4, &target_from(&e.base()), &scene(0.3)), 0);
        walk_to(&mut e, 20);
        e.set_bpm(171.0);
        walk_to(&mut e, 50);
        e.set_bpm(84.0);
        walk_to(&mut e, 70);
        e.set_bpm(132.0);
        walk_to(&mut e, 80);
        let begun = starts(&e)[0].1;
        let landed = applies(&e)[0].1;
        assert_eq!(triggers_at(&e, landed), vec![80], "{sr} Hz");
        let onsets = e
            .trace
            .iter()
            .filter(|t| matches!(t, Trace::Trigger(_, s) if *s >= begun && *s < landed))
            .count();
        assert_eq!(onsets, 64, "{sr} Hz");
    }
}

/// Held gestures stay on top of the moving base. Filter Hold keeps the filter dark
/// while the build moves the base under it, capture still reads the base, and letting
/// go lands on the base as the build has it now, not where it started. Echo Throw is
/// the same for the return and the feedback.
#[test]
fn a_gesture_held_across_the_build_releases_onto_the_current_base() {
    let mut e = playing(48_000.0);
    let base0 = e.base();
    let mut target = target_from(&base0);
    target[RETURN] = 0.8;
    target[FEEDBACK] = 0.6;
    assert!(e.gesture_begin(5, kind::FILTER_HOLD));
    assert!(e.gesture_begin(6, kind::ECHO_THROW));
    e.queue_build(1, 2, &target, &[]);
    for _ in 6..37 {
        next_onset(&mut e);
        e.gesture_renew(5);
        e.gesture_renew(6);
    }
    let base = e.base();
    assert!(base[FILTER] < 1.0 && base[FILTER] > 0.3, "{}", base[FILTER]);
    assert_eq!(e.master.sweep_target(), crate::perform::FILTER_HOLD_OPEN);
    assert_eq!(e.master.mix_wet(), 0.95, "the throw holds the return open");
    let mut captured = [0.0f32; SCENE_LEN];
    assert!(e.base_into(&mut captured));
    assert_eq!(captured, base, "capture reads the base, never the override");
    assert_eq!(
        e.active_build(),
        Some(1),
        "the gestures did not stop the build"
    );

    assert!(e.gesture_end(5));
    assert!(e.gesture_end(6));
    assert_eq!(
        e.master.sweep_target(),
        base[FILTER],
        "landed on the moving base"
    );
    assert_eq!(e.master.mix_wet(), base[RETURN]);
    assert_eq!(e.master.feedback_target(), base[FEEDBACK]);
    assert_ne!(base[FILTER], base0[FILTER]);

    walk_to(&mut e, 48);
    assert_eq!(e.master.sweep_target(), 0.2);
    assert_eq!(e.master.mix_wet(), 0.8);
}

/// A knob moved while the build runs is the user's: the build stops driving that one
/// slot, the rest carry on to the target, and a cancel does not take the user's value
/// back. A knob moved before the build starts is just where it starts from.
#[test]
fn a_control_moved_during_a_build_is_left_where_the_user_put_it() {
    let mut e = playing(48_000.0);
    let base0 = e.base();
    let target = target_from(&base0);
    e.queue_build(1, 2, &target, &[]);
    walk_to(&mut e, 37);
    e.set_filter(0.9);
    let mut seen = Vec::new();
    for _ in 38..=48 {
        next_onset(&mut e);
        seen.extend(events(&mut e));
        assert_eq!(e.fx_base[0], 0.9);
    }
    assert_eq!(
        build_events(&seen),
        vec![ev(event::BUILD_APPLIED, 1, 48.0, 0.0)]
    );
    let mut want = target;
    want[FILTER] = 0.9;
    assert_eq!(e.base(), want);

    // Cancelled: the user's fader stays, everything else goes back.
    let mut e = playing(48_000.0);
    e.queue_build(1, 4, &target, &[]);
    walk_to(&mut e, 40);
    e.set_volume(Stem::Kick, 0.55);
    e.set_bands(1.0, 1.0, 1.0);
    assert!(e.cancel_build(1));
    let mut want = base0;
    want[at(Stem::Kick, 0)] = 0.55;
    assert_eq!(e.base(), want);

    // Before the start: the build starts from it and still drives it.
    let mut e = playing(48_000.0);
    e.queue_build(1, 2, &target, &[]);
    e.set_filter(0.6);
    walk_to(&mut e, 16);
    assert_eq!(e.fx_base[0], 0.6);
    walk_to(&mut e, 48);
    assert_eq!(e.base(), target);
}

/// A fill queued during a build plays its bar on top of it, and the build carries on.
#[test]
fn a_fill_plays_during_a_build() {
    let mut e = Engine::new(48_000.0);
    let mut t = groove();
    t.fills = vec![Fill {
        kick: vec![0.0; 16],
        clap: vec![0.7; 16],
        hat: vec![0.0; 16],
        hat_open: Vec::new(),
    }];
    e.load_track(t);
    e.play();
    render_until_fired(&mut e, 5);
    events(&mut e);
    let target = target_from(&e.base());
    assert_eq!(e.queue_build(1, 2, &target, &[]), 0);
    assert_eq!(e.queue_fill(2, 0), 0);
    let seen = walk_to(&mut e, 48);
    assert!(seen.contains(&ev(event::FILL_STARTED, 2, 16.0, 0.0)));
    assert!(seen.contains(&ev(event::FILL_ENDED, 2, 32.0, 0.0)));
    assert!(seen.contains(&ev(event::BUILD_STARTED, 1, 16.0, 2.0)));
    assert!(seen.contains(&ev(event::BUILD_APPLIED, 1, 48.0, 0.0)));
    assert_eq!(e.base(), target);
}

/// Changing the loop under a waiting build re-announces it, and it starts where the
/// new prediction says.
#[test]
fn setting_a_loop_re_announces_a_waiting_build() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 40);
    events(&mut e);
    e.queue_build(1, 2, &target_from(&e.base()), &[]);
    e.set_loop(1);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::BUILD_QUEUED, 1, 4.0, 48.0),
            ev(event::BUILD_QUEUED, 1, 3.0, 32.0),
        ]
    );
    let seen = walk_to(&mut e, 32);
    assert_eq!(
        build_events(&seen),
        vec![ev(event::BUILD_STARTED, 1, 32.0, 2.0)]
    );
}

/// The base reads back what the setters wrote, clamped the way the master clamps,
/// and refuses a buffer too short to hold it.
#[test]
fn the_base_reads_back_what_was_set() {
    let mut e = engine(48_000.0);
    e.set_filter(0.4);
    e.set_filter_q(9.0);
    e.set_bands(0.5, 1.6, 0.0);
    e.set_echo_time(0.0);
    e.set_reverb_decay(f32::NAN);
    e.set_stereo_mode(2);
    e.set_muted(Stem::Arp, true);
    let mut out = [0.0f32; SCENE_LEN];
    assert!(e.base_into(&mut out));
    assert_eq!(out[FILTER], 0.4);
    assert_eq!(out[FX_BASE + 1], crate::limits::FILTER_Q_MAX);
    assert_eq!(&out[LOW..LOW + 3], &[0.5, 1.4, 0.0]);
    assert_eq!(out[ECHO_TIME], 0.0);
    assert_eq!(out[FX_BASE + 9], crate::limits::ROOM_RT60);
    assert_eq!(out[FX_BASE + 11], 1.0);
    assert_eq!(out[at(Stem::Arp, 2)], 1.0);
    assert!(!e.base_into(&mut [0.0f32; 43]));
    // A full scene round-trips exactly.
    e.queue_scene(1, timing::NOW, &scene(0.5));
    assert_eq!(e.base().to_vec(), scene(0.5));
}

/// A full mix through an extreme build, an extreme landing and a cancelled build at
/// every rate: every sample finite and under full scale.
#[test]
fn a_build_never_puts_out_a_non_finite_sample() {
    let mut t = Track::silence("dense");
    for s in 0..STEPS {
        t.kick[s] = if s % 4 == 0 { 1.0 } else { 0.0 };
        t.clap[s] = if s % 8 == 4 { 0.9 } else { 0.0 };
        t.hat[s] = 0.5;
        t.bass[s] = Some(NoteEvent::new(vec![45.0], 2.0, 0.9, s % 8 == 0));
        t.lead[s] = (s % 8 == 4).then(|| NoteEvent::new(vec![69.0], 4.0, 0.4, false));
        t.pad[s] = (s % 32 == 0).then(|| NoteEvent::new(vec![52.0, 55.0, 59.0], 16.0, 0.5, false));
    }
    let mut wild = [0.0f32; SCENE_LEN];
    for i in 0..8 {
        wild[i * 4] = 1.0;
        wild[i * 4 + 1] = 1.0;
    }
    wild[FX_BASE..].copy_from_slice(&[0.0, 6.0, 1.4, 1.4, 1.4, 1.5, 0.9, 1.0, 0.5, 2.5, 1.5, 0.0]);
    let mut other = wild;
    other[FX_BASE..]
        .copy_from_slice(&[1.0, 0.5, 0.0, 1.4, 0.0, 0.25, 0.0, 0.0, 0.0, 0.2, 0.0, 1.0]);
    for sr in RATES {
        let mut e = Engine::new(sr);
        e.load_track(t.clone());
        e.play();
        let mut l = vec![0.0f32; 128];
        let mut r = vec![0.0f32; 128];
        let blocks = (sr as usize * 24) / 128;
        assert_eq!(e.queue_build(1, 4, &wild, &other), 0);
        for k in 0..blocks {
            if k == blocks / 2 {
                e.queue_build(2, 2, &other, &[]);
            }
            if k == blocks * 3 / 4 {
                e.cancel_build(2);
            }
            e.process(&mut l, &mut r);
            for (&a, &b) in l.iter().zip(r.iter()) {
                assert!(a.is_finite() && b.is_finite(), "{sr} Hz, block {k}");
                assert!(a.abs() <= 1.0 && b.abs() <= 1.0, "{sr} Hz, block {k}");
            }
        }
    }
}

/// The interpolation rule on its own: endpoints exact, straight lines between, mutes
/// and solos switching where they should.
#[test]
fn value_at_follows_the_rules() {
    use crate::scene::build::value_at;
    let mut from = [0.0f32; SCENE_LEN];
    let mut to = [0.0f32; SCENE_LEN];
    from[0] = 0.8;
    to[0] = 0.2;
    from[4 + 2] = 1.0; // clap muted -> playing at 0.6
    to[4] = 0.6;
    from[8] = 0.5; // hats playing -> muted
    to[8 + 2] = 1.0;
    to[12 + 3] = 1.0; // bass soloed
    from[ECHO_TIME] = 0.75;
    to[ECHO_TIME] = 0.25;
    from[FILTER] = 1.0;
    to[FILTER] = 0.2;
    for (i, p, want) in [
        (0, 0.0, 0.8),
        (0, 0.5, 0.5),
        (0, 1.0, 0.2),
        (4, 0.0, 0.0),
        (4, 0.5, 0.3),
        (4 + 2, 0.0, 0.0),
        (8, 0.5, 0.25),
        (8 + 2, 0.99, 0.0),
        (8 + 2, 1.0, 1.0),
        (12 + 3, 0.99, 0.0),
        (12 + 3, 1.0, 1.0),
        (ECHO_TIME, 0.99, 0.75),
        (ECHO_TIME, 1.0, 0.25),
        (FILTER, 0.25, 0.8),
        (FILTER, 1.5, 0.2),
    ] {
        let got = value_at(i, &from, &to, p);
        assert!(
            (got - want).abs() < 1e-6,
            "slot {i} at {p}: {got}, want {want}"
        );
    }
}

/// The ids of the pattern revisions swapped in so far, in order.
fn lane_ids(e: &Engine) -> Vec<u32> {
    pattern_applies(e).iter().map(|a| a.0).collect()
}

/// Lanes staged for a build go with it: nothing changes while it waits or runs, and on
/// its end onset they swap in on that onset's own sample, after the landing scene and
/// before that step's notes, whatever the block size and with or without a landing.
/// They announce nothing of their own until then, as a scene's linked lanes do.
#[test]
fn a_builds_lanes_commit_on_its_end_onset_before_the_notes() {
    for sr in RATES {
        for block in [128usize, 37] {
            for land in [scene(0.25), Vec::new()] {
                let label = format!("{sr} Hz, block {block}, landing {}", !land.is_empty());
                let mut e = playing(sr);
                let target = target_from(&e.base());
                assert_eq!(
                    e.queue_patterns(20, timing::BAR, 3, &drum(2, &[(48, 0.9)])),
                    reason::OK
                );
                assert_eq!(e.queue_build(3, 2, &target, &land), 0);
                let mut seen = events(&mut e);
                assert_eq!(seen, vec![ev(event::BUILD_QUEUED, 3, 2.0, 16.0)], "{label}");
                let mut landed = None;
                for _ in 0..(sr as usize * 10 / block) {
                    render(&mut e, block, block);
                    seen.extend(events(&mut e));
                    if let Some(found) = pattern_applies(&e).first() {
                        landed = Some(*found);
                        break;
                    }
                    assert_eq!(e.track.hat[48], 0.4, "{label}: the lanes landed early");
                }
                let (id, sample) = landed.expect("the lanes applied");
                assert_eq!(id, 20, "{label}");
                assert_eq!(triggers_at(&e, sample), vec![48], "{label}");
                let lanes = e
                    .trace
                    .iter()
                    .position(|t| matches!(t, Trace::Patterns(20, _)))
                    .expect("lanes traced");
                let notes = e
                    .trace
                    .iter()
                    .position(|t| *t == Trace::Trigger(48, sample))
                    .expect("step 48 traced");
                assert!(lanes < notes, "{label}: notes before the lanes");
                assert!(
                    !e.trace
                        .iter()
                        .any(|t| matches!(t, Trace::Trigger(48, s) if *s < sample)),
                    "{label}: step 48 fired before the lanes"
                );
                if land.is_empty() {
                    assert!(applies(&e).is_empty(), "{label}");
                } else {
                    assert_eq!(applies(&e), vec![(3, sample)], "{label}");
                    let apply = e
                        .trace
                        .iter()
                        .position(|t| matches!(t, Trace::Apply(3, _)))
                        .expect("landing traced");
                    assert!(apply < lanes, "{label}: the lanes before the landing");
                }
                assert_eq!((e.track.hat[48], e.track.hat[16]), (0.9, 0.0), "{label}");
                let ends: Vec<_> = seen
                    .iter()
                    .copied()
                    .filter(|x| {
                        x[0] == event::PATTERNS_APPLIED as f64
                            || x[0] == event::BUILD_APPLIED as f64
                    })
                    .collect();
                let landed_flag = if land.is_empty() { 0.0 } else { 1.0 };
                assert_eq!(
                    ends,
                    vec![
                        ev(event::PATTERNS_APPLIED, 20, 48.0, 0.0),
                        ev(event::BUILD_APPLIED, 3, 48.0, landed_flag),
                    ],
                    "{label}"
                );
                assert!(e.build_lanes.is_none() && e.parked.is_none(), "{label}");
            }
        }
    }
}

/// An edit due on the build's end onset applies first, then the build's lanes, so on
/// the same lane the build's win: the order a scene and an edit keep (Night 4).
#[test]
fn an_edit_due_on_the_end_onset_applies_first_so_the_builds_lanes_win() {
    let mut e = playing(48_000.0);
    e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(48, 0.9)]));
    assert_eq!(e.queue_build(1, 2, &target_from(&e.base()), &[]), 0);
    walk_to(&mut e, 40);
    e.queue_patterns(21, timing::BAR, 0, &drum(2, &[(48, 0.2)]));
    e.trace.clear();
    walk_to(&mut e, 48);
    assert_eq!(lane_ids(&e), vec![21, 20]);
    assert_eq!(e.track.hat[48], 0.9, "the build's lane wins");
}

/// Cancelled, waiting or running, by the user or by any of the paths that cancel a
/// build, the build takes its lanes with it (`patterns cancelled`, same reason, right
/// after `build cancelled`), and they never land. Withdrawn on their own, the build
/// carries on and lands without them.
#[test]
fn a_builds_lanes_are_withdrawn_when_it_is_cancelled() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, u8); 5] = [
        (
            "cancel",
            |e| {
                assert!(e.cancel_build(3));
            },
            reason::USER,
        ),
        ("stop", |e| e.stop(), reason::STOPPED),
        ("seek", |e| e.jump(0), reason::TRANSPORT),
        ("load track", |e| e.load_track(groove()), reason::TRACK),
        ("panic", |e| e.panic(), reason::PANIC),
    ];
    for (name, action, why) in cases {
        for running in [false, true] {
            let mut e = playing(48_000.0);
            e.queue_patterns(20, timing::BAR, 3, &drum(2, &[(48, 0.9)]));
            assert_eq!(e.queue_build(3, 2, &target_from(&e.base()), &scene(0.2)), 0);
            if running {
                walk_to(&mut e, 37);
            }
            events(&mut e);
            action(&mut e);
            assert_eq!(
                events(&mut e),
                vec![
                    ev(event::BUILD_CANCELLED, 3, why as f64, 0.0),
                    ev(event::PATTERNS_CANCELLED, 20, why as f64, 0.0),
                ],
                "{name}, running {running}"
            );
            assert!(e.build_lanes.is_none(), "{name}");
            if !e.is_playing() {
                e.play();
            }
            e.trace.clear();
            render(&mut e, 48_000 * 10, 128);
            assert!(pattern_applies(&e).is_empty(), "{name}, running {running}");
            assert_eq!(e.track.hat[48], 0.4, "{name}, running {running}");
        }
    }

    // The lanes alone: the build lands its mix, and the lanes stay out.
    let mut e = playing(48_000.0);
    e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(48, 0.9)]));
    let target = target_from(&e.base());
    assert_eq!(e.queue_build(1, 2, &target, &[]), 0);
    events(&mut e);
    assert!(e.cancel_patterns(20));
    assert!(!e.cancel_patterns(20), "cancelling twice");
    assert_eq!(
        events(&mut e),
        vec![ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0)]
    );
    let seen = walk_to(&mut e, 48);
    assert!(seen.contains(&ev(event::BUILD_APPLIED, 1, 48.0, 0.0)));
    assert!(pattern_applies(&e).is_empty());
    assert_eq!((e.base(), e.track.hat[48]), (target, 0.4));
}

/// Replaced, the build's lanes go too (`patterns cancelled`, reason 10, as a replaced
/// scene's do). By a newer build, waiting or running: only the newer build's lanes, if
/// it has any, ever land. By a scene committing on an onset: on the audio path, so the
/// lanes are parked, not freed, until the next message; the scene's own lanes land.
#[test]
fn a_builds_lanes_are_withdrawn_when_it_is_replaced() {
    for running in [false, true] {
        for newer_lanes in [false, true] {
            let label = format!("running {running}, newer lanes {newer_lanes}");
            let mut e = playing(48_000.0);
            let base0 = e.base();
            e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(16, 0.9)]));
            assert_eq!(e.queue_build(1, 2, &target_from(&base0), &[]), 0);
            if running {
                walk_to(&mut e, 37);
            }
            events(&mut e);
            if newer_lanes {
                assert_eq!(
                    e.queue_patterns(21, timing::BAR, 2, &drum(2, &[(16, 0.7)])),
                    reason::OK
                );
            }
            assert_eq!(e.queue_build(2, 2, &base0, &[]), 0);
            let got = events(&mut e);
            assert_eq!(
                got[..2],
                [
                    ev(event::BUILD_REPLACED, 1, 2.0, 0.0),
                    ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0),
                ],
                "{label}"
            );
            assert_eq!(got.len(), 3, "{label}: {got:?}");
            assert!(e.parked.is_none(), "{label}: freed in the message handler");
            e.trace.clear();
            render(&mut e, 48_000 * 12, 128);
            let want: Vec<u32> = if newer_lanes { vec![21] } else { vec![] };
            assert_eq!(lane_ids(&e), want, "{label}");
            let hat = if newer_lanes { 0.7 } else { 0.4 };
            assert_eq!(e.track.hat[16], hat, "{label}");
        }
    }

    // A scene with lanes of its own, committing over a running build with lanes.
    let mut e = playing(48_000.0);
    e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(16, 0.9)]));
    assert_eq!(e.queue_build(1, 4, &target_from(&e.base()), &[]), 0);
    walk_to(&mut e, 37);
    e.queue_patterns(22, timing::BAR, 9, &drum(2, &[(16, 0.6)]));
    assert_eq!(e.queue_scene(9, timing::BAR, &scene(0.4)), 0);
    assert_eq!(
        events(&mut e),
        vec![ev(event::SCENE_QUEUED, 9, 4.0, 48.0)],
        "the scene's lanes do not touch the build's"
    );
    e.trace.clear();
    let seen = walk_to(&mut e, 48);
    assert_eq!(
        seen,
        vec![
            ev(event::BUILD_REPLACED, 1, 9.0, 0.0),
            ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0),
            ev(event::PATTERNS_APPLIED, 22, 48.0, 0.0),
            ev(event::SCENE_APPLIED, 9, 48.0, 0.0),
        ]
    );
    assert!(
        e.parked.is_some(),
        "withdrawn on the audio path: parked, not freed"
    );
    walk_to(&mut e, 96);
    assert_eq!(lane_ids(&e), vec![22], "the build's lanes never landed");
    assert_eq!(e.track.hat[16], 0.6);
    e.queue_patterns(23, timing::BAR, 0, &drum(2, &[(16, 0.6)]));
    assert!(e.parked.is_none(), "freed by the next message");
}

/// A refused build's lanes are withdrawn with the refusal's reason, and a build already
/// queued or running keeps its own.
#[test]
fn a_refused_builds_lanes_are_withdrawn_and_the_queued_ones_stay() {
    let mut e = playing(48_000.0);
    let target = target_from(&e.base());
    e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(48, 0.9)]));
    assert_eq!(e.queue_build(1, 2, &target, &[]), 0);
    events(&mut e);
    e.queue_patterns(21, timing::BAR, 7, &drum(2, &[(48, 0.1)]));
    assert_eq!(e.queue_build(7, 3, &target, &[]), reason::INVALID);
    assert_eq!(
        events(&mut e),
        vec![
            ev(
                event::BUILD_REJECTED,
                7,
                reason::INVALID as f64,
                detail::BARS as f64
            ),
            ev(event::PATTERNS_CANCELLED, 21, reason::INVALID as f64, 0.0),
        ]
    );
    let seen = walk_to(&mut e, 48);
    assert!(seen.contains(&ev(event::PATTERNS_APPLIED, 20, 48.0, 0.0)));
    assert_eq!(lane_ids(&e), vec![20]);
    assert_eq!(e.track.hat[48], 0.9);

    let mut stopped = engine(48_000.0);
    stopped.queue_patterns(22, timing::BAR, 8, &drum(2, &[]));
    assert_eq!(stopped.queue_build(8, 2, &target, &[]), reason::NOT_PLAYING);
    assert_eq!(
        events(&mut stopped),
        vec![
            ev(event::BUILD_REJECTED, 8, reason::NOT_PLAYING as f64, 0.0),
            ev(
                event::PATTERNS_CANCELLED,
                22,
                reason::NOT_PLAYING as f64,
                0.0
            ),
        ]
    );
    assert_eq!(stopped.track.hat[0], 0.4);
}

/// A build with no lanes is what it was before builds could carry them: no pattern
/// event of its own and no lane touched on its end; a standalone edit keeps its own
/// bar line; and a pending scene it replaces still takes its lanes with it.
#[test]
fn a_build_without_lanes_touches_no_lanes() {
    let mut e = playing(48_000.0);
    let target = target_from(&e.base());
    e.queue_patterns(30, timing::BAR, 0, &drum(0, &[(16, 1.0)]));
    e.queue_patterns(31, timing::BAR, 9, &drum(2, &[(16, 0.9)]));
    assert_eq!(e.queue_scene(9, timing::BAR, &scene(0.4)), 0);
    events(&mut e);
    assert_eq!(e.queue_build(1, 2, &target, &scene(0.3)), 0);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::SCENE_REPLACED, 9, 1.0, 0.0),
            ev(event::PATTERNS_CANCELLED, 31, reason::USER as f64, 0.0),
            ev(event::BUILD_QUEUED, 1, 2.0, 16.0),
        ]
    );
    assert!(e.build_lanes.is_none() && e.linked.is_none());
    e.trace.clear();
    let seen = walk_to(&mut e, 48);
    assert_eq!(lane_ids(&e), vec![30], "only the edit, on its own bar line");
    let lanes: Vec<_> = seen
        .iter()
        .copied()
        .filter(|x| (31.0..=35.0).contains(&x[0]))
        .collect();
    assert_eq!(lanes, vec![ev(event::PATTERNS_APPLIED, 30, 16.0, 0.0)]);
    assert_eq!(
        build_events(&seen),
        vec![
            ev(event::BUILD_STARTED, 1, 16.0, 2.0),
            ev(event::BUILD_PROGRESS, 1, 2.0, 2.0),
            ev(event::BUILD_APPLIED, 1, 48.0, 1.0),
        ]
    );
    assert_eq!((e.track.hat[16], e.track.kick[16]), (0.4, 1.0));
    assert_eq!(e.base().to_vec(), scene(0.3));
}

/// The Night 7B staging race, from the build side: lanes are staged before their
/// build, so a build that is then refused must not have cost a scene still pending
/// its own lanes. Refused for its bars, its target and its landing alike.
#[test]
fn a_refused_build_leaves_the_pending_scenes_lanes_alone() {
    let good = scene(0.3);
    let mut bad = scene(0.3);
    bad[0] = 7.0;
    /// (bars, target, landing, the part refused, a label)
    type Refusal<'a> = (u32, &'a [f32], &'a [f32], u8, &'a str);
    let cases: [Refusal; 3] = [
        (3, &good, &[], detail::BARS, "bars"),
        (2, &bad, &[], detail::TARGET, "target"),
        (2, &good, &bad, detail::LAND, "landing"),
    ];
    for (bars, target, land, part, label) in cases {
        let mut e = playing(48_000.0);
        e.queue_patterns(20, timing::BAR, 9, &drum(2, &[(16, 0.9)]));
        assert_eq!(e.queue_scene(9, timing::BAR, &scene(0.4)), 0);
        events(&mut e);

        assert_eq!(
            e.queue_patterns(21, timing::BAR, 7, &drum(2, &[(16, 0.1)])),
            reason::OK
        );
        assert!(
            events(&mut e).is_empty(),
            "{label}: staging replaces nothing"
        );
        assert_eq!(
            e.queue_build(7, bars, target, land),
            reason::INVALID,
            "{label}"
        );
        assert_eq!(
            events(&mut e),
            vec![
                ev(
                    event::BUILD_REJECTED,
                    7,
                    reason::INVALID as f64,
                    part as f64
                ),
                ev(event::PATTERNS_CANCELLED, 21, reason::INVALID as f64, 0.0),
            ],
            "{label}"
        );
        assert!(e.staged.is_none() && e.build_lanes.is_none(), "{label}");

        e.trace.clear();
        let seen = walk_to(&mut e, 16);
        assert_eq!(
            seen,
            vec![
                ev(event::PATTERNS_APPLIED, 20, 16.0, 0.0),
                ev(event::SCENE_APPLIED, 9, 16.0, 0.0),
            ],
            "{label}: the pending scene lands with its own lanes"
        );
        assert_eq!(lane_ids(&e), vec![20], "{label}");
        assert_eq!(e.track.hat[16], 0.9, "{label}");
    }
}

/// And the other way round: a scene refused while a build waits or runs with lanes
/// of its own costs the build nothing (its lanes were never in the staging slot).
#[test]
fn a_refused_scene_leaves_the_builds_lanes_alone() {
    for running in [false, true] {
        let label = format!("running {running}");
        let mut e = playing(48_000.0);
        let target = target_from(&e.base());
        e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(48, 0.9)]));
        assert_eq!(e.queue_build(1, 2, &target, &[]), 0);
        if running {
            walk_to(&mut e, 20);
        }
        events(&mut e);
        e.queue_patterns(21, timing::BAR, 9, &drum(2, &[(48, 0.1)]));
        assert_eq!(e.queue_scene(9, 9, &scene(0.4)), reason::INVALID, "{label}");
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::SCENE_REJECTED, 9, reason::INVALID as f64, 0.0),
                ev(event::PATTERNS_CANCELLED, 21, reason::INVALID as f64, 0.0),
            ],
            "{label}"
        );
        e.trace.clear();
        let seen = walk_to(&mut e, 48);
        assert!(
            seen.contains(&ev(event::PATTERNS_APPLIED, 20, 48.0, 0.0)),
            "{label}: {seen:?}"
        );
        assert!(
            seen.contains(&ev(event::BUILD_APPLIED, 1, 48.0, 0.0)),
            "{label}"
        );
        assert_eq!(lane_ids(&e), vec![20], "{label}");
        assert_eq!(e.track.hat[48], 0.9, "{label}");
    }
}

/// An accepted build still wins over a pending scene, and takes that scene's lanes
/// with it; its own staged lanes become the build's. Cancelling the build then
/// withdraws exactly those.
#[test]
fn an_accepted_build_takes_its_staged_lanes_and_replaces_the_pending_scenes() {
    let mut e = playing(48_000.0);
    let target = target_from(&e.base());
    e.queue_patterns(20, timing::BAR, 9, &drum(2, &[(16, 0.9)]));
    assert_eq!(e.queue_scene(9, timing::BAR, &scene(0.4)), 0);
    e.queue_patterns(21, timing::BAR, 1, &drum(2, &[(48, 0.7)]));
    events(&mut e);
    assert_eq!(e.queue_build(1, 2, &target, &[]), 0);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::SCENE_REPLACED, 9, 1.0, 0.0),
            ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0),
            ev(event::BUILD_QUEUED, 1, 2.0, 16.0),
        ]
    );
    assert!(e.staged.is_none() && e.linked.is_none());
    assert_eq!(e.build_lanes.as_ref().map(|l| l.request_id), Some(21));

    walk_to(&mut e, 30);
    events(&mut e);
    assert!(e.cancel_build(1));
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::BUILD_CANCELLED, 1, reason::USER as f64, 0.0),
            ev(event::PATTERNS_CANCELLED, 21, reason::USER as f64, 0.0),
        ]
    );
    e.trace.clear();
    walk_to(&mut e, 64);
    assert!(lane_ids(&e).is_empty(), "no withdrawn lanes ever land");
    assert_eq!((e.track.hat[16], e.track.hat[48]), (0.4, 0.4));
}
