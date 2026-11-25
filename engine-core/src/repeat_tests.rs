//! Night 10 Beat Repeat (gesture kind 3) against the real engine
//! (`docs/NIGHT10_PROTOCOL.md`): the grid it engages on, the loop period, the seams and
//! the release, the bypass, what ends it, a division change while held, and the other
//! held effects alongside it.

use super::*;
use crate::perform::{ended, kind};
use crate::scene_tests::{engine, ev, events, render, render_until_fired, RATES};
use crate::scheduler::event;

const REPEAT: u8 = kind::BEAT_REPEAT;

/// Something done to the engine, by name in a table.
type Act = fn(&mut Engine);

/// Render one sample at a time for `frames`, returning the output and, per sample, the
/// Beat Repeat position (slice, on the live pass) after it.
fn run(e: &mut Engine, frames: usize) -> (Vec<f32>, Vec<(u64, bool)>) {
    let mut out = Vec::with_capacity(frames);
    let mut pos = Vec::with_capacity(frames);
    let (mut l, mut r) = ([0.0f32; 1], [0.0f32; 1]);
    for _ in 0..frames {
        e.process(&mut l, &mut r);
        out.push(l[0]);
        pos.push(e.repeat.position());
    }
    (out, pos)
}

/// Engine clocks at which each slice began (slice 0 is the grid line), from a `run`
/// that started at clock `from`.
fn slice_starts(from: u64, pos: &[(u64, bool)]) -> Vec<u64> {
    let mut starts = Vec::new();
    let mut last: Option<(u64, bool)> = None;
    for (i, p) in pos.iter().enumerate() {
        let began = match last {
            None => p.1,
            Some(prev) => (p.1 && !prev.1) || p.0 != prev.0,
        };
        if began {
            // The live pass shows on its first sample; a new slice shows on the last
            // sample of the one before (the count moves on as that sample ends).
            let next = usize::from(!p.1 || last.is_some_and(|q| q.1));
            starts.push(from + (i + next) as u64);
        }
        last = Some(*p);
    }
    starts
}

/// The samples on which `step`s satisfying `on` were triggered, in the trace.
fn triggers(e: &Engine, on: impl Fn(usize) -> bool) -> Vec<u64> {
    e.trace
        .iter()
        .filter_map(|t| match *t {
            Trace::Trigger(s, at) if on(s) => Some(at),
            _ => None,
        })
        .collect()
}

fn grid(division: u8) -> usize {
    match division {
        4 => 4,
        8 => 2,
        _ => 1,
    }
}

#[test]
fn it_engages_on_the_next_grid_line_of_its_division() {
    for sr in RATES {
        for d in [4u8, 8, 16] {
            let mut e = engine(sr);
            assert!(e.set_repeat_division(d));
            e.play();
            render_until_fired(&mut e, 5);
            render(&mut e, 37, 37);
            e.trace.clear();
            let from = e.clock;
            assert!(e.gesture_begin(1, REPEAT));
            let (_, pos) = run(&mut e, (sr * 1.2) as usize);
            let starts = slice_starts(from, &pos);
            let first = *starts.first().expect("engaged");
            let lines = triggers(&e, |s| s % grid(d) == 0);
            assert_eq!(
                first, lines[0],
                "{sr} Hz 1/{d}: engaged off the first grid line"
            );
        }
    }
}

/// Every slice starts `ceil(j * period)` after the grid line, the period is 8/d of the
/// eighth the transport plays, and so the repeats land on the transport's own grid
/// lines throughout (with swing on: the groove swings 0.22).
#[test]
fn the_loop_period_is_exact_per_division() {
    for sr in [44_100.0f32, 96_000.0] {
        for bpm in [123.0f32, 87.0] {
            for d in [4u8, 8, 16] {
                let mut e = engine(sr);
                e.set_bpm(bpm);
                e.set_repeat_division(d);
                e.play();
                render_until_fired(&mut e, 3);
                e.trace.clear();
                let from = e.clock;
                e.gesture_begin(7, REPEAT);
                // Inside the 3 s lease.
                let (_, pos) = run(&mut e, (sr * 2.9) as usize);
                let starts = slice_starts(from, &pos);
                let eighth = e.eighth_samples();
                let period = eighth * 8.0 / d as f64;
                assert_eq!(e.repeat.period(), period, "{sr} {bpm} 1/{d}");
                assert!(
                    starts.len() > 3,
                    "{sr} {bpm} 1/{d}: {} slices",
                    starts.len()
                );
                let t0 = starts[0];
                for (j, &s) in starts.iter().enumerate() {
                    assert_eq!(
                        s - t0,
                        (j as f64 * period).ceil() as u64,
                        "{sr} {bpm} 1/{d}: slice {j}"
                    );
                }
                // Each grid line the transport fired while it repeated (eighths for
                // 1/16: its sixteenths swing, the repeat does not) is a seam.
                let line = if d >= 16 { 2 } else { grid(d) };
                let last = *starts.last().unwrap();
                for at in triggers(&e, |s| s % line == 0) {
                    if at >= t0 && at <= last {
                        assert!(
                            starts.contains(&at),
                            "{sr} {bpm} 1/{d}: grid line at {at} is not a seam"
                        );
                    }
                }
            }
        }
    }
}

/// The largest sample-to-sample step in `x`.
fn max_step(x: &[f32]) -> f32 {
    x.windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0, f32::max)
}

/// Drive the stutter on its own with a slow sine (whose own step is under 0.009) and
/// bound every step: at seams, on a division change and through the release. Without
/// the ramps a seam alone steps by up to 1.8.
#[test]
fn seams_division_changes_and_release_do_not_click() {
    for sr in [44_100.0f32, 48_000.0, 192_000.0] {
        let mut r = repeat::Repeat::new(sr);
        let sine = |n: usize| [(n as f32 * 0.01).sin() * 0.9; repeat::CHANNELS];
        let eighth = (sr as f64 * 0.24).ceil();
        let mut out = Vec::new();
        let mut n = 0usize;
        let mut step = |r: &mut repeat::Repeat, out: &mut Vec<f32>, k: usize| {
            for _ in 0..k {
                let y = if r.active() {
                    r.process(sine(n))
                } else {
                    sine(n)
                };
                out.push(y[0]);
                n += 1;
            }
        };
        r.hold();
        step(&mut r, &mut out, 333);
        r.on_onset(0, eighth);
        step(&mut r, &mut out, (eighth * 3.3) as usize);
        assert!(r.looping());
        assert!(r.set_division(16));
        step(&mut r, &mut out, 1000);
        r.on_onset(3, eighth); // the next sixteenth line: re-captures
        step(&mut r, &mut out, (eighth * 2.1) as usize);
        r.release();
        step(&mut r, &mut out, (sr * 0.02) as usize);
        assert!(!r.active(), "{sr}: released and faded out");
        let bound = 0.009 + 0.9 / (repeat::SEAM_SECONDS * sr) * 2.5;
        let worst = max_step(&out);
        assert!(worst <= bound, "{sr} Hz: max step {worst} > {bound}");
    }
}

/// Inactive is a bypass: an engine whose division was changed, or which holds a repeat
/// still waiting for its grid line, renders bit for bit what an untouched one does. Each
/// render runs on a fresh thread: the noise generator's state is per thread.
#[test]
fn inactive_is_bit_identical() {
    fn take(sr: f32, touch: bool) -> Vec<f32> {
        std::thread::spawn(move || {
            let mut e = engine(sr);
            e.play();
            if touch {
                e.set_repeat_division(16);
                e.set_repeat_division(4);
            }
            render_until_fired(&mut e, 1);
            if touch {
                assert!(e.gesture_begin(3, REPEAT)); // waits for step 4
            }
            let (x, _) = run(&mut e, 2_000);
            assert!(!e.repeat_looping());
            x
        })
        .join()
        .unwrap()
    }
    for sr in RATES {
        let (xa, xb) = (take(sr, false), take(sr, true));
        let first = xa
            .iter()
            .zip(&xb)
            .position(|(p, q)| p.to_bits() != q.to_bits());
        assert_eq!(first, None, "{sr} Hz: {:?}", first.map(|i| (xa[i], xb[i])));
    }
}

fn looping(sr: f32) -> Engine {
    let mut e = engine(sr);
    e.play();
    render(&mut e, 4_800, 128);
    assert!(e.gesture_begin(9, REPEAT));
    render(&mut e, (sr * 0.8) as usize, 128);
    assert!(e.repeat_looping());
    let _ = events(&mut e);
    e
}

#[test]
fn stop_panic_release_fx_a_track_load_and_the_lease_end_it() {
    let sr = 48_000.0;
    let ends: [(&str, Act); 4] = [
        ("stop", Engine::stop),
        ("panic", Engine::panic),
        ("release fx", Engine::release_gestures),
        ("track load", |e| e.load_track(crate::scene_tests::groove())),
    ];
    for (what, end) in ends {
        let mut e = looping(sr);
        end(&mut e);
        assert!(!e.repeat.held(), "{what}");
        render(&mut e, 1_000, 128);
        assert!(!e.repeat.active(), "{what}: faded out");
        assert!(!e.gesture_renew(9), "{what}: the token is gone");
    }
    // The lease: not renewed, it runs out and is reported like any other kind's.
    let mut e = looping(sr);
    render(&mut e, (sr * 3.0) as usize, 128);
    assert!(!e.repeat.held() && !e.repeat.active());
    assert!(events(&mut e).contains(&ev(event::GESTURE_EXPIRED, 9, 3.0, ended::LEASE)));
}

#[test]
fn a_brake_backspin_or_scratch_ends_it_and_says_so() {
    let sr = 48_000.0;
    let takes: [(&str, Act); 3] = [
        ("brake", Engine::brake),
        ("backspin", Engine::backspin),
        ("scratch", Engine::scratch_start),
    ];
    for (what, take) in takes {
        let mut e = looping(sr);
        take(&mut e);
        assert!(!e.repeat.held(), "{what}");
        assert!(
            events(&mut e).contains(&ev(event::GESTURE_EXPIRED, 9, 3.0, ended::PLATTER)),
            "{what}: not reported"
        );
    }
}

#[test]
fn a_seek_or_a_loop_wrap_keeps_it_looping_on_the_grid() {
    let sr = 48_000.0;
    let mut e = looping(sr);
    e.jump(100);
    render(&mut e, 2_000, 128);
    assert!(e.repeat_looping(), "a seek keeps it");
    e.set_loop(1);
    for _ in 0..3 {
        assert!(e.gesture_renew(9));
        render(&mut e, (sr * 0.9) as usize, 128);
    }
    assert!(e.repeat_looping(), "a loop wrap keeps it");
    assert!(e.gesture_renew(9));
}

#[test]
fn a_division_change_while_held_recaptures_on_the_new_grid() {
    let sr = 44_100.0;
    let mut e = looping(sr);
    let eighth = e.eighth_samples();
    assert_eq!(e.repeat.period(), eighth);
    assert!(e.set_repeat_division(16));
    assert!(!e.set_repeat_division(12), "not a division");
    assert!(!e.set_repeat_division(32), "1/32 is not offered");
    assert_eq!(e.repeat_division(), 16);
    e.trace.clear();
    let from = e.clock;
    let (_, pos) = run(&mut e, (eighth * 2.0) as usize);
    let recapture = pos.iter().position(|p| p.1).expect("captured again") as u64 + from;
    assert_eq!(
        triggers(&e, |_| true)[0],
        recapture,
        "on the next sixteenth"
    );
    assert_eq!(e.repeat.period(), eighth / 2.0);
    assert!(e.repeat_looping());
}

#[test]
fn it_holds_alongside_filter_hold_and_echo_throw() {
    let sr = 48_000.0;
    let mut e = looping(sr);
    assert!(e.gesture_begin(10, kind::FILTER_HOLD));
    assert!(e.gesture_begin(11, kind::ECHO_THROW));
    render(&mut e, 4_800, 128);
    assert!(e.repeat_looping() && e.master.echo_on());
    let mut l = vec![0.0f32; 4_800];
    let mut r = vec![0.0f32; 4_800];
    e.process(&mut l, &mut r);
    assert!(l.iter().chain(&r).all(|x| x.is_finite() && x.abs() <= 1.0));
    // Ending the repeat leaves the other two held, and the other way round.
    assert!(e.gesture_end(9));
    assert!(!e.repeat.held() && e.master.echo_on());
    assert!(e.gesture_begin(12, REPEAT));
    assert!(e.gesture_end(10) && e.gesture_end(11));
    assert!(e.repeat.held() && !e.master.echo_on());
}

/// A second token of the kind keeps the stutter going when the first lets go.
#[test]
fn two_repeat_tokens_release_in_either_order() {
    let mut e = looping(48_000.0);
    assert!(e.gesture_begin(20, REPEAT));
    assert!(e.gesture_end(9));
    assert!(e.repeat_looping());
    assert!(e.gesture_end(20));
    assert!(!e.repeat.held());
}
