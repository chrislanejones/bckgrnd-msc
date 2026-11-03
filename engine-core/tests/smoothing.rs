//! Moving a control must not click.
//!
//! A click is a step: one sample far from the one before it. So each test plays a
//! sustained pad, waits for the waveform to sit near a peak (where an instant gain
//! change does the most damage), makes the change, and compares the largest
//! sample-to-sample step after it with the largest step the pad makes on its own.
//! An instant cut at a peak steps by the pad's whole amplitude, many times its own
//! largest step; a glided one stays within it.
//!
//! The pad is the only stem with notes, so nothing else (no drum transient) can
//! hide a click or be mistaken for one.

use bckgrnd_msc_engine::{Engine, NoteEvent, Stem, Track};

const SR: f32 = 48_000.0;

/// A pad chord held for the whole song, and nothing else.
fn pad_track() -> Track {
    let mut t = Track::silence("pad");
    t.bpm = 120.0;
    for s in (0..256).step_by(64) {
        t.pad[s] = Some(NoteEvent::new(
            vec![52.0, 55.0, 59.0, 64.0],
            64.0,
            0.9,
            false,
        ));
    }
    t
}

fn engine() -> Engine {
    let mut e = Engine::new(SR);
    e.load_track(pad_track());
    // No echo send and no room, so "the cut landed" measures the stem itself rather
    // than the tail that is meant to ring out after it.
    e.set_send(Stem::Pad, 0.0);
    e.set_reverb_mix(0.0);
    e.play();
    // Past the pad's attack, so the level is steady.
    render(&mut e, (SR * 1.5) as usize);
    e
}

fn render(e: &mut Engine, n: usize) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0.0; n];
    let mut r = vec![0.0; n];
    e.process(&mut l, &mut r);
    (l, r)
}

fn max_step(x: &[f32]) -> f32 {
    x.windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0, f32::max)
}

/// The largest step the pad makes on its own, over the last 0.1 s, and the peak.
fn steady(e: &mut Engine) -> (f32, f32) {
    let (l, r) = render(e, (SR * 0.1) as usize);
    let step = max_step(&l).max(max_step(&r));
    let peak = l.iter().chain(&r).map(|v| v.abs()).fold(0.0, f32::max);
    (step, peak)
}

/// Advance one sample at a time until the left channel is within 10% of `peak`.
fn wait_for_peak(e: &mut Engine, peak: f32) -> f32 {
    let mut last = 0.0;
    for _ in 0..(SR as usize) {
        let (l, _) = render(e, 1);
        last = l[0];
        if l[0].abs() >= peak * 0.9 {
            break;
        }
    }
    last
}

/// Make `change` at a peak and return (step after the change, the steady step, the
/// level 0.1 s after).
fn around_change(e: &mut Engine, change: impl FnOnce(&mut Engine)) -> (f32, f32, f32) {
    let (steady_step, peak) = steady(e);
    assert!(peak > 0.05, "the pad should be sounding, peak {peak}");
    let last = wait_for_peak(e, peak);
    change(e);
    let (l, r) = render(e, (SR * 0.1) as usize);
    let mut lead_in = vec![last];
    lead_in.extend_from_slice(&l);
    let step = max_step(&lead_in).max(max_step(&r));
    let after = l[l.len() - 480..]
        .iter()
        .chain(&r[r.len() - 480..])
        .map(|v| v.abs())
        .fold(0.0, f32::max);
    (step, steady_step, after)
}

/// The step allowed after a change, relative to the pad's own.
const ALLOWED: f32 = 1.25;

#[test]
fn cutting_a_held_note_at_its_peak_does_not_click() {
    let mut e = engine();
    let (step, steady, after) = around_change(&mut e, |e| e.set_muted(Stem::Pad, true));
    assert!(
        step <= steady * ALLOWED,
        "cut stepped {step:.4}, the pad's own largest step is {steady:.4}"
    );
    assert!(
        after < 1e-3,
        "the cut should still land: {after:.5} left after 0.1 s"
    );
}

#[test]
fn a_fader_slammed_down_does_not_click() {
    let mut e = engine();
    let (step, steady, after) = around_change(&mut e, |e| e.set_volume(Stem::Pad, 0.0));
    assert!(
        step <= steady * ALLOWED,
        "fader stepped {step:.4} against {steady:.4}"
    );
    assert!(after < 1e-3, "the fader should still land, {after:.5} left");
}

#[test]
fn soloing_another_stem_does_not_click() {
    let mut e = engine();
    let (step, steady, after) = around_change(&mut e, |e| e.set_solo(Stem::Kick, true));
    assert!(
        step <= steady * ALLOWED,
        "solo stepped {step:.4} against {steady:.4}"
    );
    assert!(
        after < 1e-3,
        "the pad should fall silent under the kick's solo, {after:.5} left"
    );
}

#[test]
fn bringing_a_stem_back_does_not_click() {
    let mut e = engine();
    let (steady_step, _) = steady(&mut e);
    // Bring it back at twenty different points in the waveform: wherever it lands,
    // it must fade in rather than appear.
    let mut worst = 0.0f32;
    for k in 0..20 {
        e.set_muted(Stem::Pad, true);
        render(&mut e, (SR * 0.08) as usize + k * 37);
        e.set_muted(Stem::Pad, false);
        let (l, r) = render(&mut e, (SR * 0.03) as usize);
        worst = worst.max(max_step(&l)).max(max_step(&r));
    }
    assert!(
        worst <= steady_step * ALLOWED,
        "bringing it in stepped {worst:.4} against {steady_step:.4}"
    );
}

#[test]
fn hammering_cut_every_block_stays_click_free() {
    let mut e = engine();
    let (steady_step, _) = steady(&mut e);
    let mut worst = 0.0f32;
    let mut muted = false;
    // One toggle per 128-sample render quantum for a second: as fast as any message
    // from the UI could possibly arrive.
    for _ in 0..(SR as usize / 128) {
        muted = !muted;
        e.set_muted(Stem::Pad, muted);
        let (l, r) = render(&mut e, 128);
        worst = worst.max(max_step(&l)).max(max_step(&r));
    }
    assert!(
        worst <= steady_step * ALLOWED,
        "rapid toggling stepped {worst:.4} against {steady_step:.4}"
    );
}

#[test]
fn master_controls_moved_at_a_peak_do_not_click() {
    type Change = fn(&mut Engine);
    let changes: [(&str, Change); 7] = [
        ("master to zero", |e| e.set_master(0.0)),
        ("balance hard left", |e| e.set_stereo_balance(0.0)),
        ("width to mono", |e| e.set_width(0.0)),
        ("low band killed", |e| e.set_bands(0.0, 1.0, 1.0)),
        ("mid band killed", |e| e.set_bands(1.0, 0.0, 1.0)),
        ("filter slammed shut", |e| e.set_filter(0.0)),
        ("echo throw", |e| e.set_echo(true)),
    ];
    for (name, change) in changes {
        let mut e = engine();
        let (step, steady, _) = around_change(&mut e, change);
        assert!(
            step <= steady * ALLOWED,
            "{name} stepped {step:.4} against {steady:.4}"
        );
    }
}

#[test]
fn a_stem_send_changes_what_reaches_the_echo() {
    // The same render with the pad's send at nothing and at full: an engine is
    // deterministic, so any difference is the echo the send fed.
    let run = |send: f32| {
        let mut e = Engine::new(SR);
        e.load_track(pad_track());
        e.set_send(Stem::Pad, send);
        e.play();
        render(&mut e, (SR * 2.0) as usize).0
    };
    let none = run(0.0);
    let full = run(1.0);
    let signal: f32 = none.iter().map(|v| v * v).sum();
    let diff: f32 = none.iter().zip(&full).map(|(a, b)| (a - b) * (a - b)).sum();
    assert!(
        diff > signal * 0.01,
        "a full send should be heard: diff {diff:.3} of {signal:.3}"
    );
}

#[test]
fn loading_a_track_puts_the_sends_back() {
    let mut e = Engine::new(SR);
    e.set_send(Stem::Lead, 0.9);
    e.set_send(Stem::Kick, 0.5);
    e.load_track(pad_track());
    let sends = e.sends();
    for stem in Stem::ALL {
        assert_eq!(
            sends[stem.index()],
            stem.send(),
            "{stem:?} send after a load"
        );
    }
}

#[test]
fn out_of_range_and_non_finite_settings_are_refused_or_clamped() {
    let mut e = engine();
    e.set_send(Stem::Pad, f32::NAN);
    e.set_volume(Stem::Pad, f32::INFINITY);
    e.set_width(f32::NAN);
    e.set_filter_q(1e9);
    e.set_echo_feedback(5.0);
    e.set_echo_return(-1.0);
    e.set_reverb_mix(f32::NAN);
    e.set_reverb_decay(1e6);
    let (l, r) = render(&mut e, SR as usize);
    assert!(
        l.iter().chain(&r).all(|v| v.is_finite() && v.abs() <= 1.0),
        "output must stay finite and bounded"
    );
    assert_eq!(
        e.sends()[Stem::Pad.index()],
        0.0,
        "a NaN send is ignored, leaving the 0 set before it"
    );
}

#[test]
fn a_stem_cut_before_play_never_sounds() {
    // The worklet boots the engine and renders silent blocks before the first track
    // and the first play arrive. A cut sent in that gap must hold from the very first
    // sample of the song, not let the first hit through on the tail of a glide.
    let mut e = Engine::new(SR);
    render(&mut e, 4096);
    e.load_track(pad_track());
    for stem in Stem::ALL {
        e.set_muted(stem, true);
    }
    e.play();
    let (l, r) = render(&mut e, SR as usize);
    let peak = l.iter().chain(&r).fold(0.0f32, |a, v| a.max(v.abs()));
    assert_eq!(peak, 0.0, "every stem was cut before play, peak {peak}");
}
