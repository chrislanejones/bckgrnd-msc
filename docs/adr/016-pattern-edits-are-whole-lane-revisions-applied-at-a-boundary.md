# ADR-016: Pattern edits are whole-lane revisions, swapped in by the engine at a bar boundary
Date: 2026-11-04   Status: draft

## Context
Night 4 makes the arrangement editable while it plays. React must not become a
second sequencer (ADR-001), an edit must never jump the playhead or land mid-bar,
and `process()` must not allocate. Undo has to be exact, and it has to work while
playing, before Night 5's project-wide history exists.

## Decision
A project (v3) overrides whole lanes: an absent lane is the factory lane, an empty one
is silence. Each accepted edit becomes a revision holding every lane the session has
touched, compiled to a flat payload, validated whole in the worklet's message
handler, and swapped in with `mem::swap` at the next bar (immediately while
stopped). Order at the boundary: edit, scene with its linked lanes, fill, triggers.
Undo is one entry per gesture of lanes before/after; an undo is just another
revision.

## Consequences
+ "Latest wins" is exact and order-free: no revision depends on an earlier one landing; undo before audible simply replaces the pending one.
+ No allocation or freeing on the audio path; a refused payload changes nothing.
- A revision re-sends whole lanes (≤ ~3 k floats per drum lane), not a delta; fine at edit rates, wasteful if automated at audio rates.
- Pattern undo is its own stack until Night 5 merges history; mix edits are not undone by it.

## Alternatives rejected
- Event deltas applied in the engine: order-dependent, and a lost or refused delta leaves the engine and the screen disagreeing.
- Rebuilding the arrangement in PHP on every edit: a network round-trip per paint stroke, and no edit while the API is absent (static build).

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: editing grew
past whole lanes (per-step automation, longer songs, live recording), and resending
every touched lane on every change made dense edits laggy or bloated the queue.
Early warning sign to watch for: `patterns` messages coalescing away more than one in
three while a user paints, or payloads above ~20 kB.
