# ADR-008: Transition sounds sit outside the stems and fire only on a natural crossing
Date: 2026-10-05 (backfilled)   Status: accepted (10-05-2026)

## Context
The song is 256 steps in four 4-bar parts, and the `[ ]` brackets on the
waveform named them, but nothing in the sound marked the Break or the Drop. The
engine already summed one non-stem sound straight into the master: the
backspin take, after it was found routed through the Arp strip (e6fcd0d).

## Decision
`engine-core/src/transition.rs` synthesizes a noise riser into the Drop, a crash
on its downbeat and a downsweep into the Break, summed into the master outside
the stem strips: the tape filter, EQ, echo throw and limiter act on them, no
stem fader, cut or solo does. They fire only on a contiguous crossing (the step
before the seam, then the seam, in ordinary playback). Jumps, cue, scratch
release and a loop that only wraps back to a boundary do not count.

## Consequences
+ The song form is audible whatever the user has cut, and needs no 9th stem.
+ A 1-bar loop on the Drop does not crash every bar; a loop on the Break
  never rises toward a Drop that will not come.
- Cutting every stem no longer means silence at the seams; `stem_coverage`
  had to stop at step 127 for its fader-at-zero check.
- The engine now knows the song form (steps 128 and 192 are constants
  there), which bends ADR-001's line that only PHP knows the music.
- +9,270 bytes of wasm; the browser gate cannot jump the playhead, so only
  Rust tests reach the seams.

## Alternatives rejected
- A 9th stem for FX: the eight-stem shape is load-bearing (ADR-009).
- Fire on any arrival at the step: re-crashes on every loop pass and plays
  risers that never pay off.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: a track
with a different form (longer Break, no Drop) needed the seams moved, and the
constants in `transition.rs` became a second, unannounced song form.
Early warning sign to watch for: an arrangement in `Arranger.php` that does not
put the Break at 128 and the Drop at 192.
