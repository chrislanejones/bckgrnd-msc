# ADR-025: Beat Repeat is held-gesture kind 3, looping the five-channel pre-master feed on the division grid
Date: 2026-11-25   Status: draft

> Note 11-28-2026. Since Night 11 the engine also reports a repeat's start and end as
> events 61 and 62 (`507d209`), and a take records each repeat with its division, plus
> `initial.repeatDivision` (ADR-026 v2). That answers this pre-mortem for takes. A
> project still doesn't carry the division.

## Context
Night 10 adds a momentary stutter: hold a pad, and the deck repeats a 1/4, 1/8 or 1/16
slice until you let go. The held-gesture system (ADR-015, `NIGHT3_PROTOCOL.md` §
Gestures) already gives tokens, 3 s leases, Release FX and Panic. A stutter of the stereo
master would also chop the echo and reverb tails, and the stutter has to land back in time
when you let go. Spec: `docs/NIGHT10_PROTOCOL.md`.

## Decision
Beat Repeat is gesture kind 3 (`gesture::kind::BEAT_REPEAT`), with no subsystem of its
own. `engine-core/src/repeat.rs` sits after the stem sum and before the master chain,
and records five channels: the dry sum, the returns feed and the per-stem echo sends.
So the master filter (and Filter Hold), echo (and Echo Throw), reverb and limiter act on
the stutter, and the tails stay natural. It engages on the next grid line of its
division. The first slice plays live while it is recorded, then loops with the live
signal muted, and the transport and scheduler keep running underneath. Seams dip over
2.5 ms. Release is immediate: an 8 ms equal-power crossfade. Brake, backspin and scratch
end it. Cue, seek and loop wrap keep it looping. Event 21's `b` gains a meaning: 1 = the
engine ended it (a platter gesture), 0 = lease, as before. The division (default 1/8) is
a per-viewer localStorage preference (`bckgrnd-msc:repeat-division`) sent with
`set_repeat_division`. It is not in the scene vector, a scene or the project file. The
buffer is allocated at construction: a quarter note at 36 BPM at the engine's own rate.

## Consequences
+ No project format change and no new lifecycle: every existing release path (Release
  FX, Panic, Stop, track load, lease) already ends it.
+ True bypass when not engaged: 80/80 renders bit-identical to c57013d (44.1 and
  48 kHz, plain and Rise-heavy, 80/80 again with the division changed), and offline/MCP
  renders never begin a gesture.
- Memory: about 1.6 MB per engine at 48 kHz (6.4 MB at 192 kHz), two engines per
  worklet (ADR-003), held whether or not anyone ever presses Repeat. wasm grew
  245,282 → 250,311 bytes (+2.1%).
- A project doesn't record its division: the same project stutters differently on
  another viewer's machine, as with Fill Style (ADR-024).
- Event 21's `b` now carries a reason. Hosts that read it as always 0 would misreport
  a platter end as a lease timeout. Old hosts that ignore `b` keep working.

## Alternatives rejected
- A mix or scene parameter: it would be a project format change, for something you hold
  for two beats.
- Capturing only the stereo master: the echo and reverb tails would be stuttered too.
- Quantized release: momentary means immediate. Only the engage waits for the grid.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: recording and replay
(planned for Nights 12–13) needed Repeat as a recorded event, and a stutter whose
division lives in localStorage, outside every saved record, couldn't be replayed
faithfully. The division then had to move into an event or the format anyway. Or the
parked transport rounding (every step rounded up to a whole sample, about 0.02% slow at
123 BPM, 44.1 kHz) got fixed. Beat Repeat's slice math matches the clock as it is, so it
changes with it and the 80/80 bit-identical baseline is gone. A smaller risk: a tempo
change or bend while held keeps the old slice length and drifts off the grid until
release (parked).
Early warning sign to watch for: a recording/replay design that lists gestures as events
but leaves out the division, or a PR that touches `Transport::tick`'s `to_next`.
