# Parking lot

## Night 6 disposition — 2026-11-06

The dated reports below remain history. Current release evidence is in
[the Night 6 protocol](docs/NIGHT6_PROTOCOL.md); an implemented fix is not a
claim of speaker listening or production deployment.

| Report | Release disposition and evidence |
|---|---|
| ADSR release (#2), kick click (#3), clap offset/deep decay (#4/#5), brake floor (#7) | Correctness defects reproduced and fixed. Targeted Rust tests run at multiple sample rates; complete engine suite passes. |
| Hat attack (#6), highpass Q (#8), delay damping (#9), saturation order (#10) | Intentional sound differences retained for this release. No speculative reference-matching changes; listening approval remains open. |
| Solo echo residue | Reproduced excluded stems refilling shared returns during gain glide. Delay/reverb/throw input eligibility now follows solo; isolated regression passes. Speaker listening remains open. |
| Waveforms and silent-bar labels | Resolved edited lanes now drive visuals, using the acknowledged sounding revision; pending edits remain distinct. Editor/audio checks pass. |
| Separate undo; repeated velocity key entries | Unified project history, coherent scene restoration, one held-key gesture per undo; editor regressions pass. |
| Held FX refusal; competing scene/fill messages | Explicit available-after-mix feedback and combined cancellation status; UI regressions cover both. |
| Drawer/scene/held-pad overlap | November 5 stable layout supersedes older layout notes. Current five-width UI/editor checks pass; no redesign. Real two-finger touch remains untested. |
| Kick root after bass edits | Policy: kick sub remains tied to the defined source arrangement root. Bass edits do not silently retune it. |
| Legacy echo latch | Deprecated compatibility wrapper retained after consumer audit: worklet promotion/reset and engine/audio tests still use it. Never serialized. See NIGHT3_PROTOCOL. |
| Short telemetry test; missing forward boundaries | Event readiness with bounded timeout; separate actual forward-playback Break/Drop worklet fixture passes. |
| Native provider, package migration and PHP mismatch | NativePHP Desktop 2.4, real provider, PHP ≥8.4.1, packaged PHP 8.4.27; platform checks pass without bypass. |
| Night 4 unoptimized WASM | Release build requires wasm-opt; measure each final artifact in the release manifest, not historical figures. |
| Scene reverb decay stepping | Known limitation retained: feedback changes on the boundary; no delay-length jump. |

Post-release creative scope: timing humanization and pitch variation need harmonic
metadata; chord entry needs a chord editor; timed builds, phrase-ending fills,
Drop + Crash, stutter, randomize mix and alternate mixer modes are deferred, not
implemented. Existing velocity-only/rhythm-only/static/read-only labels stay.
Sound-selection groups apply immediately and are labeled accordingly.

Real-device iOS/Android startup, interruptions, locking, safe areas, two-finger
gestures and touch screen readers remain untested. Old environment relocation
and historical build notes below stay closed.

## Historical reports

Originally found against `old/src/lib/engine.ts`; see current dispositions above. Ordered by how much
each one is likely to be heard.

| # | Where | What's wrong | Audible effect |
|---|---|---|---|
| ~~1~~ | `mixer.rs`, `lib.rs` | ~~No gain smoothing on mute, solo, faders, master or EQ.~~ **Fixed 11-03-2026 (Night 2):** every user-moved gain glides in the engine (12 ms channels, 15–30 ms master, filter and EQ), tested in `engine-core/tests/smoothing.rs`. | — |
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

- ~~`.env` and `.env.static` are still in `floor-desktop/`~~ — stale, closed 11-03-2026.
  `floor-desktop/` no longer exists, and `verify:static` passes without `.env.static`
  because `build:app:static` sets `VITE_STATIC=1` itself.
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


## Found in the package update (10-21-2026)

- ~~**`php artisan test` can't run.**~~ — fixed 11-03-2026: `phpunit.xml.dist` plus
  186 tests covering the song form for every track, the API, the static export, presets
  and the project contract.
- **`nativephp/electron` and `nativephp/laravel` are abandoned.** Composer says to move to
  `nativephp/desktop`. This matters for the mobile app plan above.
- **Major versions held back:** TypeScript 7, Vite 8 (plus `@vitejs/plugin-react` 6),
  esbuild 0.28, lucide-react 1.x, concurrently 10, Laravel 13, tinker 3, PHPUnit 13.
  Each one is its own session.


## Found on Night 1 (11-03-2026)

- **`composer.json` says PHP `^8.3`, but `composer.lock` needs ≥ 8.4.1.** The 10-21
  update resolved symfony 8.x, which requires PHP 8.4. On 8.3, `composer install`
  refuses. (It does run with `--ignore-platform-req=php`, which is how Night 1 was
  tested.) Settle on 8.4 in `composer.json` before packaging (see
  [docs/NIGHT6_INVENTORY.md](docs/NIGHT6_INVENTORY.md)).
- ~~**`composer test` was red on every run.**~~ — fixed: the parity check failed on
  Kettle (rewritten on purpose 10-05) and on the six Breaks tracks (which have no
  original). It now lists both as deliberate departures and still checks the other
  eleven tracks exactly.
- ~~**The API and the static export disagreed on `parts`.**~~ — fixed: the API repeated
  it inside every track. It is now once at the top level, as the export and
  `LibraryResponse` have it. A test compares the two.
- ~~**A fresh clone serves a 500 on `/`.**~~ — fixed in `start.sh`: Laravel's gitignored
  `storage/framework/views` didn't exist. The API still worked, so it looked like a
  frontend problem.
- ~~**Space on the focused jog wheel did two things**~~ — fixed: a backspin *and*
  play/stop. Controls that use Space themselves now opt out of the global key.
- **`wasm-pack` downloads `wasm-opt` from GitHub at build time.** Where that is
  blocked the build stops after writing an unoptimized wasm (238 KB, against 201 KB
  optimized). Release builds must come from a machine where `wasm-opt` runs.
- **NativePHP can't open a window:** `config/nativephp.php` names
  `App\Providers\NativeAppServiceProvider`, which doesn't exist. Night 6, first item.

## Found on Night 2 (11-03-2026)

- ~~**The filter's Q jumped from 0.85 to 0.45 as the cutoff passed 97%.**~~ — fixed: it
  now blends over the last tenth of the travel, so a sweep through the top is smooth.
- ~~**The filter recomputed its coefficients every sample**~~ (a `powf`, a `sin` and a
  `cos` per sample, for a glide that moves far slower than that) — fixed: the filter
  and EQ step at control rate, every 16 samples, and only while they are moving.
- ~~**A cut sent just before Play let the first hit through.**~~ — found while adding
  the smoothing, fixed before it shipped: a stem's gain jumps to its target while its
  bus is silent, so a stem cut before anything sounds is silent from the first sample.
- **Touch screen readers have not been tried on a device.** The knobs are built on a
  native range input so VoiceOver and TalkBack can adjust them as platform sliders,
  and the touch-drag path is tested with real touch events in Chromium, but nobody
  has run the checklist in [docs/DESIGN_PHILOSOPHY.md](docs/DESIGN_PHILOSOPHY.md) on
  an iPhone or an Android phone yet. Do it with the mobile compatibility check.


## Found on Night 3 (11-04-2026)

- **Reverb decay changes instantly on a scene change.** `Reverb::set_rt60` retunes the
  combs' feedback at once instead of gliding, so a scene that moves `fx.reverbDecay`
  steps the tail's decay rate on the boundary. Nothing clicks (delay lengths don't
  move), but it is the one scene parameter outside ADR-013's smoothing.
- **Remove the old `set_echo(bool)` latch.** The UI now holds Echo through gesture
  tokens and no longer sends `{type: 'echo'}`. The worklet message, `Engine::set_echo`
  and `Mixer::set_echo` are still there (and Release FX and Panic still clear the
  latch), and `docs/NIGHT3_PROTOCOL.md` still says it works "until the UI moves to
  tokens". Delete all three together and update the protocol.
- **The solo flush leaves a −46 dB echo residue for about 100 ms.** Entering solo ducks
  and clears the echo and room (16 ms out, 48 ms hold, 16 ms back), but a little of
  the other stems' echo is still audible after it comes back.
- **"Stem groups" (Full mix / No drums / No music) overlaps the scenes.** The group
  buttons sit next to the new **Full** scene, also set cuts, and apply at once rather
  than on the bar (Night 3's "group pads on the next bar" wasn't built). Decide the
  naming and whether groups become scenes, quantized pads, or go.
- **Filter Hold and the solo flush were tuned by measurement only.** Filter Hold is
  0.3 of the travel (about 880 Hz), Q 3.0, −1.5 dB trim; the flush is 16/48/16 ms.
  Nobody has listened to either on speakers yet. Do a listening pass before release.
- **Touch screen readers haven't been tried on the new controls** either: the scene
  pads and their menu, Fill, Compare A/B, the held Echo and Filter pads, Release FX
  and Panic. Add them to the device checklist from Night 2.
- **The wasm grew 203 KB → 223 KB over Night 3 (+9.7%):** 203,016 → 222,709 bytes
  across the two engine commits. The fill parser is about 3.5 KB of it.
- **One status line for two outcomes:** Stop with a scene and a fill both queued ends
  on "Fill cancelled: playback stopped"; the scene's cancel message is overwritten.
  Both are true, but only one is announced.
- **A held effect refused during an auto-mix gives no feedback.** The scene pads say
  "Available after mix"; the Echo and Filter pads just don't latch.
- **On a 1440×900 screen the Echo and Filter pads sit below the fold** while the scene
  pads are near the top, so "hold Filter, tap Drop" on a touchscreen means scrolling.
  A layout pass (Lacey) on where the held pads live relative to the scene strip.
- **Two-finger touch (hold one pad, tap another) has only been emulated.** The fix
  that keeps a touch hold alive when focus moves is pinned by verify-ui, but a real
  device should try hold Filter → tap Drop → release.

## Found during Night 4 (11-04-2026)

- **The kick sub isn't retuned after a bass edit.** The engine tunes the kick's sub
  to the track's root once, at load (`kick_root_hz`). Editing the bass so that it
  centers on another note leaves the kick on the written root. Recompute it from the
  live bass lane at a revision boundary, or decide that the kick follows the track's
  key, not the bassline.
- **The deck waveforms and the "silent this bar" stem states still describe the
  track as written.** `soundingMap` and the deck drawing read the arrangement, not
  the working patterns. Clear the kick in bar 9 and the kick still says it plays
  there. Derive both from the working lanes.
- **The editor drawer covers the scene strip on desktop.** At 1440×1000 the drawer
  (up to 78% of the height) sits over the scene pads and Fill, so "edit, then launch
  Drop" means Escape, launch, reopen. The verify-editor walk does exactly that. A
  layout pass: dock the drawer, or keep the scene pads reachable above it.
- **Keyboard velocity changes are one undo step per key press.** A drag is one step.
  Holding an arrow on a velocity bar fills the history. Coalesce key repeats into one
  entry, as the knobs do (`editHistory` on key-up).
- **Pattern undo and the mix's edit log are separate.** Revert keeps a fader moved
  during a preview, as the brief asks. But Ctrl+Z in the editor only steps through
  pattern edits, and fader moves are still only recorded, never undone, until
  Night 5's history.
- **Static variations are coarse.** Three seeds per part and strength, whole parts
  only, and none around event locks or for edited phrases (each says why). The
  desktop app has no such limit.
- **Melodic variation is rhythm-only, and humanize is velocity-only.** No track
  records its key or chords as data. Pitch variation and timing humanize both wait
  for harmonic metadata from PHP.
- **Touch screen readers haven't been tried on the editor.** That covers the drum
  cells (toggle buttons with roving focus), the velocity sliders, the notes (focusable
  buttons with arrow keys) and the vertical faders. Add them to the device checklist.
- **Stab, pad and arp are read-only.** The engine and the contract accept edits to
  them already (`editable: false` in `contracts/patterns.json` is the only gate). The
  piano roll needs chord entry first.
- **The wasm here is a `--no-opt` build (270,638 bytes)** because wasm-opt can't be
  downloaded in this environment. It isn't comparable to Night 3's 222,709-byte
  optimized size. Measure the optimized build before release.
- **Project menu leftovers from the 11-06-2026 audit.** ~~Recovery rows have no date and
  no order.~~ ~~Exported files are written at mode 0600.~~ ~~An aborted open can show a blank
  "Open failed:".~~ (Dates, order and the blank message fixed 11-17-2026, `7c78240`; 0600 in rc.3.) A queued scene blocks Save if audio dies, because the confirmation
  never arrives. Nothing yet proves the web and desktop builds hash a track the same
  way, so a project may open with the library-changed warning when it moves between
  them, and the MCP would refuse it.
- **The last edit can still miss the recovery copy on a hard close.** Recovery waits
  400 ms and is written when the page hides or goes away, but the write hashes first,
  so a browser that closes at once can cut it short. A browser crash inside the 400 ms
  loses that one edit. Saved work isn't affected.
- **A file opened on desktop isn't tied to Save.** Save keeps a file current only after
  Save As. A project brought in with Import stays an app copy, and its original file is
  left alone. That matches the "Import" label, but the desktop File menu calls the same
  action "Open", where people may expect Save to write back. The reverse also holds: a
  copy of a file already saved with Save As shares its project ID, so Save updates the
  original Save As file (with a `.bak`) and never the copy. The notice names the path.
- ~~**The phone bar's second row overflows below about 370px.**~~ Fixed 11-12-2026: below 380px the readout hides. The part chips plus the
  "Stopped" / bar readout need about 210px, but the song-position cell is capped by the
  first row's columns (168px at 320). The readout runs under the meter's L/R labels. This
  predates the 11-11 compact pass (old 8px chips overflowed by 68px at 320, now 50px), and
  verify-ui's bar-overlap check compares element boxes, so it doesn't see text spilling out.
  The fix is a content decision: drop the readout below 380px, or move the meter. (Lacey, 11-11-2026)
- ~~**README still puts Panic "under the pads"**~~ Fixed 11-17-2026 (`2157559`).

## Found in the rc.2 acceptance run (11-13-2026)

- ~~**The MCP's shared renderer is one change behind the app.**~~ Resynced 11-17-2026 in bckgrnd-msc-mcp PR #1. It's still versioned `0.4.0-rc.1`; rc.2 is Chris's call.
- ~~**`bckgrnd_render_project` gives a raw `ENOENT … mkdtemp` when the output folder
  doesn't exist.**~~ Fixed 11-17-2026 in bckgrnd-msc-mcp PR #1: "The folder … doesn't exist."
- **Narration under a hot voice peaks at -0.4 dBTP** when `final_lufs` isn't set (voice
  raised +5 dB to -16 LUFS). Fine for MP3 at that level, but close to the line; a
  default ceiling of about -1 dBTP would be safer. (MCP repo.)
- **verify-ui can time out under heavy machine load.** Inside `verify:desktop` on
  11-13-2026, the wait for playback after "Bring in Clap" + Space (verify-ui.mjs line
  218) hit its 30 s limit while another session ran Playwright. Five standalone runs
  passed 301/301 right after. If it repeats on a quiet machine, look at it then.

## Found in Night 6H (11-15-2026)

- **Fixed in rc.3 (`7e2b8a5`).** ~~An exported WAV is private (`-rw-------`).~~ `NativeProjectController` (line 57)
  calls `ProjectFiles::atomicWrite($path, $wav)` without a mode, so a new WAV keeps
  `tempnam`'s 0600. Project files got this fix in `5297ca6`; the WAV path didn't. One-line
  fix: pass `0666 & ~umask()` for a new file, plus a PHPUnit case. A runtime change, so it
  means an rc.3 build; Chris decides whether it goes in this release.
- **Fixed in rc.3 (`70a2d23`).** ~~`verify-native` never closes its second app launch.~~ After the PASS line, Node
  waits on the still-open window, so the run looks hung until someone closes it. Close
  the window (the same `close-window` helper) at the end of the test.

## Found while adding the hip-hop tracks (11-16-2026)

- ~~**The MCP companion doesn't have Cipher or Boulevard.**~~ In review 11-17-2026: bckgrnd-msc-mcp PR #1 syncs the library from `59995c1` (20 tracks, a Hip-hop section). Merge it after this repo's PR #5.

## Found in Night 7 (11-16-2026)

- ~~**The pattern drawer leaves room unused under its toolbar.**~~ Fixed 11-17-2026 (`5d85754`): the body is fixed to the tallest lane; 608 → 523 px at 1440 × 900, and the tabs still don't move.
- ~~**The docked inspector still scrolls at 1440 × 900.**~~ Fixed 11-17-2026 (`5fdecaf`): Output folds, Echo's divisions share its knob row, and dials are 48 px with a mouse. Content 1007 → 811 px in an 813 px box.
- ~~**The stems toolbar `title` now covers the Level / Solo / Cut legend.**~~ Fixed 11-17-2026 (`0a63bc2`).
- **The Switch on toolbar sits just under the fold at 1440 × 900.** The four scene cards are now in the first screen; the timing row starts about 900 px down. Getting it in would mean a shorter fader travel (11rem today) or folding the stems footer line. Left for Chris to weigh, because both touch performance controls.
- ~~**`verify:desktop` fails in a fresh worktree until Laravel's runtime folders exist.**~~ Fixed 11-17-2026 (`a503b5a`): the three folders carry a `.gitkeep`.

## Found in Night 7 (11-17-2026)

- ~~**A landing scene can't carry pattern lanes.**~~ Fixed 11-17-2026 (`21973fd`): a build takes linked lanes that commit on its end onset, after the landing.
- **Builds step once per sixteenth.** Each onset sets the next value and the ADR-013
  glides fill in between. At slow tempos a deep filter build could step audibly (the
  30 ms filter glide finishes well inside a 214 ms step at 70 BPM). If anyone hears
  it, move the progress inside the step at control rate (`to_next / step_len`). The
  end points stay on onsets.
- ~~**`engine-core` has no `cargo bench` harness.**~~ Fixed 11-17-2026 (`0a2c60a`): `cargo bench --bench render`, with no new dependencies.
- ~~**No eslint in this repo.**~~ Fixed 11-17-2026 (`bd91868`): `pnpm run lint`, also a step in both verify suites. 0 errors; 5 warnings are parked below.
- ~~**`ENGINE_EVENT` in `frontend/lib/engine.ts` has no pattern kinds (31-35).**~~ Fixed 11-17-2026 (`9988dfa`).
- ~~**Rise wraps the scene toolbar under 1440px.**~~ Fixed 11-17-2026 (`f842533`): short Switch on names whenever the scenes panel is 45rem or narrower; 1280 × 800 stays at 74 px.
- ~~**A rise into a scene with captured patterns lands its lanes a bar late.**~~ Fixed 11-17-2026 (`897223d`): they land on the end bar line with the build.

## Found in the Night 7 follow-ups (11-17-2026)

- ~~**Around 1180px the scenes panel stacks, and Rise still adds a row there**~~ Fixed 11-19-2026 (`ccf3ece`): 108 → 108 px with Rise on; 1200 px no longer wraps.
- ~~**The inspector still scrolls at 1280 × 800 and 1024 × 768**~~ Fixed 11-19-2026 (`ccf3ece`): 686 px of content in 722 and 690.
- ~~**The Output fold isn't remembered**~~ Fixed 11-19-2026 (`ccf3ece`): saved as `bckgrnd-msc:output-open`.
- ~~**`--knob-size` is a new density token**~~ Fixed 11-17-2026 (`8673480`).
- ~~**At 1366 × 640 the drawer body scrolls 23 px at rest**~~ Fixed 11-19-2026 (`ccf3ece`).
- ~~**Lanes staged for a refused request can strip a pending scene's**~~ Fixed 11-19-2026 (`2e29170`): linked lanes wait in a staging slot until their request is accepted.
- ~~**NIGHT4_PROTOCOL.md's message table lists only `scene` as carrying `patterns?`.**~~ Fixed 11-17-2026 (`8673480`).
- **Bench numbers drift about 4% run to run on this shared machine.** Compare the
  `build` and `lanes` cases against `plain` from the same run, not across runs. (Silas)
- **Five `react-hooks/exhaustive-deps` warnings:** `instrument.ts` (idleDeck), `projects.ts`
  (list), `Deck.tsx` (silenced), `Knob.tsx` and `VerticalFader.tsx` (historyId). Before
  "fixing" each one, check whether leaving the dependency out was deliberate.
- **Narration's default true-peak ceiling** (the rc.2 note above) changes what users hear,
  so it waits for Chris.

## Found on Night 8 (11-19-2026)

- ~~**The host tracks one scene request at a time.**~~ Fixed 11-24-2026 (`49f896b`): one
  record per request id (`RequestBook`). It was reachable: a scene canceled over a running
  Rise blanked Drop and stopped the knobs following.
- **Linked-lane event sequence changed.** A pending scene with lanes replaced by a request
  carrying its own lanes now sends `scene replaced` then `patterns cancelled` (33, reason
  10), not `patterns replaced` (34). NIGHT4_PROTOCOL should say what 33 vs 34 mean for
  linked lanes. (Silas, for Dara)
- **`queue_scene`'s doc comment sits above `queue_patterns`** in `engine-core/src/lib.rs`. (Silas)
- **Slow Rise is a staircase.** The build base moves once per 16th; smoothing glides each
  step in 30 ms. At 70 bpm the cutoff then sits still up to 141 ms per 16th (58-cent steps
  on a full sweep, 22 on Full → Build). At 140 bpm it's near continuous. Listen before
  changing DSP. (Silas, for Chris)
- **The "held arrow is one undoable gesture" editor check flakes under load.** Second time it
  failed `verify:desktop` while other heavy jobs ran; passes standalone. (Silas, Tara)
- **"cancelled" vs US "canceled"** in Rise status lines and the protocol. Kept because the
  checks pin it; a rename touches UI copy, docs and tests together. (Tara)
- **`verify:web` doesn't run `verify-ui`**, so the Rise browser checks run only under
  `verify:desktop`. (Tara)
- ~~**At 1366 × 640 the inspector scrolls**~~ Fixed 11-24-2026 (`c5d9385`): 559 in 559.
- ~~**With Output open, the inspector scrolls at 1280 × 800 and 1024 × 768**~~ Fixed
  11-24-2026 (`c5d9385`): 686 in 686 at both.
- ~~**The scenes toolbar is 108 px at every mouse width.**~~ Fixed 11-24-2026 (`3a04c94`):
  Compare A/B folded, approved by Chris.
- **On the phone, Rise on still adds a row** below Switch on; controls below shift down. (Lacey)
- ~~**Phone inspector sheet targets under 44 px**~~ Fixed 11-24-2026 (`3a04c94`): knob value,
  Reset, Echo time and inspector buttons take a 44 px tap. The pattern editor's step grid
  still wasn't audited. (Lacey)
- **The MCP needs a resync before rc.2** from the same commit as the next desktop build.
  Done on MCP branch `night9/mcp-v4` (11-24-2026); ships when Chris releases both.
  Audio is byte-identical to `main`, but four engine files differ, so the render-parity
  file check would fail. (Phase 5 audit)
- **The Linux candidate needs a rebuild** before the .deb checks count: rc.3 (`19c93c5`)
  predates Night 7. Checklist: `docs/releases/RC_MANUAL_CHECKLIST_11-19-2026.md`.

## Found building Night 8 transitions (11-19-2026)

- ~~**`process()` already allocates on every tone note**~~ Fixed 11-24-2026 (`473d13c`):
  voices hold oscillators inline; `no_alloc.rs` covers tone stems; 80 renders bit-identical.
- **The MCP refuses every v4 project** until it vendors the v4 contracts. Fixed on MCP
  branch `night9/mcp-v4` (11-24-2026), not released. Ship the MCP
  resync with the desktop build: `scripts/sync-engine.mjs:27` hard-codes
  `projectVersion: 3`; `src/projects.ts:87` `schema_version` and `project_sha256` change
  for migrated v3 files; recorded hashes need regenerating. npm publish is Chris's. (Vivek)
- ~~**Touch users can't see why Fill is unavailable**~~ Fixed 11-24-2026 (`3a04c94`): a press
  on an unavailable Fill or Fill → Drop shows the reason in the status line.
- ~~**The scenes toolbar is three 32 px rows (108 px) on desktop.**~~ Fixed 11-24-2026
  (`3a04c94`): Compare A/B folds into the header; 70 px by default, 108 while comparing. One control row needs
  950 px; getting there means moving Compare A/B out of the toolbar. At 1440×900 the
  scenes panel starts around y 785, set by the panels above. (Lacey)
- ~~**Phone sheet targets still under 44 px**~~ Fixed 11-24-2026 (`3a04c94`).
- **Scene pads and Cancel still use native `disabled`**; the fill buttons moved to
  `aria-disabled` so keyboard users can reach the reason. (Lacey)
- **Mixed "cancelled" / "canceled"** can now appear in one status line. (fill UI)
- **Crash level** when it plays alone and when it merges with step 192 is for Chris's ears. (Vivek)
- **ADR-008 says solo doesn't affect transition sounds, but since Night 3 none start under
  a solo.** The code is right; the ADR is stale. **ADR-015 says the latest fill wins, but the
  engine refuses a second one (8).** (Dara)
- **Judgment calls made in the build, for Chris to confirm by use:** Reset to factory keeps
  a scene's crash; Duplicate keeps the target's own; a Rise + Fill withdraws a waiting
  plain Fill or Fill → Drop first; Fill → Drop still fires when Drop is already active; a
  scene launched over a pending Fill → Drop keeps its own timing and the fill plays on plain.

## Found on Night 9 (11-24-2026)

- **Listen to the four fill styles** (Classic, Simple, Busy, Syncopated) on each track kind,
  with Fill, Fill → Drop and Rise + Fill. Not listened to. (Chris)
- **The MCP plays Classic only.** It doesn't read `fillStyles`; renders never play fills,
  so nothing is lost today. (ADR-024)
- **A project doesn't record which fill style was played.** By design (app preference);
  revisit if styles become part of a song. (ADR-024)
- **Classic's open hat (0.55) on deep tracks is louder than some tracks' own open-hat peak**
  (glass 0.4, cipher 0.26). On main before Night 9; Classic was kept byte for byte.
- **Fill Style menu placement.** It sits in the Scenes header because the Fill row was full
  at 900–1280 px; a native select styled like Next song, since controls.tsx has no select.
  Worth a Lacey pass with the Compare fold. (Lacey)
- **At 1366 × 640 with Output open the inspector still scrolls** (638 px in 562). Output is
  opt-in; fixing it needs another fold or smaller knobs. (Lacey)
- **Compare listens share the pending scene request with launches** (`requestLaunch`); check
  any Compare move against the per-request book. (Lacey, Silas)
- **The swapped-out-lanes list holds two lane sets.** A third swap before the next pattern
  message would grow it on the audio path. Unconfirmed; needs a no-alloc test that lands
  three lane sets in a row. (Silas)
- **A chord over 6 notes now plays its first 6.** Patterns cap at 6 and the library peaks at
  4; consider checking at track load. (Silas)
- **The browser/installed-native render-parity leg** (`tools/verify-render-parity.mjs`,
  needs `NATIVE_CDP`) wasn't run for the MCP sync; the Node parity was 48/48. (MCP)

## Found in Night 9B (11-24-2026)

- **Listen to Random and Rotate** in use, with Fill, Fill → Drop and Rise + Fill. (Chris)
- **"Synco" on the Fill button.** "Syncopated · Next phrase" doesn't fit the Fill row at
  1180 px, so the button alone says "Synco"; the menu, tooltip and screen-reader name say
  Syncopated. Chris: keep it, or drop the style from late labels. (fill UI)
- **The Fill style menu is 172 px wide** ("Random · next Syncopated") beside Compare A/B in
  the header. At 1280 the status line has about 140 px left and long lines truncate (full
  text in a tooltip). (Lacey)
- **Random/Rotate sequences live only in the app**; another client can't reproduce them.
  (ADR-024)
- **No browser test covers a Rise under a queued scene through an auto-mix handover**;
  the fix (`bookCancelAll`) covers it, the test covers Panic only. (Silas)
- **Scene pads and Cancel still use native `disabled`**, so a press can't show a reason; if
  they move to `aria-disabled` they can reuse `useSceneNotice` in `SceneStrip.tsx`. (Lacey)
- **On touch, a knob value's tap area covers the dial's bottom 7 px** (dial tappable over
  49 of 56 px). Watch for missed drags on the phone. (Lacey, Chris by use)
- **On the phone the scenes status line keeps its own row when empty** (about 19 px).
  Collapsing it would make the header jump. (Lacey)

## Found in Night 10 Beat Repeat (11-24-2026)

- **Listen to Beat Repeat** at 1/4 to 1/32, its seams (2.5 ms dips) and the 8 ms release,
  with Filter Hold and Echo Throw over it. (Chris)
- **The transport rounds every step up to a whole sample.** `Transport::tick` sets
  `to_next = step_len - 1` and drops the fraction, so steps are `ceil(step_len)` long and
  the tempo runs a little slow (about 0.02% at 123 BPM, 44.1 kHz). Beat Repeat matches the
  clock as it is. Fixing the clock changes every render. (Silas, ADR if fixed)
- **Picking a track doesn't clear a held Echo or Filter on screen.** `selectTrack` stops
  the deck, which ends every gesture in the engine, but only Beat Repeat's pad is cleared
  there; the others show held until the finger lifts. (Lacey/Silas)
- **A tempo change or bend while a repeat is held** keeps the captured slice length, so
  the stutter drifts off the new grid until release. It could capture again on a tempo
  change, but a tempo glide would then capture again on every grid line. (Silas)
- **The temporary Repeat pad and division picker** sit in the Deck pads and foot, plain.
  (Lacey)
