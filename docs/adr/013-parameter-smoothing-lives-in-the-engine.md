# ADR-013: Parameter smoothing lives in the engine, per parameter, and snaps on silence
Date: 2026-11-03   Status: draft

## Context
Every gain the user could move (fader, cut, solo, master, EQ, balance, echo throw)
switched in one sample, so each toggle put a step in the waveform: a click on the
app's main gesture (PARKING_LOT #1). Night 2 adds knobs that send dozens of values
per second, which makes steps more frequent, not less.

## Decision
Smoothing is the engine's job, not the UI's. Each parameter glides toward its target
with its own time constant (`dsp::Smoothed`): 12 ms for channel faders, cuts, solos
and sends; 15 ms for master and echo levels; 20 ms for balance and width; 20–30 ms
for EQ and filter, whose coefficients are recomputed at control rate (every 16
samples) and only while moving. A channel snaps straight to its target while its bus
is silent and on the first sample of sound after silence, so a stem cut before a note
starts is silent from that note's first sample. The UI only coalesces messages to one
per parameter per frame.

## Consequences
+ No avoidable clicks, tested at the worst moment (a waveform peak) in
  `engine-core/tests/smoothing.rs`, and the tests fail if the glides are removed.
+ The same behavior in every host (browser, NativePHP, MCP renders), because it is
  in the shared engine.
+ The filter is cheaper: no `powf`/`sin`/`cos` per sample.
- A cut is no longer instant: it reaches −60 dB about 80 ms after the message, which
  is audible as a very fast fade on a held pad if listened for.
- Tests that set a value and measured the next sample had to wait for the glide.

## Alternatives rejected
- Smoothing in the UI by sending ramps of values: messages arrive per block at best,
  so ramps would be stair steps, and the MCP host would get no smoothing at all.
- One time constant for everything: a 30 ms cut feels late, and a 12 ms filter sweep
  zips.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: a performance
feature (stutter, gated cuts on the beat) needed hard-edged gain changes, and the
glides softened them into mush.
Early warning sign to watch for: a request for a "gate" or "stutter" that sounds
smeared, which should get its own explicit, sample-accurate envelope rather than a
shorter global glide.
