# ADR-019: Timed builds are engine requests that move the base over 2, 4 or 8 bars
Date: 2026-11-17   Status: draft

## Context
A Build should rise over several bars, not land on one boundary like a scene. That
is up to 44 values moving on every sixteenth for as long as 128 onsets, and the UI
thread can't time even one step (ADR-015). A build also has to be cancellable without
leaving a half-built mix, and it has to live alongside scenes, fills and held
gestures.

## Decision
One engine request, `queue_build(id, bars, target, land)`, carries a target vector and
an optional landing scene, over 2, 4 or 8 bars, both validated like a scene before
anything changes (refused while stopped or mid scratch, brake or backspin). It always
starts on the next bar line on the onset serial and ends exactly `bars × 16` onsets
later. On each onset it moves the base in a straight line in each knob's own scale
(the filter position is already exponential in Hz), and ADR-013's smoothing glides
between onsets. Unmutes happen on the start onset with the fader at 0. Mutes fade out
and switch at the end, and solo and echo time switch at the end. On the end onset it
writes the target exactly and commits the landing scene whole, after a scene due there
and before the fill and that step's notes. A cancel (user, stop, end of score, cue,
seek, scratch, brake, backspin, Play while playing, track load, panic, host
`cancel_pending`) puts back the starting base. Latest wins: a scene that commits over
a build replaces it, with no restore. A new build replaces a pending scene or build. A
replaced running build holds where it got to, and cancelling its replacement restores
the base from before both. Gestures stay overrides on the moving base, and `base_into`
returns the base for capture. A control the user moves during a build leaves the
build, and a cancel doesn't take it back. Events 41–47 (queued, applied, cancelled,
replaced, rejected, started, progress) give each build exactly one terminal outcome.

## Consequences
+ Sample-accurate and identical in every host (browser, NativePHP, MCP), because it is
  in the shared engine.
+ One terminal outcome per build, and no partial state after a cancel.
- Every effect setter now writes a base mirror (`fx_base`), every base setter marks
  user ownership, and `interrupt` must cancel the build: ADR-015's spreading rules gain
  a row. +8,249 bytes of wasm (231,072 → 239,321, +3.6%).
- Stepping once per sixteenth may be audible on a deep filter build at slow tempos
  (parked). A landing scene can't carry pattern lanes yet (ADR-014's `patterns`).
- Not wired to the UI yet: nothing calls `queueBuild`, and the UI's scene capture
  reads its own working mix, not `base_into`.

## Alternatives rejected
- Host-side ramps: jitter, one message per block at best, and the MCP and other hosts
  would get no build at all.
- Starting on Now or Next Beat: a build that starts off the bar ends off it, and the
  landing misses the downbeat.
- Per-bar updates: audible stair steps. Per-sample interpolation: more code for
  little audible gain.
- A scene queued during a build cancels it at once: the mix would snap back for up to
  a bar before the scene lands.
- A base sent by the host: it can be stale by the time the build starts.
- Boxing the build state: +795 bytes of wasm over keeping it inline.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the ownership rules
leaked. A new base setter skipped `touch`, so a build kept driving a knob the user had
taken, or a cancel snapped it back. Or a new transport path skipped `interrupt`, and a
build kept rising (or restored) a bar after a seek.
Early warning sign to watch for: a transport command or base setter added to the
engine without a build cancel or a user-ownership mark, and no test in
`build_tests.rs` that runs a build across it.
