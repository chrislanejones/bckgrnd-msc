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
| UI commit (scene strip, compare, fill, held effects, panic) | PHPUnit 204, check:contract, check:scenes 25/25, typecheck, verify:ui pass, verify:audio pass (room check reworked + new all-cut check) |

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
| Before the first Play there is no worklet, so a scene picked while stopped waited forever ("Sending…") | UI applies it through the parameter path when `!engine.booted`; Silas adds the getter |
| At boot EngineHost replayed parameters *before* the held track load, and `load_track` resets faders, sends and tempo, so anything moved before the first Play was lost (pre-existing) | Silas swapping the order (held messages first, then parameters) |
| Reverb decay changes instantly on a scene change (`set_rt60`), not with the ADR-013 glide | Parking lot |
| "Stem groups" (Full mix / No drums / No music) also sets cuts, next to the new Full scene | Left alone, flagged to Chris |
| Capturing B left A marked "Listening" although B is what plays after its capture | Fixed: each capture marks that slot as the one heard |
| Held effect during an auto-mix would apply to the outgoing deck and go stale | UI refuses held effects while mixing and releases them when a mix starts |
| Panic mid-mix sends no mixEnd | UI resets its own mix state on Panic |

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

## Skipped or deferred

(filled in as it happens)
