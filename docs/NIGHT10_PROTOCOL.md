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
Night 11 adds `repeat started` (61) and `repeat ended` (62) for when the stutter is
actually heard; see Events below.

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
| Stop, Panic, end of score | ends (all gestures end); 8 ms fade to live; 62 with `b` 5, 4, 7 |
| Track load | ends (all gestures end); 62 with `b` 6 |
| Release FX | ends; 62 with `b` 3 |
| Lease expiry | ends; event 21 with `b` 0, then 62 with `b` 0 |
| Brake, backspin, scratch | ends; event 21 with `b` 1, then 62 with `b` 1 |
| Cue or seek (`jump`) | keeps looping: the onset clock keeps its phase, so the stutter stays on the grid and release lands on the new position |
| Loop wrap, loop change | keeps looping |
| Play while playing (restart from step 0) | captures again at step 0 |
| Tempo change or bend while held | keeps the captured length; release lands in time because the transport never stopped |
| Solo or cutting every stem while held | the stutter keeps playing what it captured; the change is heard on release |

## Events (Night 11)

Two events let a take recorder place a stutter. They share the scene event ring, so
each also carries the onset serial (`NIGHT3_PROTOCOL.md`, Events, "The onset serial").

| kind | name | `requestId` | a | b |
|---|---|---|---|---|
| 61 | repeat started | the token held longest when it engaged | the step it engaged on (0-255, a grid line of the division) | the division: 4, 8 or 16 |
| 62 | repeat ended | the same token 61 named | the step of the last onset (0-255; -1 if none has fired since a seek or Play) | why, below |

`b` of 62:

| b | why |
|---|---|
| 0 | lease: the last held token's lease ran out (21 comes first) |
| 1 | platter: a brake, backspin or scratch took the deck (21 comes first) |
| 2 | release: the host let go of the last held token (`gesture_end`) |
| 3 | Release FX (`release_gestures`) |
| 4 | Panic |
| 5 | Stop |
| 6 | track load |
| 7 | end of score (offline render) |

0 and 1 mean what they mean in 21's `b`.

- **One stutter, one pair.** 61 means the stutter is heard from that onset's sample;
  62 means it is let go (the 8 ms release fade starts on that sample). Every 61 is
  followed by exactly one 62 with the same `requestId`, and no 62 comes without a 61.
  A recorder can pair them by id.
- **Let go before the grid line: nothing.** A press released while still armed never
  engaged, made no sound, and reports neither event. (The host knows it pressed; the
  engine only reports what was heard.)
- **Two tokens held.** They share one stutter, so there is still one 61 and one 62. 61
  names the token begun first among those held on the grid line, whichever slot it
  sits in. Letting go of one while another is held reports nothing: the stutter keeps
  playing. 62 comes when the last one is let go (or the engine ends it), and it names
  the token 61 named, even if that one was let go earlier. A token pressed while a
  stutter is already engaged reports nothing of its own.
- **Not a new start.** A division change while engaged, or Play while playing, captures
  again on the next grid line without a 61: it is the same stutter. The host already
  knows the division it sent.
- **Pressed again inside the release fade.** The first stutter's 62 came on the release.
  The fade finishes, the repeat arms, and the next grid line reports a new 61 (named
  for the token held now).
- **Ordering on one onset.** 61 is raised on the onset it engages on, after the onset
  is counted and before that onset's scene, pattern, build and fill events. Between
  onsets, 62 carries the last onset's serial.

## Memory

The slice buffer is allocated once, with the engine: five channels for a quarter note at
36 BPM (the 40 BPM floor under the 0.9 bend) at the engine's own sample rate. That is
about 1.6 MB per engine at 48 kHz and 6.4 MB at 192 kHz. Nothing is allocated on the
audio path. `tests/no_alloc.rs` holds a repeat across every division to prove it.
