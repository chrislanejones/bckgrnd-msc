//! Linked lanes as a transaction (`docs/NIGHT4_PROTOCOL.md`, Scenes with lanes;
//! `docs/NIGHT7_PROTOCOL.md`, The request). Lanes staged for a scene or a build belong
//! to that request alone: staging them never touches the lanes another request has
//! already been accepted with, a refused request takes only its own staged lanes with
//! it, an accepted replacement withdraws the lanes of the request it replaces, and a
//! cancel withdraws only the cancelled request's lanes. Scenes and builds (Rise) behave
//! the same way.

use super::*;
use crate::build_tests::{lane_ids, playing, target_from, walk_to};
use crate::pattern_tests::drum;
use crate::scene::build::detail;
use crate::scene_tests::{applies, engine, ev, events, render, scene};
use crate::scheduler::{event, reason, timing};

/// One way the engine refuses a request as invalid, and the event that reports it.
struct Refusal {
    name: &'static str,
    send: fn(&mut Engine, u32) -> u8,
    event: fn(u32) -> [f64; 4],
}

/// Every refusal a request carrying lanes can meet while something is already pending.
/// (A transport refusal cannot meet a pending scene or build: the scratch, brake or
/// backspin that causes it cancels them first.)
fn refusals() -> [Refusal; 5] {
    fn scene_rejected(id: u32) -> [f64; 4] {
        ev(event::SCENE_REJECTED, id, reason::INVALID as f64, 0.0)
    }
    [
        Refusal {
            name: "scene, short vector",
            send: |e, id| e.queue_scene(id, timing::BAR, &scene(0.3)[..SCENE_LEN - 1]),
            event: scene_rejected,
        },
        Refusal {
            name: "scene, unknown timing",
            send: |e, id| e.queue_scene(id, 255, &scene(0.3)),
            event: scene_rejected,
        },
        Refusal {
            name: "build, 3 bars",
            send: |e, id| e.queue_build(id, 3, &scene(0.3), &[]),
            event: |id| {
                ev(
                    event::BUILD_REJECTED,
                    id,
                    reason::INVALID as f64,
                    detail::BARS as f64,
                )
            },
        },
        Refusal {
            name: "build, bad target",
            send: |e, id| e.queue_build(id, 2, &scene(f32::NAN), &[]),
            event: |id| {
                ev(
                    event::BUILD_REJECTED,
                    id,
                    reason::INVALID as f64,
                    detail::TARGET as f64,
                )
            },
        },
        Refusal {
            name: "build, bad landing",
            send: |e, id| e.queue_build(id, 2, &scene(0.3), &scene(0.3)[..10]),
            event: |id| {
                ev(
                    event::BUILD_REJECTED,
                    id,
                    reason::INVALID as f64,
                    detail::LAND as f64,
                )
            },
        },
    ]
}

/// The bug from PARKING_LOT (11-17): a pending scene's lanes, then lanes staged for a
/// request the engine refuses. The refusal takes its own lanes and nothing else; the
/// pending scene still lands with the lanes it was accepted with.
#[test]
fn a_refused_request_leaves_a_pending_scenes_lanes_alone() {
    for r in refusals() {
        let mut e = playing(48_000.0);
        e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(16, 0.9)]));
        assert_eq!(e.queue_scene(1, timing::BAR, &scene(0.5)), reason::OK);
        events(&mut e);

        assert_eq!(
            e.queue_patterns(21, timing::BAR, 2, &drum(2, &[(16, 0.1)])),
            reason::OK
        );
        assert_eq!((r.send)(&mut e, 2), reason::INVALID, "{}", r.name);
        assert_eq!(
            events(&mut e),
            vec![
                (r.event)(2),
                ev(event::PATTERNS_CANCELLED, 21, reason::INVALID as f64, 0.0),
            ],
            "{}: only the refused request's lanes go",
            r.name
        );
        assert_eq!(e.pending_scene(), Some(1), "{}", r.name);

        let seen = walk_to(&mut e, 16);
        assert!(
            seen.contains(&ev(event::PATTERNS_APPLIED, 20, 16.0, 0.0)),
            "{}: {seen:?}",
            r.name
        );
        assert!(seen.contains(&ev(event::SCENE_APPLIED, 1, 16.0, 0.0)));
        assert_eq!(lane_ids(&e), vec![20], "{}", r.name);
        assert_eq!(e.track.hat[16], 0.9, "{}", r.name);
    }
}

/// The same for a build, waiting or running: a refused scene or build takes only its
/// own staged lanes, and the build still lands with its own on its end onset.
#[test]
fn a_refused_request_leaves_a_pending_builds_lanes_alone() {
    for running in [false, true] {
        for r in refusals() {
            let label = format!("{}, running {running}", r.name);
            let mut e = playing(48_000.0);
            e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(48, 0.9)]));
            assert_eq!(e.queue_build(1, 2, &target_from(&e.base()), &[]), 0);
            if running {
                walk_to(&mut e, 37);
            }
            events(&mut e);

            e.queue_patterns(21, timing::BAR, 2, &drum(2, &[(48, 0.1)]));
            assert_eq!((r.send)(&mut e, 2), reason::INVALID, "{label}");
            assert_eq!(
                events(&mut e),
                vec![
                    (r.event)(2),
                    ev(event::PATTERNS_CANCELLED, 21, reason::INVALID as f64, 0.0),
                ],
                "{label}"
            );
            let seen = walk_to(&mut e, 48);
            assert!(
                seen.contains(&ev(event::BUILD_APPLIED, 1, 48.0, 0.0)),
                "{label}"
            );
            assert_eq!(lane_ids(&e), vec![20], "{label}");
            assert_eq!(e.track.hat[48], 0.9, "{label}");
        }
    }
}

/// An accepted scene or build that replaces a pending scene withdraws that scene's
/// lanes (`patterns cancelled`, reason 10, after `scene replaced`), as a replaced
/// scene's always are, whether or not the newer request carries lanes of its own; and
/// only the newer request's lanes ever land.
#[test]
fn an_accepted_replacement_withdraws_the_replaced_scenes_lanes() {
    for by_build in [false, true] {
        for newer_lanes in [false, true] {
            let label = format!("by build {by_build}, newer lanes {newer_lanes}");
            let mut e = playing(48_000.0);
            e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(16, 0.9)]));
            assert_eq!(e.queue_scene(1, timing::BAR, &scene(0.5)), reason::OK);
            events(&mut e);
            if newer_lanes {
                assert_eq!(
                    e.queue_patterns(21, timing::BAR, 2, &drum(2, &[(16, 0.7)])),
                    reason::OK
                );
            }
            let (want, end) = if by_build {
                assert_eq!(e.queue_build(2, 2, &target_from(&e.base()), &[]), 0);
                (
                    vec![
                        ev(event::SCENE_REPLACED, 1, 2.0, 0.0),
                        ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0),
                        ev(event::BUILD_QUEUED, 2, 2.0, 16.0),
                    ],
                    48,
                )
            } else {
                assert_eq!(e.queue_scene(2, timing::BAR, &scene(0.3)), reason::OK);
                (
                    vec![
                        ev(event::SCENE_REPLACED, 1, 2.0, 0.0),
                        ev(event::SCENE_QUEUED, 2, 2.0, 16.0),
                        ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0),
                    ],
                    16,
                )
            };
            assert_eq!(events(&mut e), want, "{label}");
            walk_to(&mut e, end);
            let ids: Vec<u32> = if newer_lanes { vec![21] } else { vec![] };
            assert_eq!(lane_ids(&e), ids, "{label}");
            let hat = if newer_lanes { 0.7 } else { 0.4 };
            assert_eq!(e.track.hat[16], hat, "{label}");
            assert!(!applies(&e).iter().any(|a| a.0 == 1), "{label}");
        }
    }
}

/// A build running with its lanes and a scene queued over it with its own (the scene
/// would replace the build when it lands). Cancelling either withdraws only that
/// request's lanes; the other carries on and lands with its own.
#[test]
fn cancel_withdraws_only_the_cancelled_requests_lanes() {
    for cancel_build in [false, true] {
        let mut e = playing(48_000.0);
        e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(48, 0.9)]));
        assert_eq!(e.queue_build(1, 2, &target_from(&e.base()), &[]), 0);
        walk_to(&mut e, 20);
        e.queue_patterns(21, timing::BAR, 2, &drum(0, &[(33, 1.0)]));
        assert_eq!(e.queue_scene(2, timing::BAR, &scene(0.5)), reason::OK);
        events(&mut e);
        if cancel_build {
            assert!(e.cancel_build(1));
            assert_eq!(
                events(&mut e),
                vec![
                    ev(event::BUILD_CANCELLED, 1, reason::USER as f64, 0.0),
                    ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0),
                ]
            );
            let seen = walk_to(&mut e, 48);
            assert!(seen.contains(&ev(event::SCENE_APPLIED, 2, 32.0, 0.0)));
            assert_eq!(lane_ids(&e), vec![21]);
            assert_eq!((e.track.kick[33], e.track.hat[48]), (1.0, 0.4));
        } else {
            assert!(e.cancel_scene(2));
            assert_eq!(
                events(&mut e),
                vec![
                    ev(event::SCENE_CANCELLED, 2, reason::USER as f64, 0.0),
                    ev(event::PATTERNS_CANCELLED, 21, reason::USER as f64, 0.0),
                ]
            );
            let seen = walk_to(&mut e, 48);
            assert!(seen.contains(&ev(event::BUILD_APPLIED, 1, 48.0, 0.0)));
            assert_eq!(lane_ids(&e), vec![20]);
            assert_eq!((e.track.kick[33], e.track.hat[48]), (0.0, 0.9));
        }
    }
}

/// Staged lanes go only with the request they name. A scene or build accepted under
/// another id never takes them: they are withdrawn (reason 10) as orphans, the same
/// for both. Stopped, a scene still applies at once with its own lanes.
#[test]
fn staged_lanes_go_only_with_their_own_request() {
    for by_build in [false, true] {
        let mut e = playing(48_000.0);
        e.queue_patterns(20, timing::BAR, 5, &drum(2, &[(16, 0.9)]));
        let ok = if by_build {
            e.queue_build(6, 2, &target_from(&e.base()), &[])
        } else {
            e.queue_scene(6, timing::BAR, &scene(0.5))
        };
        assert_eq!(ok, reason::OK);
        let got = events(&mut e);
        assert!(
            got.contains(&ev(event::PATTERNS_CANCELLED, 20, reason::USER as f64, 0.0)),
            "by build {by_build}: {got:?}"
        );
        walk_to(&mut e, 48);
        assert!(lane_ids(&e).is_empty(), "by build {by_build}");
        assert_eq!(e.track.hat[16], 0.4, "by build {by_build}");
    }

    let mut stopped = engine(48_000.0);
    stopped.queue_patterns(20, timing::BAR, 7, &drum(2, &[(16, 0.9)]));
    assert_eq!(stopped.queue_scene(7, timing::BAR, &scene(0.5)), reason::OK);
    assert_eq!(
        events(&mut stopped),
        vec![
            ev(event::PATTERNS_APPLIED, 20, -1.0, 0.0),
            ev(event::SCENE_APPLIED, 7, -1.0, 0.0),
        ]
    );
    assert!(!stopped.is_playing());
    assert_eq!(stopped.track.hat[16], 0.9);

    // Withdrawn on their own before their request: the scene lands without them.
    let mut e = playing(48_000.0);
    e.queue_patterns(20, timing::BAR, 8, &drum(2, &[(16, 0.9)]));
    assert!(e.cancel_patterns(20));
    assert_eq!(e.queue_scene(8, timing::BAR, &scene(0.5)), reason::OK);
    walk_to(&mut e, 16);
    assert!(lane_ids(&e).is_empty());
    assert_eq!(applies(&e).len(), 1);
}

/// Stop, seek, a track load and panic cancel every pending request, so each takes its
/// own lanes with it, with the interruption's reason: the running build's, the pending
/// scene's, and any still staged. None of them lands afterwards.
#[test]
fn an_interruption_withdraws_every_pending_requests_lanes() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, u8); 4] = [
        ("stop", |e| e.stop(), reason::STOPPED),
        ("seek", |e| e.jump(0), reason::TRANSPORT),
        (
            "load track",
            |e| e.load_track(crate::scene_tests::groove()),
            reason::TRACK,
        ),
        ("panic", |e| e.panic(), reason::PANIC),
    ];
    for (name, action, why) in cases {
        let mut e = playing(48_000.0);
        e.queue_patterns(20, timing::BAR, 1, &drum(2, &[(48, 0.9)]));
        assert_eq!(e.queue_build(1, 2, &target_from(&e.base()), &[]), 0);
        walk_to(&mut e, 20);
        e.queue_patterns(21, timing::BAR, 2, &drum(0, &[(33, 1.0)]));
        assert_eq!(e.queue_scene(2, timing::BAR, &scene(0.5)), reason::OK);
        e.queue_patterns(22, timing::BAR, 3, &drum(1, &[(40, 1.0)]));
        events(&mut e);
        action(&mut e);
        let got = events(&mut e);
        for want in [
            ev(event::SCENE_CANCELLED, 2, why as f64, 0.0),
            ev(event::BUILD_CANCELLED, 1, why as f64, 0.0),
            ev(event::PATTERNS_CANCELLED, 20, why as f64, 0.0),
            ev(event::PATTERNS_CANCELLED, 21, why as f64, 0.0),
            ev(event::PATTERNS_CANCELLED, 22, why as f64, 0.0),
        ] {
            assert!(got.contains(&want), "{name}: {want:?} missing from {got:?}");
        }
        assert!(
            e.staged.is_none() && e.scene_lanes.is_none() && e.build_lanes.is_none(),
            "{name}"
        );
        if !e.is_playing() {
            e.play();
        }
        e.trace.clear();
        render(&mut e, 48_000 * 10, 128);
        assert!(lane_ids(&e).is_empty(), "{name}");
        assert!(applies(&e).is_empty(), "{name}");
    }
}
