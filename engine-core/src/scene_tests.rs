//! The scene scheduler against the real engine: where a scene lands, in what order,
//! and what cancels it. These read the engine's test-only trace, which records the
//! sample each scene was committed on and each step's notes were triggered on.

use super::*;
use crate::scheduler::{event, reason, timing, EVENT_CAPACITY, EVENT_WIDTH, FX_BASE};

/// The rates that turn up in the field (see `tests/sample_rates.rs`).
pub(crate) const RATES: [f32; 3] = [44_100.0, 48_000.0, 96_000.0];

pub(crate) fn groove() -> Track {
    let mut t = Track::silence("scenes");
    t.bpm = 123.0;
    t.swing = 0.22;
    for s in 0..STEPS {
        t.kick[s] = if s % 4 == 0 { 1.0 } else { 0.0 };
        t.hat[s] = 0.4;
    }
    t
}

pub(crate) fn engine(sr: f32) -> Engine {
    let mut e = Engine::new(sr);
    e.load_track(groove());
    e
}

/// A valid scene whose kick fader is `kick` and every other value is the default.
pub(crate) fn scene(kick: f32) -> Vec<f32> {
    let mut v = vec![0.0f32; SCENE_LEN];
    for (i, stem) in Stem::ALL.iter().enumerate() {
        v[i * 4] = 0.6;
        v[i * 4 + 1] = stem.send();
    }
    v[0] = kick;
    v[FX_BASE..].copy_from_slice(&[0.7, 1.2, 0.9, 1.0, 1.1, 0.5, 0.4, 0.3, 0.12, 0.8, 1.2, 0.5]);
    v
}

/// Render `frames` samples in blocks of `block`.
pub(crate) fn render(e: &mut Engine, frames: usize, block: usize) {
    let mut l = vec![0.0f32; block];
    let mut r = vec![0.0f32; block];
    let mut left = frames;
    while left > 0 {
        let n = left.min(block);
        e.process(&mut l[..n], &mut r[..n]);
        left -= n;
    }
}

/// Render one sample at a time until `step` has just fired (its onset was the last
/// sample rendered).
pub(crate) fn render_until_fired(e: &mut Engine, step: i32) {
    let mut l = [0.0f32; 1];
    let mut r = [0.0f32; 1];
    for _ in 0..(e.sample_rate as usize * 20) {
        let before = e.transport.visual_step;
        e.process(&mut l, &mut r);
        if e.transport.visual_step == step && before != step {
            return;
        }
    }
    panic!("step {step} never fired");
}

/// Render blocks of 128 until a scene has been committed, or `max_blocks` pass.
pub(crate) fn render_until_applied(e: &mut Engine, max_blocks: usize) -> Option<(u32, u64)> {
    for _ in 0..max_blocks {
        render(e, 128, 128);
        if let Some(found) = applies(e).first() {
            return Some(*found);
        }
    }
    None
}

pub(crate) fn applies(e: &Engine) -> Vec<(u32, u64)> {
    e.trace
        .iter()
        .filter_map(|t| match *t {
            Trace::Apply(id, at) => Some((id, at)),
            _ => None,
        })
        .collect()
}

/// The steps triggered on `sample`, in order.
pub(crate) fn triggers_at(e: &Engine, sample: u64) -> Vec<usize> {
    e.trace
        .iter()
        .filter_map(|t| match *t {
            Trace::Trigger(step, at) if at == sample => Some(step),
            _ => None,
        })
        .collect()
}

pub(crate) fn events(e: &mut Engine) -> Vec<[f64; 4]> {
    let mut out = [0.0f64; EVENT_CAPACITY * EVENT_WIDTH];
    let n = e.take_events_into(&mut out) as usize;
    out.as_chunks::<4>().0[..n].to_vec()
}

pub(crate) fn ev(kind: u8, id: u32, a: f64, b: f64) -> [f64; 4] {
    [kind as f64, id as f64, a, b]
}

/// The bar onset lands inside a 128-frame block, and the scene is committed on
/// exactly that sample, before that step's notes are triggered.
#[test]
fn a_bar_boundary_inside_a_block_applies_on_its_onset_before_the_notes() {
    for sr in RATES {
        let mut e = engine(sr);
        e.play();
        // An odd block first, so block edges and onsets do not line up by accident.
        render(&mut e, 37, 37);
        render_until_fired(&mut e, 5);
        e.trace.clear();
        let start = e.clock;
        assert_eq!(e.queue_scene(7, timing::BAR, &scene(0.25)), 0);
        assert_eq!(events(&mut e), vec![ev(event::SCENE_QUEUED, 7, 2.0, 16.0)]);

        let (id, at) = render_until_applied(&mut e, 2_000).expect("the scene applied");
        assert_eq!(id, 7);
        // Inside a block: the blocks after `start` begin at start + 128k.
        let frame = (at - start) % 128;
        assert_ne!(
            frame, 0,
            "{sr} Hz: the onset fell on a block edge; pick another offset"
        );
        // Committed on step 16's own onset sample, and the trace shows the commit
        // before that step's trigger.
        assert_eq!(triggers_at(&e, at), vec![16], "{sr} Hz");
        let apply_pos = e.trace.iter().position(|t| matches!(t, Trace::Apply(7, _)));
        let trigger_pos = e.trace.iter().position(|t| *t == Trace::Trigger(16, at));
        assert!(
            apply_pos < trigger_pos,
            "{sr} Hz: notes triggered before the scene"
        );
        assert!(
            !e.trace
                .iter()
                .any(|t| matches!(t, Trace::Trigger(s, a) if *a < at && *s == 16)),
            "{sr} Hz: step 16 fired before the scene"
        );
        assert_eq!(e.channels[0].vol, 0.25);
        assert_eq!(events(&mut e), vec![ev(event::SCENE_APPLIED, 7, 16.0, 0.0)]);
    }
}

/// Launched mid-bar: Next Bar waits for step 16, Next Beat for step 8.
#[test]
fn bar_waits_for_the_bar_and_beat_for_the_beat() {
    for sr in RATES {
        for (code, want) in [(timing::BAR, 16usize), (timing::BEAT, 8)] {
            let mut e = engine(sr);
            e.play();
            render_until_fired(&mut e, 5);
            e.trace.clear();
            assert_eq!(e.queue_scene(1, code, &scene(0.3)), 0);
            let (_, at) = render_until_applied(&mut e, 2_000).expect("applied");
            assert_eq!(triggers_at(&e, at), vec![want], "{sr} Hz timing {code}");
            let queued = events(&mut e);
            assert_eq!(
                queued[0],
                ev(event::SCENE_QUEUED, 1, (want / 16 + 1) as f64, want as f64)
            );
            assert_eq!(queued[1], ev(event::SCENE_APPLIED, 1, want as f64, 0.0));
        }
    }
}

/// Replacing A with B before A's boundary: only B applies, on A's announced bar,
/// even though B asked for the next beat.
#[test]
fn a_replacement_lands_on_the_boundary_already_announced() {
    for sr in RATES {
        let mut e = engine(sr);
        e.play();
        render_until_fired(&mut e, 5);
        assert_eq!(e.queue_scene(1, timing::BAR, &scene(0.2)), 0);
        render_until_fired(&mut e, 9);
        e.trace.clear();
        assert_eq!(e.queue_scene(2, timing::BEAT, &scene(0.45)), 0);
        let (id, at) = render_until_applied(&mut e, 2_000).expect("applied");
        assert_eq!(id, 2);
        assert_eq!(triggers_at(&e, at), vec![16], "{sr} Hz: kept A's bar");
        assert_eq!(applies(&e).len(), 1);
        assert_eq!(e.channels[0].vol, 0.45);
        assert_eq!(
            events(&mut e),
            vec![
                ev(event::SCENE_QUEUED, 1, 2.0, 16.0),
                ev(event::SCENE_REPLACED, 1, 2.0, 0.0),
                ev(event::SCENE_QUEUED, 2, 2.0, 16.0),
                ev(event::SCENE_APPLIED, 2, 16.0, 0.0),
            ]
        );
    }
}

/// A Now replacement does not wait for the announced bar.
#[test]
fn a_now_replacement_applies_at_the_next_render_call() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 5);
    e.queue_scene(1, timing::BAR, &scene(0.2));
    e.queue_scene(2, timing::NOW, &scene(0.5));
    let start = e.clock;
    render(&mut e, 128, 128);
    assert_eq!(applies(&e), vec![(2, start)]);
    let got = events(&mut e);
    assert_eq!(got[1], ev(event::SCENE_REPLACED, 1, 2.0, 0.0));
    assert_eq!(got[2], ev(event::SCENE_APPLIED, 2, -1.0, 0.0));
}

/// Now lands on the first sample of the next render call, and reports step -1.
#[test]
fn now_applies_on_the_first_sample_of_the_next_call() {
    for sr in RATES {
        let mut e = engine(sr);
        e.play();
        render(&mut e, 1_000, 128);
        e.trace.clear();
        assert_eq!(e.queue_scene(4, timing::NOW, &scene(0.1)), 0);
        assert!(events(&mut e).is_empty(), "Now announces no bar");
        let start = e.clock;
        render(&mut e, 128, 128);
        assert_eq!(applies(&e), vec![(4, start)]);
        assert_eq!(events(&mut e), vec![ev(event::SCENE_APPLIED, 4, -1.0, 0.0)]);
    }
}

/// Cancelled before its boundary, a scene changes nothing; cancelling one that has
/// already applied says it is not pending.
#[test]
fn cancel_before_the_boundary_changes_nothing_and_after_it_returns_false() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 5);
    let before = e.volumes();
    e.queue_scene(3, timing::BAR, &scene(0.1));
    assert!(e.cancel_scene(3));
    assert!(!e.cancel_scene(3), "cancelling twice");
    render(&mut e, 48_000 * 3, 128);
    assert!(applies(&e).is_empty());
    assert_eq!(e.volumes(), before);
    let got = events(&mut e);
    assert_eq!(
        got[1],
        ev(event::SCENE_CANCELLED, 3, reason::USER as f64, 0.0)
    );

    e.queue_scene(4, timing::BEAT, &scene(0.1));
    assert!(!e.cancel_scene(99), "a different id is not pending");
    render_until_applied(&mut e, 2_000).expect("applied");
    assert!(!e.cancel_scene(4), "already applied");
}

/// A tempo change while queued moves no deadline: the scene still lands on the bar.
#[test]
fn a_tempo_change_while_queued_still_lands_on_the_bar() {
    for sr in RATES {
        let mut e = engine(sr);
        e.play();
        render_until_fired(&mut e, 3);
        e.trace.clear();
        e.queue_scene(5, timing::BAR, &scene(0.35));
        e.set_bpm(171.0);
        render_until_fired(&mut e, 9);
        e.set_bpm(84.0);
        let (_, at) = render_until_applied(&mut e, 4_000).expect("applied");
        assert_eq!(triggers_at(&e, at), vec![16], "{sr} Hz");
    }
}

/// In a one-bar loop every bar is the same bar; the serial still lets the scene fire
/// exactly once. A request made on the boundary's own sample waits for the next one.
#[test]
fn a_one_bar_loop_applies_exactly_once() {
    for sr in RATES {
        let mut e = engine(sr);
        e.play();
        render_until_fired(&mut e, 5);
        e.set_loop(1);
        e.trace.clear();
        e.queue_scene(6, timing::BAR, &scene(0.4));
        assert_eq!(events(&mut e), vec![ev(event::SCENE_QUEUED, 6, 1.0, 0.0)]);
        // Six bars at 123 BPM is well under 12 s.
        render(&mut e, sr as usize * 12, 128);
        let got = applies(&e);
        assert_eq!(got.len(), 1, "{sr} Hz: {got:?}");
        assert_eq!(triggers_at(&e, got[0].1), vec![0]);

        // Queued on the very sample step 0 fired: that onset is already gone, so it
        // goes to the loop's next pass.
        render_until_fired(&mut e, 0);
        let fired_at = e.clock - 1;
        e.trace.clear();
        e.queue_scene(7, timing::BAR, &scene(0.5));
        render(&mut e, sr as usize * 12, 128);
        let got = applies(&e);
        assert_eq!(got.len(), 1, "{sr} Hz: {got:?}");
        // It skipped the onset it was queued on and took the next pass's step 0: the
        // fifteen steps of the bar fired in between, and no other step 0.
        let at = got[0].1;
        assert_eq!(triggers_at(&e, at), vec![0], "{sr} Hz");
        let between: Vec<usize> = e
            .trace
            .iter()
            .filter_map(|t| match *t {
                Trace::Trigger(step, s) if s < at => Some(step),
                _ => None,
            })
            .collect();
        assert_eq!(
            between,
            (1..16).collect::<Vec<_>>(),
            "{sr} Hz, queued at {fired_at}"
        );
    }
}

/// Changing the loop under a pending scene re-announces it with the new prediction,
/// and it lands where the new prediction says.
#[test]
fn setting_a_loop_re_announces_the_pending_scene() {
    let mut e = engine(48_000.0);
    e.play();
    render_until_fired(&mut e, 40);
    e.queue_scene(8, timing::BAR, &scene(0.4));
    // A one-bar loop around step 40 is 32..48, so the next bar line is 32.
    e.set_loop(1);
    assert_eq!(
        events(&mut e),
        vec![
            ev(event::SCENE_QUEUED, 8, 4.0, 48.0),
            ev(event::SCENE_QUEUED, 8, 3.0, 32.0),
        ]
    );
    e.trace.clear();
    let (_, at) = render_until_applied(&mut e, 2_000).expect("applied");
    assert_eq!(triggers_at(&e, at), vec![32]);
}

/// Every structural event cancels a pending scene with its reason, and the scene
/// never applies afterwards.
#[test]
fn transport_and_track_changes_cancel_the_pending_scene() {
    type Action = fn(&mut Engine);
    let cases: [(&str, Action, u8); 8] = [
        ("stop", |e| e.stop(), reason::STOPPED),
        ("jump", |e| e.jump(0), reason::TRANSPORT),
        ("play again", |e| e.play(), reason::TRANSPORT),
        ("scratch", |e| e.scratch_start(), reason::TRANSPORT),
        ("scratch end", |e| e.scratch_end(32), reason::TRANSPORT),
        ("brake", |e| e.brake(), reason::TRANSPORT),
        ("backspin", |e| e.backspin(), reason::TRANSPORT),
        ("load track", |e| e.load_track(groove()), reason::TRACK),
    ];
    for (name, action, why) in cases {
        for sr in RATES {
            let mut e = engine(sr);
            e.play();
            render_until_fired(&mut e, 5);
            assert_eq!(e.queue_scene(9, timing::BAR, &scene(0.15)), 0);
            events(&mut e);
            action(&mut e);
            assert_eq!(
                events(&mut e),
                vec![ev(event::SCENE_CANCELLED, 9, why as f64, 0.0)],
                "{name} at {sr} Hz"
            );
            assert_eq!(e.pending_scene(), None);
            // Whatever state that left, play on (or again) for several bars.
            e.scratch_release();
            if !e.is_playing() {
                e.play();
            }
            render(&mut e, sr as usize * 10, 128);
            assert!(
                !applies(&e).iter().any(|(id, _)| *id == 9),
                "{name} at {sr} Hz: the cancelled scene applied later"
            );
            assert_ne!(e.channels[0].vol, 0.15, "{name}");
        }
    }
}

/// The host's structural cancel reports the reason it is given.
#[test]
fn the_host_can_cancel_for_its_own_reasons() {
    let mut e = engine(48_000.0);
    e.play();
    render(&mut e, 500, 128);
    e.queue_scene(10, timing::BAR, &scene(0.5));
    events(&mut e);
    assert!(e.cancel_pending(reason::TRACK));
    assert!(!e.cancel_pending(reason::TRACK));
    assert_eq!(
        events(&mut e),
        vec![ev(event::SCENE_CANCELLED, 10, reason::TRACK as f64, 0.0)]
    );
}

/// A bad vector is refused as a whole and touches nothing, not even a scene that was
/// already pending.
#[test]
fn an_invalid_vector_is_rejected_and_the_mix_is_untouched() {
    let mut nan = scene(0.5);
    nan[20] = f32::NAN;
    let short = scene(0.5)[..43].to_vec();
    let mut long = scene(0.5);
    long.push(0.0);
    let mut loud = scene(0.5);
    loud[4] = 1.01;
    let mut half = scene(0.5);
    half[2] = 0.5;
    let mut echo = scene(0.5);
    echo[37] = 0.6;
    let mut q = scene(0.5);
    q[33] = 0.0;
    for (name, bad) in [
        ("NaN", nan),
        ("43 long", short),
        ("45 long", long),
        ("volume over 1", loud),
        ("toggle 0.5", half),
        ("echo time not an option", echo),
        ("Q below range", q),
    ] {
        for playing in [false, true] {
            let mut e = engine(48_000.0);
            if playing {
                e.play();
                render_until_fired(&mut e, 5);
                assert_eq!(e.queue_scene(1, timing::BAR, &scene(0.33)), 0);
            }
            events(&mut e);
            let vols = e.volumes();
            let sends = e.sends();
            let mutes: Vec<bool> = e.channels.iter().map(|c| c.muted).collect();
            let filter = e.master.sweep_target();
            assert_eq!(
                e.queue_scene(2, timing::BAR, &bad),
                reason::INVALID,
                "{name}"
            );
            assert_eq!(
                events(&mut e),
                vec![ev(event::SCENE_REJECTED, 2, reason::INVALID as f64, 0.0)],
                "{name}"
            );
            assert_eq!(e.volumes(), vols, "{name}");
            assert_eq!(e.sends(), sends, "{name}");
            assert_eq!(
                e.channels.iter().map(|c| c.muted).collect::<Vec<_>>(),
                mutes,
                "{name}"
            );
            assert_eq!(e.master.sweep_target(), filter, "{name}");
            if playing {
                assert_eq!(e.pending_scene(), Some(1), "{name}: the old one stays");
            }
        }
    }
    let mut e = engine(48_000.0);
    assert_eq!(
        e.queue_scene(1, 3, &scene(0.5)),
        reason::INVALID,
        "timing 3"
    );
}

/// Stopped, a scene applies on the spot, reports step -1, and does not start playback.
#[test]
fn a_scene_while_stopped_applies_immediately_without_playing() {
    let mut e = engine(48_000.0);
    assert_eq!(e.queue_scene(11, timing::BAR, &scene(0.2)), 0);
    assert!(!e.is_playing());
    assert_eq!(e.channels[0].vol, 0.2);
    assert_eq!(e.pending_scene(), None);
    assert_eq!(
        events(&mut e),
        vec![ev(event::SCENE_APPLIED, 11, -1.0, 0.0)]
    );
}

/// While the clock is under a hand, a brake or a spin, nothing can be scheduled.
#[test]
fn a_request_during_a_transport_gesture_is_refused() {
    for gesture in [Engine::scratch_start, Engine::brake, Engine::backspin] {
        let mut e = engine(48_000.0);
        e.play();
        // Enough audio for the backspin to have a take.
        render(&mut e, 48_000, 128);
        gesture(&mut e);
        events(&mut e);
        assert_eq!(
            e.queue_scene(12, timing::BAR, &scene(0.2)),
            reason::TRANSPORT
        );
        assert_eq!(
            events(&mut e),
            vec![ev(event::SCENE_REJECTED, 12, reason::TRANSPORT as f64, 0.0)]
        );
    }
}

/// The scene sets every target it holds: all four stem fields and all twelve effects.
#[test]
fn a_scene_sets_every_field() {
    let mut e = engine(48_000.0);
    let mut v = scene(0.9);
    v[5] = 0.77; // clap send
    v[6] = 1.0; // clap muted
    v[11] = 1.0; // hats solo
    v[37] = 0.0; // echo off
    e.queue_scene(1, timing::NOW, &v);
    let c = &e.channels;
    assert_eq!(c[0].vol, 0.9);
    assert_eq!(c[1].send, 0.77);
    assert!(c[1].muted && !c[0].muted);
    assert!(c[2].solo && !c[1].solo);
    assert!((e.master.sweep_target() - 0.7).abs() < 1e-6);
    assert!(!e.master.sends_enabled(), "echo time 0 turns the sends off");
}

/// The audio glides into a scene: a cut does not drop the output in one sample.
#[test]
fn a_scene_glides_rather_than_jumps() {
    let mut e = engine(48_000.0);
    e.play();
    render(&mut e, 4_800, 128);
    let before = e.channels[0].gain_now;
    let mut v = scene(0.0);
    v[2] = 1.0; // cut the kick
    e.queue_scene(1, timing::NOW, &v);
    render(&mut e, 1, 1);
    let after = e.channels[0].gain_now;
    assert!(before > 0.1);
    assert!(
        after > before * 0.5,
        "the kick fell from {before} to {after} in a sample"
    );
}

/// The idle deck's follower: sets the targets, reports nothing, refuses bad vectors.
#[test]
fn set_scene_applies_quietly_and_validates() {
    let mut e = engine(48_000.0);
    e.play();
    render(&mut e, 500, 128);
    events(&mut e);
    assert!(e.set_scene(&scene(0.22)));
    assert_eq!(e.channels[0].vol, 0.22);
    assert!(events(&mut e).is_empty());
    let mut bad = scene(0.9);
    bad[3] = 0.5;
    assert!(!e.set_scene(&bad));
    assert_eq!(e.channels[0].vol, 0.22);
}
