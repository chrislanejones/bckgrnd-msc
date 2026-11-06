//! Night 3 performance against the real engine: fills, held gestures, the silence
//! rules and panic (`docs/NIGHT3_PROTOCOL.md`). Like `scene_tests`, these read the
//! engine's test-only trace for what fired on which sample.

use super::*;
use crate::perform::kind;
use crate::scene_tests::{
    applies, engine, ev, events, groove, render, render_until_fired, scene, triggers_at, RATES,
};
use crate::scheduler::{event, reason, timing, FX_BASE};

/// The groove (kick on the beat, hats on every step, no clap) with one fill whose
/// every step is a clap and whose kick and closed hats are silent. The open hat is
/// left out of the recipe, so the track's own (silent) open hat plays through.
fn groove_with_fill() -> Track {
    let mut t = groove();
    t.fills = vec![Fill {
        kick: vec![0.0; 16],
        clap: vec![0.7; 16],
        hat: vec![0.0; 16],
        hat_open: Vec::new(),
    }];
    t
}

fn fill_engine(sr: f32) -> Engine {
    let mut e = Engine::new(sr);
    e.load_track(groove_with_fill());
    e
}

/// The drum voices spawned on `step`, as (stem index, velocity), in trace order.
fn drums_on(e: &Engine, step: usize) -> Vec<(usize, f32)> {
    e.trace
        .iter()
        .filter_map(|t| match *t {
            Trace::Drum(stem, s, vel) if s == step => Some((stem, vel)),
            _ => None,
        })
        .collect()
}

/// The sample `step` was triggered on, the first time after the trace was cleared.
fn trigger_sample(e: &Engine, step: usize) -> u64 {
    e.trace
        .iter()
        .find_map(|t| match *t {
            Trace::Trigger(s, at) if s == step => Some(at),
            _ => None,
        })
        .unwrap_or_else(|| panic!("step {step} never triggered"))
}

const KICK: usize = 0;
const CLAP: usize = 1;
const HATS: usize = 2;

/// Queued mid-bar, the fill starts on the next bar's onset (inside a render block),
/// plays its sixteen steps, and the track's drums come back on the step after.
#[test]
fn a_fill_starts_on_the_next_bar_and_lasts_one_bar() {
    for sr in RATES {
        let mut e = fill_engine(sr);
        e.play();
        render(&mut e, 37, 37);
        render_until_fired(&mut e, 5);
        e.trace.clear();
        let start = e.clock;
        assert_eq!(e.queue_fill(3, 0), reason::OK);
        assert_eq!(events(&mut e), vec![ev(event::FILL_QUEUED, 3, 2.0, 16.0)]);
        assert_eq!(e.pending_fill(), Some(3));

        render(&mut e, (sr * 6.0) as usize, 128);
        let at = trigger_sample(&e, 16);
        assert_ne!(
            (at - start) % 128,
            0,
            "{sr} Hz: the bar onset fell on a block edge"
        );
        for step in 6..16 {
            assert_eq!(
                drums_on(&e, step),
                if step % 4 == 0 {
                    vec![(KICK, 1.0), (HATS, 0.4)]
                } else {
                    vec![(HATS, 0.4)]
                },
                "{sr} Hz: step {step} before the fill"
            );
        }
        for step in 16..32 {
            assert_eq!(
                drums_on(&e, step),
                vec![(CLAP, 0.7)],
                "{sr} Hz: step {step} inside the fill"
            );
        }
        assert_eq!(drums_on(&e, 32), vec![(KICK, 1.0), (HATS, 0.4)], "{sr} Hz");
        assert_eq!(drums_on(&e, 33), vec![(HATS, 0.4)], "{sr} Hz");
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::FILL_STARTED, 3, 16.0, 0.0),
                ev(event::FILL_ENDED, 3, 32.0, 0.0),
            ],
            "{sr} Hz"
        );
        assert_eq!(e.active_fill(), None);
    }
}

/// A fill cannot unmute a stem: a cut clap stays silent through a bar of claps.
#[test]
fn a_muted_clap_stays_silent_through_a_fill() {
    let peak = |muted: bool| -> f32 {
        let mut t = Track::silence("claps");
        t.fills = groove_with_fill().fills;
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.set_muted(Stem::Clap, muted);
        e.play();
        assert_eq!(e.queue_fill(1, 0), reason::OK);
        let mut peak = 0.0f32;
        for _ in 0..(2 * 48_000 / 128) {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for v in l.iter().chain(r.iter()) {
                peak = peak.max(v.abs());
            }
            assert_eq!(e.levels()[Stem::Clap.index()] > 0.0, !muted && peak > 0.0);
        }
        assert!(
            events(&mut e).contains(&ev(event::FILL_STARTED, 1, 0.0, 0.0)),
            "the fill played"
        );
        peak
    };
    assert!(peak(false) > 0.01, "the fill's claps are audible unmuted");
    assert_eq!(peak(true), 0.0, "a muted clap sounded through the fill");
}

/// A scene committed on the bar a fill ends lands first, and the drums after it
/// are the track's own under the new mix. A scene mid-fill changes the mix and the
/// fill carries on.
#[test]
fn a_scene_during_a_fill_lands_and_the_fill_ends_into_the_track() {
    let mut e = fill_engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 5);
    e.queue_fill(1, 0);
    render_until_fired(&mut e, 18);
    e.trace.clear();
    // Next beat: step 20, inside the fill.
    assert_eq!(e.queue_scene(2, timing::BEAT, &scene(0.31)), 0);
    render_until_fired(&mut e, 21);
    assert_eq!(e.channels[0].vol, 0.31);
    assert_eq!(drums_on(&e, 20), vec![(CLAP, 0.7)], "the fill carried on");
    // Next bar: step 32, where the fill ends.
    assert_eq!(e.queue_scene(3, timing::BAR, &scene(0.52)), 0);
    render_until_fired(&mut e, 33);
    let at = trigger_sample(&e, 32);
    assert!(applies(&e).contains(&(3, at)));
    let apply = e.trace.iter().position(|t| *t == Trace::Apply(3, at));
    let trigger = e.trace.iter().position(|t| *t == Trace::Trigger(32, at));
    assert!(apply < trigger, "notes before the scene");
    assert_eq!(drums_on(&e, 32), vec![(KICK, 1.0), (HATS, 0.4)]);
    assert_eq!(e.channels[0].vol, 0.52);
    let got = events(&mut e);
    let applied = got
        .iter()
        .position(|x| *x == ev(event::SCENE_APPLIED, 3, 32.0, 0.0));
    let ended = got
        .iter()
        .position(|x| *x == ev(event::FILL_ENDED, 1, 32.0, 0.0));
    assert!(applied.is_some() && applied < ended, "{got:?}");
}

/// Drop and a fill queued for the same bar: the mix is committed first, then the
/// fill starts, then the step's notes fire once each, with no doubled drum.
#[test]
fn drop_and_fill_on_the_same_boundary() {
    for sr in [44_100.0, 48_000.0] {
        let mut e = fill_engine(sr);
        e.play();
        render_until_fired(&mut e, 5);
        e.trace.clear();
        let mut drop = scene(0.4);
        drop[Stem::Clap.index() * 4] = 0.66;
        assert_eq!(e.queue_scene(8, timing::BAR, &drop), 0);
        assert_eq!(e.queue_fill(9, 0), 0);
        render_until_fired(&mut e, 17);
        let at = trigger_sample(&e, 16);
        assert_eq!(triggers_at(&e, at), vec![16], "{sr} Hz: one trigger");
        assert_eq!(
            drums_on(&e, 16),
            vec![(CLAP, 0.7)],
            "{sr} Hz: no doubled drums"
        );
        let apply = e.trace.iter().position(|t| *t == Trace::Apply(8, at));
        let trigger = e.trace.iter().position(|t| *t == Trace::Trigger(16, at));
        assert!(apply.is_some() && apply < trigger, "{sr} Hz");
        assert_eq!(e.channels[Stem::Clap.index()].vol, 0.66);
        let got = events(&mut e);
        assert_eq!(
            got[2..],
            [
                ev(event::SCENE_APPLIED, 8, 16.0, 0.0),
                ev(event::FILL_STARTED, 9, 16.0, 0.0),
            ],
            "{sr} Hz: {got:?}"
        );
    }
}

#[test]
fn a_fill_is_refused_when_it_cannot_play() {
    // Stopped.
    let mut e = fill_engine(48_000.0);
    assert_eq!(e.queue_fill(1, 0), reason::NOT_PLAYING);
    assert_eq!(
        events(&mut e),
        vec![ev(event::FILL_REJECTED, 1, reason::NOT_PLAYING as f64, 0.0)]
    );
    // No such fill, and a track with none.
    e.play();
    assert_eq!(e.queue_fill(2, 1), reason::INVALID);
    let mut bare = engine(48_000.0);
    bare.play();
    assert_eq!(bare.queue_fill(2, 0), reason::INVALID);
    // One queued: a second is refused and the first keeps its bar.
    render_until_fired(&mut e, 5);
    events(&mut e);
    assert_eq!(e.queue_fill(3, 0), reason::OK);
    assert_eq!(e.queue_fill(4, 0), reason::ALREADY_PLAYING);
    assert_eq!(e.pending_fill(), Some(3));
    // Playing: refused.
    render_until_fired(&mut e, 20);
    assert_eq!(e.active_fill(), Some(3));
    assert_eq!(e.queue_fill(5, 0), reason::ALREADY_PLAYING);
    let got = events(&mut e);
    assert!(got.contains(&ev(event::FILL_REJECTED, 4, 8.0, 0.0)));
    assert!(got.contains(&ev(event::FILL_REJECTED, 5, 8.0, 0.0)));
    // Under a scratch.
    let mut s = fill_engine(48_000.0);
    s.play();
    render(&mut s, 4_800, 128);
    s.scratch_start();
    assert_eq!(s.queue_fill(6, 0), reason::TRANSPORT);
}

/// Cancel withdraws a queued fill; a playing one runs its bar.
#[test]
fn cancel_fill_withdraws_only_a_queued_fill() {
    let mut e = fill_engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 5);
    e.queue_fill(1, 0);
    assert!(!e.cancel_fill(2), "another id");
    assert!(e.cancel_fill(1));
    assert!(!e.cancel_fill(1), "twice");
    e.trace.clear();
    render_until_fired(&mut e, 17);
    assert_eq!(drums_on(&e, 16), vec![(KICK, 1.0), (HATS, 0.4)]);
    let got = events(&mut e);
    assert_eq!(
        got[1],
        ev(event::FILL_CANCELLED, 1, reason::USER as f64, 0.0)
    );
    e.queue_fill(2, 0);
    render_until_fired(&mut e, 33);
    assert_eq!(e.active_fill(), Some(2));
    assert!(!e.cancel_fill(2), "playing");
    render_until_fired(&mut e, 48);
    assert_eq!(e.active_fill(), None);
}

/// The tempo moving under a fill moves no boundary: it still starts and ends on step
/// onsets, sixteen of them apart.
#[test]
fn a_tempo_change_mid_fill_keeps_it_on_step_boundaries() {
    for sr in [44_100.0, 96_000.0] {
        let mut e = fill_engine(sr);
        e.play();
        render_until_fired(&mut e, 5);
        e.queue_fill(1, 0);
        e.trace.clear();
        render_until_fired(&mut e, 19);
        e.set_bpm(171.0);
        render_until_fired(&mut e, 26);
        e.set_bpm(84.0);
        render_until_fired(&mut e, 33);
        for step in 16..32 {
            assert_eq!(drums_on(&e, step), vec![(CLAP, 0.7)], "{sr} Hz step {step}");
        }
        assert_eq!(drums_on(&e, 32), vec![(KICK, 1.0), (HATS, 0.4)], "{sr} Hz");
        let got = events(&mut e);
        assert_eq!(
            got[got.len() - 2..],
            [
                ev(event::FILL_STARTED, 1, 16.0, 0.0),
                ev(event::FILL_ENDED, 1, 32.0, 0.0)
            ],
            "{sr} Hz"
        );
    }
}

/// Every structural event cancels a queued fill and cuts short a playing one, with
/// its reason; nothing of the fill plays afterwards.
#[test]
fn stop_seek_load_and_panic_end_fills() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, u8); 7] = [
        ("stop", |e| e.stop(), reason::STOPPED),
        ("seek", |e| e.jump(64), reason::TRANSPORT),
        ("play again", |e| e.play(), reason::TRANSPORT),
        ("scratch", |e| e.scratch_start(), reason::TRANSPORT),
        ("load", |e| e.load_track(groove_with_fill()), reason::TRACK),
        (
            "host",
            |e| {
                e.cancel_pending(reason::TRACK);
            },
            reason::TRACK,
        ),
        ("panic", |e| e.panic(), reason::PANIC),
    ];
    for (name, action, why) in cases {
        for active in [false, true] {
            let mut e = fill_engine(48_000.0);
            e.play();
            render_until_fired(&mut e, 5);
            e.queue_fill(4, 0);
            if active {
                render_until_fired(&mut e, 18);
            }
            events(&mut e);
            action(&mut e);
            let want = if active {
                ev(event::FILL_ENDED, 4, -1.0, why as f64)
            } else {
                ev(event::FILL_CANCELLED, 4, why as f64, 0.0)
            };
            assert_eq!(events(&mut e), vec![want], "{name}, active {active}");
            assert_eq!((e.pending_fill(), e.active_fill()), (None, None), "{name}");
            e.scratch_release();
            if !e.is_playing() {
                e.play();
            }
            e.trace.clear();
            render(&mut e, 48_000 * 3, 128);
            assert!(
                !e.trace.iter().any(|t| matches!(t, Trace::Drum(CLAP, _, _))),
                "{name}: the fill played on"
            );
        }
    }
}

/// A loop set under a queued fill re-announces it with the new bar.
#[test]
fn a_loop_change_re_announces_the_queued_fill() {
    let mut e = fill_engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 40);
    e.queue_fill(1, 0);
    e.set_loop(1);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::FILL_QUEUED, 1, 4.0, 48.0),
            ev(event::FILL_QUEUED, 1, 3.0, 32.0)
        ]
    );
}

// -- Gestures -----------------------------------------------------------------

fn playing(sr: f32) -> Engine {
    let mut e = engine(sr);
    e.play();
    render(&mut e, 4_800, 128);
    e
}

/// The bug this design exists to prevent: hold an effect, let a scene (or a knob)
/// change the base under it, let go, and land on the *new* base.
#[test]
fn hold_then_scene_then_release_lands_on_the_new_base() {
    // Filter Hold.
    let mut e = playing(48_000.0);
    e.set_filter(0.9);
    e.set_filter_q(0.85);
    assert!(e.gesture_begin(10, kind::FILTER_HOLD));
    assert_eq!(e.master.sweep_target(), mixer::FILTER_HOLD_OPEN);
    assert_eq!(e.master.sweep_q_target(), mixer::FILTER_HOLD_Q);
    let v = scene(0.5); // filter 0.7, Q 1.2
    assert_eq!(e.queue_scene(1, timing::NOW, &v), 0);
    render(&mut e, 128, 128);
    assert_eq!(e.master.filter_base(), v[FX_BASE]);
    assert_eq!(
        e.master.sweep_target(),
        mixer::FILTER_HOLD_OPEN,
        "still held"
    );
    assert!(e.gesture_end(10));
    assert_eq!(
        e.master.sweep_target(),
        v[FX_BASE],
        "landed on the scene's filter"
    );
    assert_eq!(e.master.sweep_q_target(), v[FX_BASE + 1]);

    // Echo Throw.
    let mut e = playing(48_000.0);
    e.set_echo_feedback(0.2);
    e.set_echo_return(0.24);
    assert!(e.gesture_begin(11, kind::ECHO_THROW));
    assert!(e.master.echo_on());
    assert!(e.master.mix_wet() > 0.9);
    let mut v = scene(0.5);
    v[FX_BASE + 6] = 0.5; // feedback
    v[FX_BASE + 7] = 0.4; // return
    assert_eq!(e.queue_scene(2, timing::NOW, &v), 0);
    render(&mut e, 128, 128);
    assert!(e.master.mix_wet() > 0.9, "still thrown");
    assert!(e.master.feedback_target() >= 0.78, "still thrown");
    assert!(e.gesture_end(11));
    assert!(!e.master.echo_on());
    assert_eq!(e.master.mix_wet(), 0.4, "the scene's return");
    assert_eq!(e.master.feedback_target(), 0.5, "the scene's feedback");
    assert!(!e.echo_enabled(), "the override never reads as the base");
}

/// A knob moved under a held effect moves the base; letting go lands on it.
#[test]
fn a_knob_under_a_held_effect_moves_the_base() {
    let mut e = playing(48_000.0);
    e.gesture_begin(1, kind::FILTER_HOLD);
    e.set_filter(0.6);
    assert_eq!(e.master.sweep_target(), mixer::FILTER_HOLD_OPEN);
    // A base already darker than the hold stays where it is; the hold adds the Q.
    e.set_filter(0.12);
    assert_eq!(e.master.sweep_target(), 0.12);
    e.set_filter_q(5.0);
    assert_eq!(e.master.sweep_q_target(), 5.0, "a higher base Q is kept");
    e.set_filter_q(1.0);
    assert_eq!(e.master.sweep_q_target(), mixer::FILTER_HOLD_Q);
    e.gesture_begin(2, kind::ECHO_THROW);
    e.set_echo_return(0.61);
    e.set_echo_feedback(0.1);
    assert!(e.master.mix_wet() > 0.9);
    e.gesture_end(1);
    e.gesture_end(2);
    assert_eq!(e.master.sweep_target(), 0.12);
    assert_eq!(e.master.sweep_q_target(), 1.0);
    assert_eq!(e.master.mix_wet(), 0.61);
    assert_eq!(e.master.feedback_target(), 0.1);
    // And the audio gets there: the sweep settles on the base.
    render(&mut e, 48_000, 128);
    assert!((e.master.sweep_open_value() - 0.12).abs() < 1e-3);
}

/// Two overlapping tokens of one kind, released in either order: ending one never
/// ends the other, and only the last one out reveals the base. Different kinds are
/// independent.
#[test]
fn two_overlapping_tokens_release_in_either_order() {
    for first_out in [1u32, 2] {
        let mut e = playing(48_000.0);
        e.set_filter(0.8);
        e.gesture_begin(1, kind::FILTER_HOLD);
        e.gesture_begin(2, kind::FILTER_HOLD);
        e.gesture_begin(3, kind::ECHO_THROW);
        assert!(e.gesture_end(first_out));
        assert_eq!(
            e.master.sweep_target(),
            mixer::FILTER_HOLD_OPEN,
            "{first_out}"
        );
        assert!(!e.gesture_end(first_out), "ended twice");
        assert!(e.gesture_end(3 - first_out));
        assert_eq!(e.master.sweep_target(), 0.8, "{first_out}");
        assert!(e.master.echo_on(), "the echo token is its own");
        assert!(e.gesture_end(3));
        assert!(!e.master.echo_on());
    }
    let mut e = playing(48_000.0);
    for t in 0..4 {
        assert!(e.gesture_begin(t, kind::ECHO_THROW));
    }
    assert!(!e.gesture_begin(4, kind::FILTER_HOLD), "four at most");
    assert!(
        !e.gesture_begin(0, kind::ECHO_THROW),
        "a token already held"
    );
    assert!(!e.gesture_begin(9, 7), "an unknown kind");
}

/// An override expires after 3 s of rendered audio unless renewed, reports it, and
/// puts the base back. Renewed, it stays.
#[test]
fn a_lease_expires_without_renew() {
    for sr in [44_100.0, 48_000.0] {
        let mut e = playing(sr);
        e.set_filter(0.75);
        events(&mut e);
        e.gesture_begin(7, kind::FILTER_HOLD);
        e.gesture_begin(8, kind::ECHO_THROW);
        let lease = (3.0 * sr) as usize;
        for _ in 0..4 {
            render(&mut e, lease / 3, 128);
            assert!(e.gesture_renew(8));
        }
        // 4 s in: 7 expired at 3 s, 8 was renewed every second.
        assert_eq!(e.master.sweep_target(), 0.75, "{sr} Hz");
        assert!(e.master.echo_on(), "{sr} Hz: the renewed one is held");
        assert!(!e.gesture_renew(7) && !e.gesture_end(7), "expired");
        assert_eq!(
            events(&mut e),
            vec![ev(event::GESTURE_EXPIRED, 7, kind::FILTER_HOLD as f64, 0.0)],
            "{sr} Hz"
        );
        // Just short of the lease, then past it.
        render(&mut e, lease - 256, 128);
        assert!(e.master.echo_on());
        render(&mut e, 512, 128);
        assert!(!e.master.echo_on(), "{sr} Hz");
        assert_eq!(
            events(&mut e),
            vec![ev(event::GESTURE_EXPIRED, 8, kind::ECHO_THROW as f64, 0.0)]
        );
    }
}

/// The latched throw from the older UI toggle still works, and is not leased.
#[test]
fn the_latched_echo_throw_still_works_and_is_not_leased() {
    let mut e = playing(48_000.0);
    e.set_echo(true);
    assert!(e.master.echo_on() && e.echo_enabled());
    // A gesture ending under the latch leaves the throw on.
    e.gesture_begin(1, kind::ECHO_THROW);
    e.gesture_end(1);
    render(&mut e, 48_000 * 4, 128);
    assert!(e.master.echo_on(), "the latch expired");
    e.stop();
    assert!(e.master.echo_on(), "Stop keeps the UI's latch");
    e.set_echo(false);
    assert!(!e.master.echo_on());
}

/// Release FX ends every override and the latch, and leaves the working mix alone.
#[test]
fn release_gestures_ends_everything_and_keeps_the_mix() {
    let mut e = playing(48_000.0);
    e.set_filter(0.66);
    e.set_echo_return(0.33);
    let vols = e.volumes();
    e.set_echo(true);
    e.gesture_begin(1, kind::FILTER_HOLD);
    e.gesture_begin(2, kind::ECHO_THROW);
    e.release_gestures();
    assert!(!e.master.echo_on() && !e.echo_enabled());
    assert_eq!(e.master.sweep_target(), 0.66);
    assert_eq!(e.master.mix_wet(), 0.33);
    assert_eq!(e.volumes(), vols);
    assert!(!e.gesture_end(1) && !e.gesture_end(2));
}

/// Stop, a track load and panic release held gestures; a seek keeps them.
#[test]
fn stop_load_and_panic_release_gestures_and_a_seek_keeps_them() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, bool); 4] = [
        ("stop", |e| e.stop(), true),
        ("load", |e| e.load_track(groove()), true),
        ("panic", |e| e.panic(), true),
        ("seek", |e| e.jump(32), false),
    ];
    for (name, action, released) in cases {
        let mut e = playing(48_000.0);
        e.set_filter(0.5);
        e.gesture_begin(1, kind::FILTER_HOLD);
        e.gesture_begin(2, kind::ECHO_THROW);
        action(&mut e);
        assert_eq!(e.master.echo_on(), !released, "{name}");
        assert_eq!(e.master.sweep_target() == 0.5, released, "{name}");
        assert_eq!(e.gesture_end(1), !released, "{name}");
    }
}

/// Filter Hold is a treatment, not a boost: a dense mix under it is no louder than
/// with the filter open, and audibly darker.
#[test]
fn filter_hold_darkens_without_getting_louder() {
    let rms = |hold: bool, bass: bool| -> f32 {
        let mut t = groove();
        for s in 0..STEPS {
            t.clap[s] = if s % 8 == 4 { 0.9 } else { 0.0 };
            if bass {
                t.bass[s] = Some(NoteEvent::new(vec![45.0], 2.0, 0.9, false));
            }
            t.stab[s] =
                (s % 4 == 2).then(|| NoteEvent::new(vec![57.0, 60.0, 64.0], 1.0, 0.6, false));
            t.lead[s] = (s % 8 == 0).then(|| NoteEvent::new(vec![69.0, 76.0], 4.0, 0.5, false));
        }
        let mut e = Engine::new(48_000.0);
        e.load_track(t);
        e.play();
        if hold {
            e.gesture_begin(1, kind::FILTER_HOLD);
        }
        render(&mut e, 4_800, 128);
        let mut acc = 0.0f64;
        let n = 4 * 48_000 / 128;
        for _ in 0..n {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            if hold {
                e.gesture_renew(1);
            }
            acc += l
                .iter()
                .chain(r.iter())
                .map(|v| (v * v) as f64)
                .sum::<f64>();
        }
        (acc / (n * 256) as f64).sqrt() as f32
    };
    for bass in [true, false] {
        let (open, held) = (rms(false, bass), rms(true, bass));
        assert!(
            held <= open,
            "bass {bass}: the hold got louder: {held} vs {open}"
        );
        assert!(
            held > open * 0.6,
            "bass {bass}: the hold all but silenced the mix: {held} vs {open}"
        );
    }
}

// -- Silence, solo and transition sounds ---------------------------------------

/// A lead line through a long echo and a big room: something with a tail.
fn tail_track() -> Track {
    let mut t = Track::silence("tails");
    for s in (0..STEPS).step_by(4) {
        t.lead[s] = Some(NoteEvent::new(vec![69.0], 2.0, 0.8, false));
    }
    t
}

fn tail_engine() -> Engine {
    let mut e = Engine::new(48_000.0);
    e.load_track(tail_track());
    e.set_send(Stem::Lead, 0.8);
    e.set_echo_feedback(0.7);
    e.set_echo_return(0.6);
    e.set_reverb_mix(0.4);
    e.set_reverb_decay(2.0);
    e.play();
    render(&mut e, 2 * 48_000, 128);
    e
}

/// Summed |L| + |R| over the next `ms` milliseconds.
fn energy_ms(e: &mut Engine, ms: usize) -> f32 {
    let mut total = 0.0f32;
    for _ in 0..(ms * 48 / 128).max(1) {
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        e.process(&mut l, &mut r);
        total += l.iter().chain(r.iter()).map(|v| v.abs()).sum::<f32>();
    }
    total
}

/// One cut lets the tails ring; soloing another stem clears them.
#[test]
fn entering_solo_clears_the_return_history_and_a_single_cut_does_not() {
    let mut cut = tail_engine();
    cut.set_muted(Stem::Lead, true);
    energy_ms(&mut cut, 100);
    let ringing = energy_ms(&mut cut, 400);
    assert!(ringing > 20.0, "a single cut stopped the tails: {ringing}");

    let mut solo = tail_engine();
    // The pad has nothing to play, so whatever is heard is the lead's tail.
    solo.set_solo(Stem::Pad, true);
    let mut l = [0.0f32; 128];
    let mut r = [0.0f32; 128];
    let mut last = 0.0f32;
    let mut jump = 0.0f32;
    for _ in 0..(100 * 48 / 128) {
        solo.process(&mut l, &mut r);
        for v in l.iter() {
            jump = jump.max((v - last).abs());
            last = *v;
        }
    }
    assert!(jump < 0.2, "the flush clicked: a step of {jump}");
    let after = energy_ms(&mut solo, 400);
    assert!(
        after < ringing * 0.01,
        "the tail kept ringing under the solo: {after} vs {ringing} after a cut"
    );
}

/// Every stem cut fades the whole output to silence over about 30 ms, returns
/// included, and un-cutting brings it back.
#[test]
fn cutting_every_stem_fades_the_output_to_silence() {
    let mut e = tail_engine();
    e.set_echo(true);
    render(&mut e, 4_800, 128);
    for s in Stem::ALL {
        e.set_muted(s, true);
    }
    let first = energy_ms(&mut e, 8);
    assert!(first > 0.5, "the gate cut rather than faded: {first}");
    energy_ms(&mut e, 32);
    let mut peak = 0.0f32;
    for _ in 0..(500 * 48 / 128) {
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        e.process(&mut l, &mut r);
        for v in l.iter().chain(r.iter()) {
            peak = peak.max(v.abs());
        }
    }
    assert!(
        peak < 1e-4,
        "the returns still sound with every stem cut: {peak}"
    );
    e.set_muted(Stem::Kick, false);
    energy_ms(&mut e, 40);
    assert_eq!(e.cut_gate, 1.0, "un-cutting did not open the gate");
}

/// The gate is a policy about the stems, not a blanket mute: a scratch and a
/// backspin are heard with every stem cut.
#[test]
fn scratch_and_backspin_play_through_the_all_cut_gate() {
    let mut e = tail_engine();
    for s in Stem::ALL {
        e.set_muted(s, true);
    }
    energy_ms(&mut e, 100);
    assert_eq!(e.cut_gate, 0.0);
    e.scratch_start();
    e.scratch_rate(-1.0);
    let scratch = energy_ms(&mut e, 300);
    assert!(scratch > 5.0, "the scratch was gated: {scratch}");
    e.scratch_end(0);
    energy_ms(&mut e, 100);
    e.backspin();
    let spin = energy_ms(&mut e, 400);
    assert!(spin > 5.0, "the backspin was gated: {spin}");
}

/// A soloed stem keeps the song's seams quiet: no crash on the Drop, no riser
/// before it, and soloing mid-riser fades the riser away.
#[test]
fn solo_suppresses_transitions_at_a_section_seam() {
    let mut e = engine(48_000.0);
    e.play();
    e.set_solo(Stem::Kick, true);
    e.jump(186);
    render_until_fired(&mut e, 194);
    assert!(!e.transitions.active(), "a crash under a solo");
    e.jump(158);
    render_until_fired(&mut e, 175);
    assert!(!e.transitions.active(), "a riser under a solo");

    let mut e = engine(48_000.0);
    e.play();
    e.jump(158);
    render_until_fired(&mut e, 170);
    assert!(e.transitions.active(), "no riser to suppress");
    e.set_solo(Stem::Hats, true);
    render(&mut e, 48_000 / 5, 128);
    assert!(!e.transitions.active(), "the riser outlived the solo");
    // Leaving solo needs nothing special: the next seam fires as usual.
    e.set_solo(Stem::Hats, false);
    e.jump(186);
    render_until_fired(&mut e, 193);
    assert!(e.transitions.active(), "no crash after leaving solo");
}

/// A scene launch on its own makes no transition sound, whatever it changes.
#[test]
fn a_scene_launch_alone_makes_no_transition_sound() {
    let mut e = engine(48_000.0);
    e.play();
    let mut solo = scene(0.7);
    solo[3] = 1.0;
    let mut cut = scene(0.2);
    cut[Stem::Bass.index() * 4 + 2] = 1.0;
    for (i, (t, v)) in [
        (timing::NOW, scene(0.5)),
        (timing::BAR, cut),
        (timing::BEAT, solo),
        (timing::BAR, scene(0.9)),
        (timing::NOW, scene(0.1)),
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(e.queue_scene(i as u32, t, &v), 0);
        for _ in 0..(48_000 / 128) {
            render(&mut e, 128, 128);
            assert!(!e.transitions.active(), "scene {i} made a transition sound");
        }
    }
    assert!(e.visual_step() < 120, "ran into the Break seam");
}

/// Panic: everything queued cancelled (`panic`), a playing fill cut short, every
/// gesture and the latch released, playback stopped, the tails cleared.
#[test]
fn panic_does_all_of_it() {
    let mut e = fill_engine(48_000.0);
    e.set_send(Stem::Hats, 0.9);
    e.play();
    render_until_fired(&mut e, 5);
    e.queue_fill(1, 0);
    render_until_fired(&mut e, 18);
    assert_eq!(e.queue_scene(2, timing::BAR, &scene(0.3)), 0);
    e.set_echo(true);
    e.gesture_begin(3, kind::FILTER_HOLD);
    e.gesture_begin(4, kind::ECHO_THROW);
    events(&mut e);
    e.panic();
    let got = events(&mut e);
    assert_eq!(
        got,
        vec![
            ev(event::SCENE_CANCELLED, 2, reason::PANIC as f64, 0.0),
            ev(event::FILL_ENDED, 1, -1.0, reason::PANIC as f64),
        ]
    );
    assert!(!e.is_playing());
    assert!(!e.master.echo_on() && !e.echo_enabled());
    assert!(!e.gesture_end(3) && !e.gesture_end(4));
    assert_eq!(e.master.sweep_target(), 1.0);
    assert!(e.master.delay.is_silent(), "the echo tail survived");
    assert!(!e.transitions.active());
    // A fill queued now is refused: nothing is playing.
    assert_eq!(e.queue_fill(5, 0), reason::NOT_PLAYING);
}

#[test]
fn solo_does_not_refill_returns_with_excluded_stems() {
    let mut e = tail_engine();
    e.set_solo(Stem::Pad, true);
    energy_ms(&mut e, 160);
    let mut peak = 0.0_f32;
    for _ in 0..375 {
        let mut l = [0.0; 128];
        let mut r = [0.0; 128];
        e.process(&mut l, &mut r);
        for v in l.iter().chain(r.iter()) {
            peak = peak.max(v.abs());
        }
    }
    assert!(peak < 0.0001, "non-solo return residue {peak}");
}

#[test]
fn solo_returns_stay_empty_after_flush_despite_channel_glide() {
    let mut e = tail_engine();
    e.set_solo(Stem::Pad, true);
    energy_ms(&mut e, 80);
    assert!(
        e.master.delay.is_silent(),
        "excluded stem refilled the delay during its dry gain glide"
    );
}

#[test]
fn export_end_score_preserves_the_tail_then_decays() {
    let mut e = tail_engine();
    e.end_score();
    let early = energy_ms(&mut e, 200);
    assert!(early > 1.0, "end_score discarded the requested tail");
    render(&mut e, 8 * 48_000, 128);
    let late = energy_ms(&mut e, 200);
    assert!(
        late < early * 0.01,
        "new notes continued in the tail: {late}/{early}"
    );
}
