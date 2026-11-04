# ADR-015: The engine schedules musical changes; gestures are overrides, not edits
Date: 2026-11-04   Status: draft

## Context
A scene launch changes up to 44 values (8 stems × 4 fields plus 12 effects) and has
to land on a beat or bar, before that step's notes sound. The UI thread can't hit a
step: timers jitter, background tabs are throttled, and a message lands per render
block at best. Held effects (Echo Throw, Filter Hold) also have to survive a scene
change underneath them without snapping the mix back when released.

## Decision
The UI sends musical intent: Now, Next Beat or Next Bar (the default for scenes). The
Rust engine validates the whole 44-value vector first, then commits it as one
transaction at the chosen onset: commit the scene, start the fill, then trigger that
step's notes; values glide with ADR-013's smoothing. Deadlines are counted on a
monotonic onset serial, not step numbers or milliseconds, so a looping bar can't fire
a request twice or early, and tempo changes move nothing. The queue holds one scene
and one fill; the latest valid request wins and reports `replaced`. Every request
ends in an explicit outcome, and only the engine's `applied` event marks a scene
active. The worklet drops requests whose deck generation is stale; stop, seek,
scratch and track change cancel what is pending. Held effects are tokened overrides
on top of the base: at most four, the most recent wins per parameter, each with a
3 s engine-side lease as a backup to the UI's release paths. Capture reads the base,
never an override.

## Consequences
+ Launches are sample-accurate and identical in every host, because the timing is
  in the shared engine.
+ Releasing a gesture exposes the base as it is now, so "hold filter, change scene,
  release" lands on the new scene.
- The engine carries a queue, an event ring and override slots: more state to test,
  and every transport path has to remember to cancel.
- The UI can't show "active" until the engine answers, so a pad waits on
  *Sending…* / *Queued · Bar N* until it is confirmed.

## Alternatives rejected
- Browser timers (`setTimeout`) sending the change on time: jitter and tab
  throttling, and a message can't arrive before the onset it targets.
- Eight-plus separate parameter messages: not atomic, so a block can render half a
  scene.
- Snapshot-and-restore for held effects: hold the filter, change scene, release, and
  the old scene's filter comes back.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the rules spread.
Each new transport action (a loop jump, a cue point, an MCP render) needed its own
cancel rule, one was missed, and a stale scene fired a bar after a seek.
Early warning sign to watch for: a transport command added to the worklet or engine
without a matching row in the protocol's cancellation table and a test that queues a
scene before it.
