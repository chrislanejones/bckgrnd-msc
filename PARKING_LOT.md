# Parking lot

## Session note — backspin fix, uncommitted (10-03/04)

Working tree has an uncommitted fix to `engine-core/src/lib.rs` for "backspin sounds
weird." Builds clean, four new guard tests pass (`cargo test --release --lib backspin`).
Stopped before the browser gate (`verify:audio`) and before committing — pick up there.

Found four stacked bugs in backspin, worse than the two already listed below (now
removed from the table, folded in here):

1. **It wasn't reversed at all.** `ReverseVoice`'s cursor started at the end of the
   captured buffer and counted down to 0. `Ring::take` already hands back the capture
   newest-first, so counting down replayed it in its *original* chronological order —
   forward, not backward. Fixed: cursor starts at 0 and counts up.
2. **The rate sweep was clamped to a constant 20x.** `exp_between` floors both ends at
   20 because it's written for filter frequencies (20 Hz = bottom of hearing). Used on
   a *playback rate*, 0.62 and 2.8 both became 20, so every backspin ran at a flat 20x
   and tore through 1.35 s of audio in ~67 ms. This was almost certainly the dominant
   cause of "weird." Fixed: rate sweep uses `geom` instead, uncapped.
3. **The deceleration stage was missing.** Reference sweeps 0.62 → 2.8 over 420 ms,
   *then* 2.8 → 1.15 over the next 240 ms, so the gesture winds up and eases back
   toward normal speed. The port only had the first stage and then held at 2.8x for
   the rest of the voice. Fixed: added the second ramp.
4. **Routing comment lied.** `Voice::stem()` said the reverse take "bypasses the stem
   faders" but routed it through `Stem::Arp`'s channel — fader, mute, solo and the
   kick's duck all applied. On a track with a quiet arp, backspin was quiet too; with
   arp muted, silent. Fixed: `stem()` now returns `Option<usize>`, `None` for the
   reverse voice, and `render_sample` sums it straight into the master bus bypassing
   every channel strip.

Also rewrote `synthetic_spin` (the fallback used when there's no audio yet to reverse):
it compared `i / n` — a 0..1 fraction — against breakpoints the reference gives in
*seconds* (0.06, 0.5, 0.66), so the sweep raced through its first 4% and crawled through
the rest. Added the missing 92→40 Hz thump oscillator, which the port had dropped
entirely. Same envelope-shape bug (steal `SPIN_FLOOR`/`geom`) applies to `spin_hiss`,
also rewritten to take an explicit `SpinShape` rather than borrowing `ReverseVoice`'s old
one-size envelope.

New types: `SpinShape` (rate_from/mid/to, ramp_up/down, peak, attack, hold_until,
release — all in seconds) and `ReverseVoice::flat()` for the two synthesized,
already-shaped buffers (synthetic spin, hiss) vs `ReverseVoice::new()` for the real
captured take.

**Next session:**
- Run `cargo test --release` (full suite, not just `backspin`) and `cargo clippy
  --all-targets` — only ran the targeted backspin tests before stopping.
- Run `pnpm run verify:audio` against a rebuilt wasm (`pnpm run build:engine`).
- Spot-check by ear: backspin on a track that's been playing a while (real-take path)
  and backspin right after load (synthetic fallback path).
- If clean, commit. HANDOFF.md's defect table and PARKING_LOT's #7/#8 (removed below)
  should get entries matching the pattern already used for this session's other fixes.
- There's an untracked `rolled_repo/` at the repo root I didn't create — unrelated to
  this fix, left alone, worth asking Chris what it is before anything touches it.

---

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
- The Laravel `APP_KEY` was committed in `01558c3` and is on both remotes. Rotate it with
  `php artisan key:generate`. Removing it from history needs a force-push.
