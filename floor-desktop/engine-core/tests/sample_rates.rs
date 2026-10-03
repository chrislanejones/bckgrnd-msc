//! Sample-rate coverage.
//!
//! Every browser check in this project runs at whatever rate the machine's audio
//! device happens to report — 44100 Hz on the Linux sandbox. Windows devices are very
//! often 48000 Hz, and a handful of user devices go to 96000. The engine derives all
//! of its filter coefficients, delay-line lengths and step durations from the rate it
//! is constructed with, so a rate-dependent fault would be invisible in CI and then
//! audible on a user's machine.
//!
//! These tests pin the rates that actually turn up in the field.

use floor_engine::{Engine, NoteEvent, Stem, Track, STEPS};

fn loaded_track() -> Track {
    let mut t = Track::silence("rate");
    t.bpm = 126.0;
    t.swing = 0.22;
    for s in 0..STEPS {
        t.kick[s] = if s % 4 == 0 { 1.0 } else { 0.0 };
        t.hat[s] = if s % 2 == 0 { 0.5 } else { 0.0 };
        t.clap[s] = if s % 8 == 4 { 0.8 } else { 0.0 };
    }
    t.bass[0] = Some(NoteEvent::new(vec![45.0], 4.0, 0.9, false));
    t.bass[16] = Some(NoteEvent::new(vec![45.0], 4.0, 0.9, false));
    t.stab[8] = Some(NoteEvent::new(vec![57.0, 60.0, 64.0], 8.0, 0.6, true));
    t.pad[32] = Some(NoteEvent::new(vec![52.0, 55.0, 59.0], 32.0, 0.5, false));
    t.arp[0] = Some(NoteEvent::new(vec![81.0], 2.0, 0.4, false));
    t.arp[4] = Some(NoteEvent::new(vec![84.0], 2.0, 0.4, false));
    t.lead[8] = Some(NoteEvent::new(vec![69.0], 8.0, 0.5, false));
    t
}

/// Rates seen in practice: CD-rate laptops, the 48 k studio default, and the 96 k
/// hi-res devices that show up on Windows audio interfaces.
const RATES: [f32; 5] = [44_100.0, 48_000.0, 96_000.0, 32_000.0, 192_000.0];

fn render_seconds(rate: f32, seconds: f32) -> (f32, usize, usize) {
    let mut e = Engine::new(rate);
    e.load_track(loaded_track());
    e.set_bpm(126.0);
    e.play();

    let blocks = (rate as usize * seconds as usize) / 128;
    let mut peak = 0.0f32;
    let mut non_finite = 0usize;
    let mut silent_blocks = 0usize;

    for _ in 0..blocks {
        let mut l = [0.0f32; 128];
        let mut r = [0.0f32; 128];
        e.process(&mut l, &mut r);
        let mut block_peak = 0.0f32;
        for (a, b) in l.iter().zip(r.iter()) {
            if !a.is_finite() || !b.is_finite() {
                non_finite += 1;
            }
            block_peak = block_peak.max(a.abs()).max(b.abs());
        }
        if block_peak < 1e-6 {
            silent_blocks += 1;
        }
        peak = peak.max(block_peak);
    }

    (peak, non_finite, silent_blocks)
}

#[test]
fn every_device_rate_renders_audio() {
    for rate in RATES {
        let (peak, non_finite, _) = render_seconds(rate, 2.0);
        assert!(
            peak > 0.02,
            "no audio at {rate} Hz (peak {peak}) — the engine derives its filter and delay \
             coefficients from the construction rate"
        );
        assert_eq!(non_finite, 0, "non-finite samples at {rate} Hz");
        assert!(
            peak <= 1.5,
            "runaway level at {rate} Hz (peak {peak}) — a coefficient overflow would do this"
        );
    }
}

#[test]
fn the_sequence_runs_at_the_same_tempo_at_every_rate() {
    // The grid is 16 bars (256 steps), so after exactly 4 bars the playhead sits at
    // step 63 — not near zero. The point is that the step *index* reached after a fixed
    // number of seconds is identical at every sample rate: step lengths are computed in
    // seconds and converted to samples, so a wrong conversion would make the tempo drift
    // with the device rate. A user on 48 kHz would hear a different tempo from a user on
    // 44.1 kHz, which is exactly the bug worth catching.
    let bars = 4usize;
    let seconds = bars as f32 * 4.0 * (60.0 / 126.0);

    let mut observed = Vec::new();
    for rate in RATES {
        let mut e = Engine::new(rate);
        e.load_track(loaded_track());
        e.play();

        let blocks = (rate * seconds) as usize / 128;
        for _ in 0..blocks {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
        }

        let step = e.visual_step();
        assert!(
            (55..=66).contains(&step),
            "at {rate} Hz the playhead reached step {step} after {bars} bars, expected ~63"
        );
        observed.push(step);
    }

    assert!(
        observed.windows(2).all(|w| w[0].abs_diff(w[1]) <= 1),
        "the playhead landed on different steps per rate: {observed:?}"
    );
}

#[test]
fn downbeat_scheduling_respects_the_minimum_headroom_at_every_rate() {
    // `samples_to_next_downbeat(bars, min_ahead)` is how the worklet schedules a
    // beat-matched crossfade. Asking for "at least 300 ms from now" must never return
    // less than that, at any rate — otherwise a handover starts mid-phrase on some
    // devices and not others.
    let min_ahead = 0.3f32;
    for rate in RATES {
        let mut e = Engine::new(rate);
        e.load_track(loaded_track());
        e.play();

        // Start mid-bar so the answer cannot be the degenerate "already on the
        // downbeat" case.
        for _ in 0..(rate as usize / 128) * 2 {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
        }

        let samples = e.samples_to_next_downbeat(4, min_ahead);
        let seconds = samples / rate as f64;

        assert!(
            seconds >= min_ahead as f64 - 1e-6,
            "at {rate} Hz a 4-bar handover was scheduled {seconds:.3} s away, \
             which violates the {min_ahead} s headroom"
        );
        // And it must still land inside the phrase rather than absurdly far out.
        let four_bars = 4.0 * 4.0 * (60.0 / 126.0);
        assert!(
            seconds <= four_bars,
            "at {rate} Hz a 4-bar handover was scheduled {seconds:.3} s away, beyond one phrase"
        );
    }
}

#[test]
fn stem_cuts_silence_output_at_every_rate() {
    for rate in RATES {
        let mut e = Engine::new(rate);
        e.load_track(loaded_track());
        for stem in Stem::ALL {
            e.set_muted(stem, true);
        }
        e.play();
        let mut peak = 0.0f32;
        for _ in 0..(rate as usize / 128) {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for v in l.iter() {
                peak = peak.max(v.abs());
            }
        }
        assert!(peak < 1e-5, "muting every stem left {peak} at {rate} Hz");
    }
}

#[test]
fn output_gain_scales_cleanly_at_every_rate() {
    // The worklet crossfades decks by scaling output. A zero gain must be true silence
    // and unity must pass the signal through, at every rate.
    for rate in RATES {
        let mut e = Engine::new(rate);
        e.load_track(loaded_track());
        e.set_output_gain(0.0);
        e.play();
        let mut muted_peak = 0.0f32;
        for _ in 0..(rate as usize / 4 / 128) {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for v in l.iter() {
                muted_peak = muted_peak.max(v.abs());
            }
        }
        assert_eq!(muted_peak, 0.0, "zero output gain was not silent at {rate} Hz");

        let mut e = Engine::new(rate);
        e.load_track(loaded_track());
        e.set_output_gain(1.0);
        e.play();
        let mut peak = 0.0f32;
        for _ in 0..(rate as usize / 4 / 128) {
            let mut l = [0.0f32; 128];
            let mut r = [0.0f32; 128];
            e.process(&mut l, &mut r);
            for v in l.iter() {
                peak = peak.max(v.abs());
            }
        }
        assert!(peak > 0.02, "unity output gain silenced the signal at {rate} Hz");
    }
}