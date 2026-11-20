Latest handoff: [2026-11-05 — Stems, scenes, and pattern editor](docs/sessions/2026-11-05-stems-scenes-ui.md).

# Night 3 session log

Branch `night3/scenes-performance`, worktree `~/ai-repo/bckgrnd-msc-night3`, started
11-04-2026 from main at `a8917a2`. Spec: the Night 3 brief (scenes, musical timing,
live performance). Working protocol: `docs/NIGHT3_PROTOCOL.md`.

## Who owns what

| Area | Owner | Files |
|---|---|---|
| Scene contract, migration, factory scenes | main session | `contracts/`, `app/Support/Project/`, `frontend/lib/contract.ts`, `tests/`, `tools/check-contract.mjs` |
| Scheduler, scene transaction, events, worklet glue | Silas | `engine-core/`, `frontend/worklets/engine-processor.ts`, `frontend/lib/engine.ts` |
| ADR 014 (scenes in project v2), ADR 015 (engine scheduling, overrides) | Dara | `docs/adr/` |
| Scene strip, timing selector, Compare A/B, Release FX, Panic | main session | `frontend/ui/`, `frontend/lib/instrument.ts`, `frontend/app.tsx` |

## Decisions

| Decision | Why |
|---|---|
| Scene parameters = `sceneVector` in `contracts/scenes.json` (the twelve `fx.*`) | One list that is also the engine vector order, so the TS, PHP and Rust readers cannot drift. |
| A v2 document with a malformed scene is refused whole, not clamped | The spec: reject malformed scenes as a whole and leave the mix untouched. Project-level `params` keep their v1 clamp rule. |
| A v1 document that carries `scenes` is refused | v1's schema forbids extra keys; reading it would mean silently ignoring data. |
| Active scene is session state, not saved | Opening a project must never launch a scene over the saved mix. |
| No file save is claimed | The app has none until Night 5; scenes live in the in-memory project. |

## Gates

| Commit | Gates |
|---|---|
| `375003a` feat(contract): scenes in project v2 | PHPUnit 201 pass; check:contract 16/16, every track round-trips with scenes; typecheck pass |
| `4d74911` feat(music): one-bar fills | PHPUnit 204 pass; check-arrangement 18 tracks pass; parity 165 pass; check:contract pass |
| `5181e98` feat(engine): musical scheduler | fmt, clippy -D warnings, cargo test 210 pass (debug + release), build:engine, build:worklet, typecheck. Wasm +6,525 bytes (+3.2%) |
| `43a598d` feat(engine): overrides, fills, silence, panic | fmt, clippy, cargo test 236 pass (debug + release), build:engine, build:worklet, typecheck. Wasm +13,168 bytes (+6.3%); 60 s native render within noise |
| `fcceeb9` feat(ui): scene strip, compare, fill, held effects, panic | PHPUnit 204, check:contract, check:scenes 25/25, typecheck, verify:ui pass, verify:audio pass (room check reworked + new all-cut check) |

## Order deviations

| What | Spec said | Did | Why |
|---|---|---|---|
| Fill recipes (PHP data + export) | Commit 5 | Committed after commit 1, as data only | Nothing plays them until the engine's fill lands; shipping the data early lets Silas test against real recipes. |
| Engine work | Commits 2, 3, 5 | Two engine commits: scheduler + atomic scene commit (5181e98), then overrides + fills + silence + panic (43a598d) | Silas built them as two coherent tasks; splitting further would have split one file's changes across commits for no reader's benefit. |
| UI | Commits 4 and 5 | One UI commit | The strip, fill, compare and held effects share the same lines in instrument.ts and app.tsx. |
| verify-audio room check | (not in spec) | Reworked: 7 cut + 1 whispering instead of all 8 cut | The old check stopped the music by cutting every stem, which the new all-cut rule now (correctly) silences. A new check holds that rule. |

## Found along the way

| Finding | Status |
|---|---|
| Before the first Play there is no worklet, so a scene picked while stopped waited forever ("Sending…") | Fixed: UI applies it through the parameter path when `!engine.booted` (getter landed in 43a598d) |
| At boot EngineHost replayed parameters *before* the held track load, and `load_track` resets faders, sends and tempo, so anything moved before the first Play was lost (pre-existing) | Fixed in 43a598d: held messages replay first, then the latest parameters |
| Reverb decay changes instantly on a scene change (`set_rt60`), not with the ADR-013 glide | Parking lot |
| "Stem groups" (Full mix / No drums / No music) also sets cuts, next to the new Full scene | Left alone, flagged to Chris |
| Capturing B left A marked "Listening" although B is what plays after its capture | Fixed: each capture marks that slot as the one heard |
| Held effect during an auto-mix would apply to the outgoing deck and go stale | UI refuses held effects while mixing and releases them when a mix starts |
| Panic mid-mix sends no mixEnd | UI resets its own mix state on Panic |
| Rename… dropped focus to the page, so Escape stopped closing the menu (Tara) | Fixed: the field takes focus |
| Keep current with a compare listen still queued let it land afterwards and replace the kept mix (Tara) | Fixed: Keep current cancels a queued listen or Exit |
| Any focus change released a held pad, so on touch "hold Filter, tap Drop" let go of Filter (Tara found, main session fixed) | Fixed: focus loss ends keyboard holds only; pointer holds end on pointer up / cancel / lost capture. verify-ui pins it |

## Browser probes (worktree on :8180)

| Flow | Result |
|---|---|
| Drop mid-bar | Queued · Bar 2 → Active at the boundary; knobs show Drop's values |
| Knob after launch | Active · Modified |
| Build then Sparse before the boundary | Only Sparse launches, on Build's bar |
| Queue then Cancel queued | Nothing changes |
| Menu: capture, rename (blank refused), duplicate, reset, Escape | All work |
| Scene before first Play | Active at once, playback stays stopped; still applied after Play (boot-order fix) |
| Fill: queue, second press, play, return; while stopped | Fill · Bar 2 → cancelled → playing (disabled) → Fill; stopped: disabled with "Press play first" |
| Hold Filter, capture, launch Drop, release | Heading says "Filter · held", knob shows base; capture stores the base; release lands on Drop |
| Hold Echo, window blur | Released |
| Compare A → B → Exit | Each heard on the boundary; Exit restores the earlier mix; scenes intact |
| Panic with a launch queued | Stopped, nothing queued, effects released |

## Final gates (worktree build, :8180 / :8190)

| Gate | Result |
|---|---|
| cargo fmt / clippy -D warnings | pass |
| cargo test (Silas, after 43a598d) | **236** pass, debug and release |
| PHPUnit | **204** pass |
| check:contract | 16/16 fixtures, every track round-trips with scenes |
| check:scenes | **25/25** |
| typecheck, build, build:static | pass |
| verify:ui | **152** ok (was 75), 0 FAIL, mutation-tested by Tara |
| verify:audio | all pass, including balance and the new all-cut silence check |
| verify:static | pass; static library carries the fills |
| Listening pass | **not done: needs Chris** |

## Skipped or deferred

| Item | Where it went | Why |
|---|---|---|
| Compact and expanded mixer (was on the roadmap's Night 3 list) | Night 4 | Not in the Night 3 spec; the Night 4 editor drawer competes for the same space |
| Stutter / beat-repeat | Night 4 | Spec: defer unless the DSP already exists; it doesn't |
| Group pads that mute groups on the next bar | Later | The existing Stem groups still apply at once; scenes cover the quantized case |
| Last-beat fill, Fill into Drop, Drop + Crash accents | Night 4 | Spec: one predictable one-bar fill first |
| Timed 8-bar builds / automation | Night 4 | Spec: Build is a snapshot in Night 3 |
| Scene ownership across a crossfade | Night 5 | Spec: launches and fills are refused during an auto-mix |
| Saving scenes and Compare A/B to disk | Night 5 | No project save exists yet |
| A listening pass (clicks, tails, level jumps, held-effect feel) | Chris | Can't be done by an agent; state checks pass but do not prove it sounds right |

## Session saved 11-04-2026

| Item | State |
|---|---|
| Branch | `night3/scenes-performance`, 6 commits on `a8917a2`, **not pushed, not merged** |
| Worktree servers | `php artisan serve` on 127.0.0.1:8180, static `php -S` on :8190 (main checkout stays on 8080 / 8090) |
| Waiting on Chris | Listening pass (the spec's final demonstration), then "push" and/or "merge" |
| Open decisions | Stem groups next to the Full scene (keep, rename, remove); accept ADR 014 and 015; compact mixer in Night 4 or 5 |

Next session: run Chris's listening notes as fixes on this branch, re-run the full gates
(cargo, PHPUnit, check:contract, check:scenes, typecheck, build, build:static, verify:ui,
verify:audio, verify:static), then push or merge only on an explicit word.

---

# Night 4 session log

Branch `claude/music-instrument-roadmap-5d70t5` (restarted from main after PR #1
merged), 11-04-2026. Spec: the Night 4 brief (pattern editing, constrained variation,
better vertical faders). Working protocol: `docs/NIGHT4_PROTOCOL.md`.

## Order kept

4A vertical faders → 4B contract v3 → engine revisions (4F's engine half) →
4C/4D editor with real undo → 4E humanize, PHP variations, preview/keep/revert → 4F
scenes with lanes and acceptance tests. The engine half of 4F moved ahead of the
editor, because undo before audible, "latest wins" and the boundary order had to be
testable in Rust before any UI depended on them.

## Decisions

| Decision | Why |
|---|---|
| Whole-lane revisions, every touched lane in every revision (ADR-016) | Order-free "latest wins"; an undo is just another revision. |
| Pattern edits always use bar timing | "Edits apply at the next bar while playing"; Hear Bar is the explicit seek. |
| A scene captures only lanes the session touched | A scene captured on an unedited track still launches the mix only, as in Night 3. |
| Variation scope = the four-bar part on screen | Matches the brief's "Bars 9–12", and keeps the static catalog to 3,888 entries. |
| Melodic variation rhythm-only, said up front | No harmony data; guessing a key would be a substitution the brief forbids. |
| PHP generates; static build hash-matches (ADR-017) | ADR-001; never substitute a variation for different notes. |

## Found along the way

- **Boot-order bug (fixed):** `init` went through `post`, which flushes coalesced
  parameters first, so anything moved before the first Play (a pattern edit, a
  fader) reached the worklet before `init` and the track loads. It was dropped or
  refused as stale. Found by verify-editor's "an edit made before the first Play is
  in the music".
- **SceneStrip focus steal (fixed in 4A):** the menu's focus effect depended on an
  `onClose` whose identity changed every render.
- Beat-start cells hid hit fills (CSS specificity). Fixed before the first screenshot
  review.

## Gates

| Gate | Result |
|---|---|
| `cargo test --release` | 251 pass (17 new pattern tests, 1 contract) |
| `cargo clippy -D warnings`, `cargo fmt --check` | clean |
| PHPUnit | 240 pass (22 new variation tests) |
| `check:contract`, `check:scenes`, `check:editing` | pass |
| `verify:ui` | pass (3/3 after the 4A fixes; 1 run after the editor landed) |
| `verify:editor` | pass (3/3) |
| `verify:audio` | pass, including the two pattern-edit checks |
| `verify:static` | pass, including the catalog and "unavailable" |

## Skipped or deferred

See the Night 4 entries in `PARKING_LOT.md` and "Not done" under Night 4 in
`docs/ROADMAP.md`.

# Night 7 session log: timed builds (engine + worklet plumbing)

Branch `night7/timed-build`, worktree `~/ai-repo/bckgrnd-night7-build`, from main at
`16bb059`, 11-17-2026. Protocol: `docs/NIGHT7_PROTOCOL.md`. No UI, PHP or track
changes; Dara writes the ADR.

## Decisions

| Decision | Why |
|---|---|
| `queue_build(id, bars, target, land) -> u8`, `cancel_build(id) -> bool`, `base_into` | One request holds both vectors, so one cancel withdraws both. An empty `land` means no landing, so there's no Option across the wasm ABI. |
| Always starts on the next bar line, no timing code | A build that starts off the bar ends off the bar, and the landing would miss the downbeat. |
| Linear per onset, in each control's own space | The filter knob is already exponential in Hz, so a straight line in knob space is an even rise in octaves. ADR-013 glides fill in between onsets. |
| Unmute at the start (fader from 0), mute at the end (fader to 0), solo and echo time at the end | Every switch happens where the stem is silent, or at the boundary. |
| A scene that commits over a build replaces it, with no restore | Latest wins. The scene is complete, so nothing half-built remains, and cancelling the scene before it lands leaves the build running. |
| A build replaces a pending scene and a waiting or running build | Latest wins. A running build hands over where it got to, and a cancel still goes back to before both. |
| A control moved during a build is taken out of it | Otherwise the next onset fights the user's hand. |
| The base during a build is the interpolated value | A released gesture lands on what is playing, and capture reads that. |

## Gates

| Gate | Result |
|---|---|
| `cargo fmt --check`, `cargo clippy --all-targets -D warnings` | clean |
| `cargo test --release` | 277 pass (259 before, 18 new in `build_tests.rs`, none changed) |
| wasm size | 231,072 → 239,321 bytes (+8,249) |
| render timing, 60 s of Warehouse | 1268–1281 ms before, 1260–1270 ms after |
| `pnpm run typecheck`, `pnpm run build:netlify` | pass |
| `verify:desktop` | pass, 9/9 steps (498 ok), including the two new build checks in `verify-audio`. The first run failed one editor check ("velocity: held arrow is one undoable gesture") while another session's heavy job held the machine. It passed 3/3 standalone (73/73), then the full suite passed. Keyboard-repeat timing under load; no editor code changed. |
| `verify:web` | pass, 7/7 steps (142 ok) |

# Night 7 session log: the Rise button (timed builds in the UI)

Branch `night7/build-ui`, worktree `~/ai-repo/bckgrnd-night7-buildui`, from
`night7/timed-build` (`2028030`) with `night7/density` merged in (parking-lot sections
both kept), 11-17-2026. Protocol: `docs/NIGHT7_PROTOCOL.md`, "The UI: Rise".

## Decisions

| Decision | Why |
|---|---|
| A fourth **Switch on** choice, Rise, plus 2 · 4 · 8 bars, instead of a separate Build pad | You pick the scene to rise into with the pad you'd press anyway, and Shift+1–4 work unchanged. |
| Called Rise in the UI, build in code and protocol | One factory scene is already called Build. |
| A build is a `SceneRequest` with `build: {bars, bar}` | Cancel, the other pads, Compare A/B and the status line already handle a pending request. |
| The worklet streams `buildBase` (~30 Hz, plus a final one before applied or cancelled) | The knobs move with the rise, and capture, Compare and Save read the moving mix. |
| A control the user moves during a rise is theirs, on screen as in the engine | The host sees a value it didn't show and stops moving it. A snapshot React hasn't rendered yet doesn't count. |
| `buildShownId` kept apart from `buildPendingId` in the worklet | Stop, panic and the host cancel clear the pending id before `build cancelled` is drained, so the knobs didn't glide back (caught by verify-ui). |
| Stopped: a Rise press only says to press Play | The engine refuses it (reason 7) anyway. |

## Gates

| Gate | Result |
|---|---|
| `check-scenes` | pass, 12 new build checks |
| `pnpm run typecheck` | pass |
| `pnpm run build:netlify` | pass (engine unchanged) |
| `verify:web` | pass, 7/7 steps (153 ok) |
| `verify:desktop` | pass, 9/9 steps (523 ok), with 14 new Rise checks in `verify-ui` |
| 1440 × 900 scene toolbar | 74 px with Rise off and with Rise on (no growth) |
| 1280 × 800 | +38 px while Rise is on (parked) |
| 390 phone | Switch on uses Beat / Bar short labels; the bars row adds 56 px while Rise is on |

# Night 8 session log: stabilize Night 7 (11-19-2026)

Branch `night8/stabilize`, worktree `~/ai-repo/bckgrnd-night8`, from main `fdfcdf8`
(PRs #5–#9 merged). Three agents worked in their own worktrees and branches, merged
here without conflicts: `night8/staging` (Silas), `night8/responsive` (Lacey),
`night8/rise-tests` (Tara). Phase 5–6 docs written here.

## Baseline

`main` at `fdfcdf8`: `build:netlify`, `verify:web` and `verify:desktop` all pass (682 ok).

## What changed

| Area | Change | Commit |
|---|---|---|
| Engine | Linked lanes wait in a `staged` slot until their scene or build is accepted; a refusal withdraws only its own lanes | `2e29170` |
| Engine tests | `staging_tests.rs` (refuse, replace, cancel, interrupt); Rise gaps: cancel at half for 2/4/8 bars, tempo change, `end_score`, lanes at 2/4/8 | `2e29170`, `6bf6852` |
| Host | A track load mid-Rise restores the effect knobs from the engine's last base; a re-announced Rise moves its bar | `56c5fc2` |
| Host/UI tests | `verify-ui-rise.mjs`: bar counts, cancel, ownership, lanes, Stop/seek/Panic/load, tempo, not playing, loop; `check-scenes` 36 → 52 | `2e42e6e` |
| Layout | 1180–1279 mouse tier, inspector fits 1280×800 and 1024×768, 1366×640 drawer, Output fold remembered | `ccf3ece` |
| Layout tests | Viewport checks for all of the above, plus 375 px no sideways scroll and 44 px targets | `11b4944` |
| Docs | `docs/releases/RC_MANUAL_CHECKLIST_11-19-2026.md`, `docs/NIGHT8_SPEC.md` | `fa682c9`, `566d477` |

## Decisions

| Decision | Why |
|---|---|
| Three lane slots (`staged`, `scene_lanes`, `build_lanes`) moved by value | Accept-then-claim makes staging transactional with no allocation on the audio path |
| No DSP change for slow Rise | Measured a staircase at 70 bpm (up to 141 ms flat per 16th); Chris listens first |
| Output fold saved like the knob-drag preference | Same localStorage pattern as `knobPrefs.tsx`; default folded |
| Knob-drag preference moved into the inspector tab row | Recovers the height that let 1024×768 fit, knobs stay 48 px |

## Gates (integrated branch)

| Gate | Result |
|---|---|
| `cargo fmt --check`, `clippy --all-targets -D warnings` | clean |
| `cargo test --release` | 292 pass, 1 ignored (filter-step measurement) |
| wasm | 240,185 → 240,448 B (+263) |
| bench (same run) | build +0.3%, lanes +0.4% vs plain |
| typecheck, lint, check:scenes | pass (lint: the 5 known hook warnings) |
| `verify:web` | pass |
| `verify:desktop` | pass, 10/10 steps |

Agents' runs: Silas's first `verify:desktop` failed the known "held arrow" editor flake
under load, then passed 10/10; Lacey's first run failed 4 of her own new checks (hidden
Output knobs counted), fixed in `11b4944`.

## Not done here (needs Chris)

Listening (Rise at 70–140 bpm, filter stepping, live vs WAV), the Linux candidate rebuild
and .deb checks, MCP resync before rc.2, and the 7 open questions in `NIGHT8_SPEC.md`.

# Night 8 session log: transitions (11-19-2026)

Branch `night8/transitions`, worktree `~/ai-repo/bckgrnd-night8-fills`, from main
`393bed4` (PR #10, the stabilize pass). Built to `docs/NIGHT8_DECISIONS.md` in Chris's
priority order. Branches merged in: `night8/adrs` (Dara), `night8/fill-ui`,
`night8/crash-v4` (Vivek), `night8/layout2` (Lacey). Engine by Silas on this branch.

## What changed

| Area | Change |
|---|---|
| Engine | `queue_fill_at` (phrase 2/4/8/16, late press rolls to the next phrase, loop wrap counts); `queue_fill_into` (fill + scene, atomic); `queue_build_with` (Rise + Fill); accent on scene/Fill into/Rise; events 51–53, reason 11. `docs/NIGHT8_PROTOCOL.md` |
| UI | Fill at (Next bar · Phrase end) + phrase bars; Fill → Drop beside Fill; Finish with Fill on Rise; prefs saved (Rise bars now saved too) |
| Project | Version 4: required boolean `crash` per scene; v1–v3 files and v3 snapshots migrate on read; originals untouched until Save; `.bak` keeps v3 |
| Crash | "Crash on launch" in each pad's menu, bolt + "Crash ·" mark; one undo step; status "Drop active, with a crash" |
| Layout/a11y | Scene toolbar 108 px at every mouse width; pickers are radio groups, toggles are switches, fill buttons `aria-disabled` with reasons; phone targets ≥ 44 px |
| ADRs (draft) | 020 phrase fills, 021 linked atomic requests, 022 crash accent, 023 project v4 |

## Decisions made in the build (per Chris: decide by intent)

| Call | Why |
|---|---|
| v4 bump, field `crash` (boolean) | ADR-014 completeness; `accent` already names a note field |
| Fill → Drop over a queued plain Fill upgrades it | Forgiving, not refusing |
| Fill disabled while a Rise ends with a fill | One fill slot; say why instead of a silent refusal |
| Fill → Drop targets slot 4, named after it | Predictable; follows a rename |
| Crash available on every scene, off | Explicit; Chris said others don't *need* one, not that they can't |

## Gates (`night8/transitions` before layout; layout pass re-ran the app suites)

| Gate | Result |
|---|---|
| cargo fmt / clippy `--all-targets -D warnings` | clean |
| cargo test | 324 pass, 1 ignored |
| wasm | 240,448 → 246,024 B (+5,576, +2.3%) |
| bench, same run | build +1.1%, lanes +1.3% vs plain; Fill into costs nothing measurable vs its Night 3 control |
| Existing renders | bit-identical to main (90 s parity render) |
| typecheck / lint / check:contract / check:scenes / phpunit | pass (lint: the same 5 warnings) |
| verify:web | pass, 8/8 |
| verify:desktop | pass, 10/10 (1,005 browser checks after the layout pass) |

## Waiting on Chris

Listening: Fill → Drop and Rise + Fill at 70/105/140 bpm, crash level alone and merged,
slow Rise stepping. ADRs 020–023 to accept. MCP resync + npm publish to ship with v4.
