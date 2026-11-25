# Night 10 protocol: Beat Repeat

An addendum to `NIGHT3_PROTOCOL.md` § Gestures. Beat Repeat is a third held-gesture
kind on the same token, lease and release machinery. Nothing here changes the scene
vector, the project file or any saved data.

## Gesture kind 3: Beat Repeat

| | |
|---|---|
| Begin | `gesture_begin(token, 3)`; worklet `{ type: 'gestureBegin', token, kind: 3 }` |
| End | `gesture_end(token)`, Release FX (`release_gestures`), Panic, Stop, a track load, end of score |
| Lease | 3 s of rendered audio, like kinds 1 and 2; renew while held |
| Engine-ended | a brake, backspin or scratch ends it, reported as `gesture expired` (21) with `a` = 3 and `b` = 1 |

Event 21's `b` field is now the reason: 0 means the lease ran out (unchanged for kinds 1
and 2), and 1 means a platter gesture took the deck. Hosts that ignore `b` keep working.

Two tokens of kind 3 can be held at once. The stutter runs while either is held, as
with the other kinds.

## Division

`set_repeat_division(d) -> bool`, where `d` is 4, 8 or 16 (a quarter, eighth or
sixteenth note). The default is 8. 1/32 is not offered. Any other value returns false
and changes nothing. `repeat_division()` reads it back. On the worklet, the message
`{ type: 'repeatDivision', value }` goes to both decks.

The division is a live performance setting. It is not part of the mix, a scene, the
44-value scene vector or a project. The host remembers it per viewer in localStorage
under `bckgrnd-msc:repeat-division` and sends it on load and on change.

## Behavior

- **Engage.** On the next transport onset that is a grid line of the division (every
  4th step for 1/4, every 2nd for 1/8, every step for 1/16), on that onset's
  sample. Held while stopped, it waits for Play. It does not engage during a brake,
  backspin or scratch.
- **Capture.** The first slice plays live and is recorded at the same time. From the
  end of that slice the recording loops, and the live signal is muted under it. The
  transport, the scheduler, scenes, fills and builds keep running underneath.
- **Slice length.** `8 / d` of the eighth the transport is actually playing. The
  transport fires each step one sample after its length runs out, so an eighth is the
  two step lengths, each rounded up to a whole sample. Slice `j` starts `ceil(j *
  period)` samples after the grid line. Repeats at 1/4 and 1/8 land exactly on the
  transport's grid lines, and repeats at 1/16 land on every eighth (its sixteenths
  are straight, not swung). The length is fixed when the slice is captured.
- **Seams.** Each looped slice ramps up over its first 2.5 ms and down over its last
  2.5 ms (the live first pass only ramps down). Every seam is a short linear dip.
- **Release.** Immediate: an 8 ms equal-power (quarter-sine) crossfade from the
  looping slice back to live. Holding again during that fade lets the fade finish,
  then arms for the next grid line.
- **Division change while held.** The repeat captures again on the next grid line of
  the new division. The old slice crossfades out over 2.5 ms as the new live pass comes
  in.
- **Where in the chain.** After the stem sum, the transition sounds and the direct
  voices, before the master chain. The dry sum, the returns feed and the per-stem echo
  sends are all recorded and replayed, so the master filter (and Filter Hold), the echo
  (and Echo Throw), the reverb and the limiter act on the stutter as they would on live
  audio, and the tails stay natural.
- **Bypass.** With no repeat held (or held but still waiting for its grid line), the
  engine does not call into the stutter and renders bit for bit what it rendered before
  Night 10.

## Transport interruptions

| Event | Beat Repeat |
|---|---|
| Stop, Panic, end of score | ends (all gestures end); 8 ms fade to live |
| Track load | ends (all gestures end) |
| Release FX | ends |
| Lease expiry | ends; event 21 with `b` 0 |
| Brake, backspin, scratch | ends; event 21 with `b` 1 |
| Cue or seek (`jump`) | keeps looping: the onset clock keeps its phase, so the stutter stays on the grid and release lands on the new position |
| Loop wrap, loop change | keeps looping |
| Play while playing (restart from step 0) | captures again at step 0 |
| Tempo change or bend while held | keeps the captured length; release lands in time because the transport never stopped |
| Solo or cutting every stem while held | the stutter keeps playing what it captured; the change is heard on release |

## Memory

The slice buffer is allocated once, with the engine: five channels for a quarter note at
36 BPM (the 40 BPM floor under the 0.9 bend) at the engine's own sample rate. That is
about 1.6 MB per engine at 48 kHz and 6.4 MB at 192 kHz. Nothing is allocated on the
audio path. `tests/no_alloc.rs` holds a repeat across every division to prove it.
