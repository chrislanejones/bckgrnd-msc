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
| 7 | `lib.rs:122` | Backspin is routed through the arp channel. The reference goes straight to master. | Backspin is quiet or gone when the arp is quiet or muted. |
| 8 | `lib.rs:411-417` | `synthetic_spin` treats a 0..1 fraction as seconds, and leaves out the 92 to 40 Hz thump. | Fallback backspin only. It falls instead of rising. |
| 9 | `transport.rs:172` | Brake floor is applied before the power, not after. `0.12^1.7` instead of `0.12`. | The brake drags about 4x slower at the end. |
| 10 | `dsp.rs` highpass Q | Six highpasses use Q 0.707. The reference leaves Q at Web Audio's default of 1.0. | Slightly less edge on hats and the kick click. |
| 11 | `dsp.rs` delay damping | One-pole at 2.4 kHz. The reference is a two-pole lowpass. | Echo repeats stay a little brighter. |
| 12 | `mixer.rs` | `dry` is applied before the saturator. The reference applies it after. | Only with Echo on. Less glue when the mix is wettest. |

Also left alone: the 15% duck attack glide was the one judgment call, and it now matches
the reference (instant drop, linear return).

## Still open from the restructure

- `.env` and `.env.static` are still in `floor-desktop/`. Move them to the repo root.
  `verify:static` fails until `.env.static` is there, because `vite build --mode static`
  reads it from the project root.
- The Laravel `APP_KEY` was committed in `01558c3` and is on both remotes. Rotate it with
  `php artisan key:generate`. Removing it from history needs a force-push.
