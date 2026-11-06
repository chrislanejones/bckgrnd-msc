# Night 6 Linux release candidate — 2026-11-06

**In progress, not release signoff.** The authoritative results are in
[the protocol](../NIGHT6_PROTOCOL.md), [checklist](../RELEASE_CHECKLIST.md) and
[current native inventory](../NIGHT6_INVENTORY.md).

The November 5 work was preserved. Baseline app `296dc35102ec40252a01db37373c97fe39ae8041`
on local `master` tracking Codeberg `main`; MCP `e4b27a122b4e163190f520611878f83a08a313fd`
on `feat/beat-map`. MCP `.agents/`, `.playwright-mcp/`, `skills-lock.json` remain
unrelated and untouched. No destructive reset, cleanup or history rewrite.

This candidate adds the missing Night 5 persistence/export workflow, NativePHP
Desktop 2.4, a real provider/storage adapter, Linux packaging, a shared project
renderer and two project-aware MCP tools. It fixes reproduced audio/state defects
and preserves compact headings, the sound-selection/Edit patterns row, stable
editor dimensions and the expanded Cancel behavior. A/B remains session-only.

Fresh browser/static workflows and installed Linux native dialogs, saving,
shutdown/export cancellation and reopen pass. Cross-runtime edited/silent fixtures
produce matching events, frames and WAV bytes with controlled noise/encoding.
The installed executable runs with the checkout hidden and no developer PATH.
Native audio interruption and resume have signal tests; speaker listening remains
separate. The old NativePHP AppImage launcher was rejected because it added
`--no-sandbox`; tar/deb candidates preserve security. Automatic updates are off.

Production was checked explicitly and is older than the November 5 handoff: it
lacks Edit patterns and saving, has no build manifest, and serves the 222709-byte
WASM with SHA256 `3ed28bd6e288d4116e0d773d6d01bcebcffccde5fa7f7147afc661211d714b04`.
A push alone did not deploy that work. Final source/artifact IDs, client connection
and deployment results will be recorded after the clean candidate build.

Remaining gates: final frozen build/package recheck, actual T3 MCP tool call,
installed-app listening and physical device interruptions, production verification.
Windows/macOS and real phones are untested. Timing/pitch humanization, chord entry,
timed builds/fills, Drop + Crash, stutter, randomize mix and alternate mixer modes
are deferred with scope; none is represented as shipped.
