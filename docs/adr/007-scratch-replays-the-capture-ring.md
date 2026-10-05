# ADR-007: A scratch replays the engine's own recent output from a frozen capture ring
Date: 2026-10-05 (backfilled)   Status: accepted (10-05-2026)

## Context
The waveform was to work like a platter: grab it and drag. But the engine
synthesizes from a step sequence, so there is no recording to drag backward.
The engine already kept a ring of its recent output for the backspin.

## Decision
`scratch_start()` freezes the output ring (grown from 2 s to 4 s) and holds the
transport where it is (`Transport::held`: `is_playing` stays true, the step
does not advance). A new reader, `engine-core/src/scratch.rs`, plays the frozen
window at a pointer-driven rate, summed into the master outside the stem
strips. `scratch_end(step)` fades it out and drops the needle at `step`;
`scratch_release()` lets go without moving the playhead, and a mix calls it on
the outgoing deck before timing the handover (0b8fedd).

## Consequences
+ Scratching sounds like the track, forward and backward, with no
  allocation on the audio path and no measurable idle cost.
+ The same ring serves the backspin; one capture, two gestures.
- You can only scratch the last ~4 s that were actually played. Grab right
  after a load or a jump and the window is short; you cannot scratch ahead.
- A held transport is a new state every timing path has to respect: the mix
  downbeat bug in 0b8fedd came from code counting forward under a frozen
  clock.
- +2,728 bytes of wasm, and the ring doubled to 4 s per deck (each deck's
  engine keeps its own).

## Alternatives rejected
- Re-render the step sequence at a signed rate: voices are synthesized
  forward from note-ons, so there is no backward render to ask for
  (rationale reconstructed from the `scratch.rs` header).

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the held
state kept finding new timing paths (loops, transitions, continuous mix) that
assumed the clock moves, each one a small "jumps the wrong track" bug.
Early warning sign to watch for: another `fix:` commit that adds a
`scratch_release` call or a `held` check to a path that is not the scratch.
