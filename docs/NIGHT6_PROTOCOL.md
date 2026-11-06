# Night 6 — release evidence

Status: in progress; **not a release signoff**. Night 5 persistence/export was
absent at baseline. Packaging and publication depend on that gate passing first.

## Baseline, 2026-11-06

- App: `296dc35102ec40252a01db37373c97fe39ae8041`, clean `master`, tracking
  `codeberg/main`; GitHub `origin` and Codeberg both publish `main`.
- MCP: `e4b27a122b4e163190f520611878f83a08a313fd`, `feat/beat-map`, tracking
  `origin/feat/beat-map`. Its eight existing tools include the newer beat-map tool.
  Untracked `.agents/`, `.playwright-mcp/`, `skills-lock.json` are unrelated and
  must remain untouched. No reset, cleanup, or history rewrite was used.
- PHP 8.4.26; Composer 2.10.3; Node 24.21.0; pnpm 10.26.0;
  Rust 1.98.1; wasm-pack 0.15.0. wasm-opt available.
- App pnpm lock SHA256: `a91b3f834b67b3603774330ec2de392935366308f46b5a6e8daff6b75e29ed11`.
- Composer lock SHA256: `d27ce74dea7e14850033b7360bd6b6ab0e50880624565e2ab4abf21d59f8d68d`.
- Cargo lock SHA256: `635811d19f56434edf2dece26e09bd76638635d9fd65c219980fa072b9f6ef20`.
- MCP pnpm lock SHA256: `565327c7c1f7c42e034818957b6833961fcff3331083f843a702149b4643cd0d`.
- Baseline WASM SHA256: `071ed0ad0f23a7ccd7589c63d51641fe1666ce04e929c7b22b1d18a26c73270d`.
- Fresh baseline: app TypeScript, contracts, scenes, editing, PHP (240 tests,
  5816 assertions) pass. MCP typecheck, lint, 56 tests, packed installation pass.
  Full logs collected at `/tmp/bckgrnd-night6-baseline/` during this run.

The November 5 handoff is authoritative for the compact headings, sound-selection
row, stable editor dimensions and Cancel behavior. Its pushes are not deployment
evidence. October results remain historical regression information.

## Acceptance gates

1. Browser: edit drums/bass/effects, capture, save, reopen stopped, export WAV.
2. Full → Drop → Cancel → Save → reopen restores the original mix and all replaced
   lanes. Active and queued requests cannot land later; A/B survives in-session,
   and exiting comparison cannot revive the cancelled scene.
3. Failed writes preserve memory and the previous committed revision; recovery is
   offered explicitly. Imports retain their original document. Preview candidates,
   held gestures and playback state never enter a saved snapshot.
4. Open/New/Import wait for crossfade completion. Every asynchronous write/export
   owns an immutable named project revision. Track selection starts a new identity.
5. One shared resolver/renderer, with dependency hashes, drives browser/native/MCP.
   Scenes remain alternatives. Explicit empty lanes remain empty. Kick tuning stays
   tied to the source root, independent of bass edits.
6. Native package: offline assets, persistent application storage, native dialogs,
   safe shutdown, compatible PHP, sandbox/context isolation, installed audio probe.
7. MCP: clean packed install, old tools, project validation/render/narration, actual
   client launch, missing dependency error. No local failure uploads anything.
8. Final RC records commits, hashes, platform results, deployment identity and
   rollback. Speaker listening and real phone tests are separate from signal tests.

## Scope

Compare A/B is session-only; capture it explicitly to preserve it. Deferred with
scope: timing humanization, pitch variation, chord entry, timed builds,
phrase-ending fills, Drop + Crash, stutter, randomize mix, alternate mixer modes.
Existing rhythm-only/static/read-only limitations remain visible.

Linux is the selected first packaging target; T3 Code is the selected MCP client. Windows, macOS, iOS, Android,
actual output-device listening, and production deployment are unverified until
evidence is recorded here. An unsigned test artifact is not a signed release.

## Candidate implementation and fresh evidence

Night 5 was absent at baseline; this change adds snapshot v1 around musical
project v3, shared migration/validation, revision-aware saves, recoverable atomic
writes, unified undo and immutable WAV exports. IndexedDB serves both browser
builds; NativePHP supplies the same storage interface in application data.

| Environment | Evidence collected during this session |
|---|---|
| Laravel browser | `verify-projects`: edited drums/bass, scene capture, Full → Drop → Cancel → Save, stopped reopen, failed save, export cancellation, legacy import, preview exclusion and explicit recovery pass |
| Static | Independent `dist` build; `verify-static` and the same project workflow pass; no accidental API calls |
| Installed Linux | `verify-native`: native import/cancel/Save As/export, failed-save close, keep-open/cancel-export quit and persistent stopped reopen pass. Checkout hidden using a mount namespace; requests restricted to installed loopback origin; PATH excludes developer tools |
| Audio | Rust targeted regressions and worklet gate pass. `verify-transitions` advances normally through Break and Drop, with no seek. Simulated interruption/failed/successful resume passes in browser and installed app |
| Cross-runtime | Edited and silent fixtures produce identical resolved events, 108000 frames and byte-identical PCM WAV in actual browser/native export workers and MCP, at 48 kHz with controlled settings and fresh WASM noise state |
| MCP clean package | Ten tools, contracts/fixtures/shared assets, saved-project validation/render/narration, old workflows and diagnostics pass outside either repository with restricted PATH and a Unicode/space path |
| T3 client | Configuration/discovery/tool execution is a separate gate; an SDK test does not certify it |
| Production baseline | Real browser check finds no pattern editor, stale saving placeholder, no build manifest (404); app script query `mw2472ai`. Production engine SHA256 `3ed28bd6e288d4116e0d773d6d01bcebcffccde5fa7f7147afc661211d714b04`, 222709 bytes. November 5 pushes did not update this deployment |
| Other targets | Windows/macOS and actual iOS/Android devices untested |

Logs are collected under `/tmp/bckgrnd-*.log` during development. Durable final
source/artifact identities and result copies belong in the release evidence and
handoff; temporary logs alone are not a release record.

## Defect disposition

ADSR release timing, sample-rate-dependent kick click, double-offset clap tail,
unreachable deep-clap decay and brake floor were reproduced with failing tests
before fixes. Solo returns now reject excluded stems while their dry gain glides.
The resolved sounding pattern revision drives waveforms/activity. Unified history,
velocity-key coalescing, available-after-mix feedback and both scene/fill outcomes
are covered by current regression checks.

Filter Q, delay damping, hat attack and saturation order are retained sound
differences. Speaker approval is not inferred from signal tests. Reverb-decay
feedback still changes immediately at a scene boundary: known limitation.
Kick sub remains tied to the original source root. Deprecated `set_echo(bool)`
compatibility remains because worklet reset/promotion and direct engine/audio
fixtures still consume it. No engine change is allowed after the final MCP freeze
without rebuilding and rerunning both sides.

## Packaging and security

The Linux artifact is an unsigned candidate, not a signed distribution. It bundles
PHP 8.4.27, Electron 40.10.6, app/worklet/WASM, library, contracts and shared renderer.
The Desktop 2.4 patch keeps sandbox/context isolation/web security and a narrow
validated preload. Native file actions validate a token/origin and use chooser
paths. Quit waits for renderer save/cancel decisions before PHP shutdown. Updater
is disabled. The tar installer keeps prior versions and data. AppImage was rejected
because the generated launcher disabled the sandbox.

## Remaining manual or external evidence

Actual speaker listening (including solo/Filter Hold), physical sleep/resume and
output-device changes remain unverified. This WSL test used a temporary native
file-chooser portal. The actual T3 session must call validation, render and narration
with the installed package. Production publication needs the intended build ID,
fresh/cached-client checks and preserved rollback artifacts. Do not mark Night 6
complete while any of those required gates remains open.
