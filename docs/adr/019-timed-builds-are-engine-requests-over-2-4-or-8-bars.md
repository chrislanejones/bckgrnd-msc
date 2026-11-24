# ADR-019: Timed builds are engine requests that move the base over 2, 4 or 8 bars
Date: 2026-11-17   Status: draft

> Amendment proposed 11-19-2026. ADR-021 (draft) would let a Rise finish with a fill, queued and canceled with the build. Since `2e29170`, linked lanes wait in their own `staged` slot until their request is accepted. The Lanes paragraph below predates that.

> Amendment proposed 11-24-2026 (`49f896b`). A Rise's record is its own, not the one `SceneRequest` shared with a launch (ADR-015's request book), so it survives a scene queued over it and withdrawn. Following a Rise writes the store's, the target scene's or the starting mix's own value wherever the engine's float32 equals it, never the float32 copy: Echo time 1/8T read back as 0.3333333432674408 and a project saved after the Rise wouldn't reopen.

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

Lanes: `queue_build` also takes the lanes staged just before it with
`queue_patterns(…, link = build id, …)`, moving them from the scene's staging slot
(`linked`) into the build's own (`build_lanes`). They commit on the end onset, after
the landing scene and before that step's notes. Refused or cancelled, the build's lanes
are withdrawn with the same reason; replaced, with reason 10. Withdrawn on the audio
path, they are parked until the next pattern or build message, so `process()` doesn't
allocate or free. `build rejected` gains part 4 (lanes), reported by the worklet.

UI: it is called **Rise** (a factory scene is already called Build): a fourth Switch
on choice with a 2 · 4 · 8 bars picker, on the same `SceneRequest` record as a scene
launch. The worklet streams a `buildBase` message (~30 Hz, plus a final one before
applied or cancelled), so the knobs follow the build and capture reads the moving mix.
A control the user moves mid-build stays theirs on screen as well as in the engine.

## Consequences
+ Sample-accurate and identical in every host (browser, NativePHP, MCP), because it is
  in the shared engine.
+ One terminal outcome per build, and no partial state after a cancel.
+ A `cargo bench --bench render` harness (no new dependency) now times it: a build,
  with or without lanes, adds about 11 ms to a 60 s render (~1.3 s) over plain playback.
- Every effect setter now writes a base mirror (`fx_base`), every base setter marks
  user ownership, and `interrupt` must cancel the build: ADR-015's spreading rules gain
  a row. +9,113 bytes of wasm in all: 231,072 → 239,321 for the build, then
  → 240,185 (+864) for its lanes.
- A third lane slot (`build_lanes`) and a parked slot, and every path that ends a build
  must withdraw its lanes.
- Stepping once per sixteenth may be audible on a deep filter build at slow tempos
  (parked).

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
- One staging slot for scenes and builds: a scene queued during a build would take
  the build's lanes.
- Staging the lanes after the build: a refused payload would leave an accepted build
  without its lanes.
- A separate Build pad: a Switch on mode reuses the four pads, Cancel and Compare A/B.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the ownership rules
leaked. A new base setter skipped `touch`, so a build kept driving a knob the user had
taken, or a cancel snapped it back. Or a new transport path skipped `interrupt`, and a
build kept rising (or restored) a bar after a seek.
Early warning sign to watch for: a transport command or base setter added to the
engine without a build cancel or a user-ownership mark, and no test in
`build_tests.rs` that runs a build across it. Or a new code path that ends a build
without going through `cancel_build_for` or `replace_build`: its lanes would never get
a final 31–35 event.
