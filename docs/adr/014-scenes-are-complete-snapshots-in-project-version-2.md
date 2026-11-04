# ADR-014: Scenes are complete snapshots, stored in project version 2
Date: 2026-11-04   Status: draft

## Context
Night 3 adds four scene slots (Full, Sparse, Build, Drop) that a project has to keep.
The v1 schema (ADR-012) has `additionalProperties: false` at the top and `patterns`
capped at `maxProperties: 0`, so a `scenes` key in a v1 file is either dropped or
rejected by whichever reader sees it. Night 4 adds pattern references to scenes, so
the shape has to leave room for them without guessing at them now.

## Decision
Scenes live in an explicit `version: 2` with a v1 → v2 migration that adds the four
factory scenes for the project's track and changes nothing else. Exactly four slots,
`full`, `sparse`, `build`, `drop`, in that order. Each scene is complete on disk: all
eight stems' `volume`, `send`, `muted`, `solo` and the twelve `fx.*` in `sceneVector`,
resolved against the registry at capture, not at read. Any malformed scene (unknown
key, wrong type, out of range, wrong slot set, any `patterns` key) rejects the whole
document's scenes and never touches the working mix. The active scene is session
state, never saved, and migration never applies a scene. Factory recipes in
`contracts/scenes.json` are relative to the track's own mix (`scale`, `cut`); PHP
`Contract::factoryScenes()` and TS `factoryScenes()` build them identically, and
`tools/check-contract.mjs` holds them to the same fixtures. A scene leaves out tempo,
swing, master level, loop, playhead, deck and held gestures: those belong to the
performance or the transport, and a scene that moved them would jump the beat or the
loudness on launch.

## Consequences
+ A scene sounds the same wherever it is read: nothing is filled in from defaults
  that might change later.
+ Older projects open unchanged and nothing plays differently until a pad is pressed.
- A parameter added to `sceneVector` changes what "complete" means, so it needs a
  new project version, and both readers plus the fixtures move together again.
- Rejection is strict: one bad value in one slot refuses all four scenes in that
  document, with an error, rather than loading the three good ones.

## Alternatives rejected
- Slip `scenes` into v1: another v1 reader would silently drop or reject it.
- Store scenes as deltas from the working mix: what a scene sounds like would change
  every time the base changed.
- Use the two decks as scene slots: the decks are for handing over between tracks.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: complete
snapshots froze values that should have followed the track. A track was re-voiced in
PHP, its levels changed, and every saved scene kept the old levels, so a captured
Drop sounded wrong next to a fresh one.
Early warning sign to watch for: a request to "refresh my scenes from the track" or a
bug where a captured scene and Reset to Factory disagree on a stem nobody touched.
