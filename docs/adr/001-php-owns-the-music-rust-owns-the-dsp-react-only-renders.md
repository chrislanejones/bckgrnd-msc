# ADR-001: PHP owns the music, Rust/WASM owns all DSP, React only draws and sends intent
Date: 2026-10-02 (backfilled)   Status: accepted (10-05-2026)

## Context
The first version (`old/`, TanStack Start) ran sequencing, synthesis and UI in
one TypeScript app on Web Audio. The port to Rust + Laravel + NativePHP needed a
rule for which language owns what, or the three would each grow a copy of the
song state. Rationale is from HANDOFF.md and the README, written at the port.

## Decision
`app/Support/Music/` (PHP) owns the song: the 16-bar form, note grid, swing,
tempo and stem mix, served as arranged JSON. `engine-core/` (Rust, compiled to
wasm) owns every oscillator, envelope, filter, drum and the master bus, and
runs inside an `AudioWorklet`; it only renders events it is handed and never
decides a note sequence. `frontend/` (React) draws meters and sends intent; it
holds no `AudioContext` and no audio state.

## Consequences
+ Sample-accurate timing with no main-thread scheduling jitter, and no
  `ScriptProcessorNode`.
+ The arrangement is testable on its own (`tools/check-arrangement.php`,
  `tools/compare-with-original.php`) without booting audio.
- A track change touches up to three languages, and the JSON shape between
  them is a contract with no shared types (the `perc` lanes in ca0e693 had to
  be added to Rust serde, PHP `Track` and the exporter by hand).
- Errors inside the worklet's `process()` are swallowed by the browser, so the
  app needs its own error channel (`EngineHost.onError`, `runSafely`).

## Alternatives rejected
- Keep everything in TypeScript on Web Audio (`old/`): the UI thread competes
  with the audio graph, which is the reason the engine moved to Rust.
- Run the DSP in a `ScriptProcessorNode`: deprecated, main-thread, not
  sample-accurate.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the line
leaked. A UI feature (scratch, the jog wheel, transitions) needed timing the
JSON did not carry, so musical decisions crept into the engine or the worklet,
and PHP no longer describes what plays.
Early warning sign to watch for: the engine reading song structure it was not
handed (hardcoded step numbers like 128/192 in `engine-core/` multiplying
beyond `transition.rs`).
