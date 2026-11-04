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
| fill data (this commit) | PHPUnit 204 pass; check-arrangement 18 tracks pass; parity 165 pass; check:contract pass |

## Order deviations

| What | Spec said | Did | Why |
|---|---|---|---|
| Fill recipes (PHP data + export) | Commit 5 | Committed after commit 1, as data only | Nothing plays them until the engine's fill lands; shipping the data early lets Silas test against real recipes. |

## Skipped or deferred

(filled in as it happens)
