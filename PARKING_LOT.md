# Parking lot

Found, verified against `old/src/lib/engine.ts`, and not fixed yet. Ordered by how much
each one is likely to be heard.

| # | Where | What's wrong | Audible effect |
|---|---|---|---|
| 1 | `mixer.rs`, `lib.rs` | No gain smoothing on mute, solo, faders, master or EQ. The reference uses `setTargetAtTime` (12–20 ms). | A click on every stem toggle, which is the main thing the app does. |
| 2 | `dsp.rs` `Adsr` | Release starts `attack` seconds late. `hold_end` is measured from note-on, but `elapsed` is re-based when the attack ends. | Pads sustain up to 0.7 s too long. `release_starts_at()` disagrees, so the filter sweep closes early. |
| 3 | `drums.rs:141` | Kick click decays with `*= 0.86` per sample, not over 15 ms. | About 13x too short, and it changes with the sample rate. The kick loses its beater. |
| 4 | `drums.rs:200,206` | The clap tail's 18 ms offset is counted twice, as a delay and as an attack. | The clap peaks at 36 ms instead of 18, and smears behind the backbeat. |
| 5 | `drums.rs:189-197` | Deep clap branch tests `kind_freq < 1000.0`, but deep passes 1250. It never runs. | Deep gets the house clap decay (0.13 s) instead of 0.2 s. |
| 6 | `dsp.rs:185` | `Adsr` clamps attack to 4 ms. Pitched voices want that. The drums in the reference don't use it. | Hats get a 4 ms fade-in and lose their tick. |
| 7 | `transport.rs:172` | Brake floor is applied before the power, not after. `0.12^1.7` instead of `0.12`. | The brake drags about 4x slower at the end. |
| 8 | `dsp.rs` highpass Q | Six highpasses use Q 0.707. The reference leaves Q at Web Audio's default of 1.0. | Slightly less edge on hats and the kick click. |
| 9 | `dsp.rs` delay damping | One-pole at 2.4 kHz. The reference is a two-pole lowpass. | Echo repeats stay a little brighter. |
| 10 | `mixer.rs` | `dry` is applied before the saturator. The reference applies it after. | Only with Echo on. Less glue when the mix is wettest. |

Also left alone: the 15% duck attack glide was the one judgment call, and it now matches
the reference (instant drop, linear return).

## Still open from the restructure

- `.env` and `.env.static` are still in `floor-desktop/`. Move them to the repo root.
  `verify:static` fails until `.env.static` is there, because `vite build --mode static`
  reads it from the project root.
- ~~The Laravel `APP_KEY` was committed~~ — closed 10-05-2026. The app is stateless
  (no sessions, no encryption), so the key protected nothing; `floor-desktop/.env`
  and `.env.static` were also scrubbed from history on both remotes.

## Found 10-05-2026

- ~~`start.sh` only builds missing outputs~~ — fixed 10-05-2026, it now rebuilds
  anything older than its source.
- `verify:audio` failed once in about ten runs on "telemetry arrives at ~30 Hz" and
  "playhead advances", then passed on rerun. It times a 1.2 s window, so it is
  sensitive to load on the machine.
- ~~The top section of this file ("backspin fix, uncommitted") is stale~~ — moved to
  [docs/archive/](docs/archive/README.md) 10-05-2026. The fix is `e6fcd0d`.

## Sound work (approved 10-05-2026) — DONE

Landed as transition sounds, lo-fi texture and percussion (hashes changed in the
10-05 history scrub). The lo-fi texture was later **removed**: it read as rain.
The original brief is kept below for reference.

- ~~CPU check on other filters~~ — fixed 10-05-2026. The master chain (reverb combs
  and allpasses, the echo lines, every biquad) sank into subnormal floats in silence and
  got slower the longer it sat: 30 s after Stop, 681 → 12,426 ns/sample. A shared
  `dsp::flush` now zeroes state below -400 dB; Stop stays flat at ~500. Leftover,
  cosmetic: the stem meter level (`Channel::level`) can sit subnormal; costs nothing.
- `verify:audio` can't jump the playhead, so the browser gate never reaches the
  Break/Drop transitions or most percussion. Only the Rust tests cover them.

### Original brief

Run in this order, after the waveform scratch lands. None needs a 9th stem.

1. **Transition FX.** A noise riser into the Drop, a crash on the Drop's downbeat, a
   downsweep into the Break. Played outside the stems, the way backspin is, so the
   `[ ]` song sections sound like sections. Effort: medium.
2. **Lofi texture.** Vinyl crackle and tape hiss on the master, Lofi tracks only.
   Effort: small.
3. **Percussion in the hats stem.** Shakers, rimshots and congas as extra voices on
   the existing hats stem, for the garage, breaks and lofi grooves. Effort: medium.

## Found with the waveform scratch (10-05-2026)

- ~~Auto mix during a held scratch~~ — fixed 10-05-2026: the mix releases the
  scratch first (`scratch_release`), and the UI no longer messages the new deck.
- ~~The scratch reader and the ladder filter are worth an ADR~~ — drafted 10-05-2026
  as [ADR-007](docs/adr/007-scratch-replays-the-capture-ring.md) and
  [ADR-004](docs/adr/004-ladder-filter-for-acid-bass-and-lead-only.md).

## Found in the README audit (10-05-2026)

- ~~Tempo fader stops at 150 bpm~~ — fixed 10-05-2026, the fader is 60–180.
- ~~Cue always plays deck A~~ — fixed 10-05-2026, Cue plays the live deck.
- `HANDOFF.md` is partly stale ("12 tracks", layout missing `scratch.rs`,
  `transition.rs`, the Breaks section; British spellings on lines 5 and 119). Worth a
  targeted update rather than archiving.


## Planned: NativePHP mobile app (target: week of 10-05-2026)

Package the app for iOS and Android with NativePHP's mobile package. The desktop
packages (`nativephp/laravel`, `nativephp/electron`) are already installed; mobile is
not. Things to settle before or while building it:

- **AudioWorklet in the app's webview.** The whole engine runs in an `AudioWorklet`,
  which only exists in a secure context. Check that the mobile webview serves the app
  from an origin that counts as secure, on both iOS and Android, before anything else.
- **Audio session behavior.** Silent switch on iOS, playing with the screen locked or the
  app in the background, and interruptions (calls, other apps' audio).
- **Touch.** The jog wheel and the waveform scratch are pointer gestures; check them on a
  real phone, including that the page doesn't scroll under a drag.
- **CPU and battery.** Two engines render in one worklet at all times. Measure on a mid-range
  phone. The filter CPU check is done (silence no longer gets slower); full-mix
  cost on desktop is about 550–640 ns per sample per engine.
- **Presets.** Saved presets are JSON on disk through Laravel. On mobile that disk is the
  app's own storage, so they could work there even though the Netlify build lacks them.
- **Leftovers from the desktop setup.** `config/nativephp.php` still has the old app id
  `dev.floor.stemmachine` (the app was called FLOOR), and `floor-desktop/` still holds the
  desktop `.env` files. Rename and move as part of this work.
- **Layout.** The phone layout works in a narrow browser; recheck it at real phone sizes
  with the system's safe areas (notch, home bar).

