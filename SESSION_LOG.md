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
| `verify:ui` | pass (3/3 after the 4A fixes) |
| `verify:editor` | pass (3/3) |
| `verify:audio` | pass, including the two pattern-edit checks |
| `verify:static` | pass, including the catalog and "unavailable" |

## Skipped or deferred

See the Night 4 entries in `PARKING_LOT.md` and "Not done" under Night 4 in
`docs/ROADMAP.md`.
