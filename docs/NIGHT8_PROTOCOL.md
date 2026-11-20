# Night 8: phrase fills, Fill into, Rise + Fill, crash accents (the working protocol)

The engine calls, worklet messages and events for Night 8. The specification is
`docs/NIGHT8_SPEC.md` as amended by `docs/NIGHT8_DECISIONS.md`; this file pins down
what was built, and the decisions the spec left open. It extends
`docs/NIGHT3_PROTOCOL.md` (fills, scenes, events, reasons), `docs/NIGHT4_PROTOCOL.md`
(lanes) and `docs/NIGHT7_PROTOCOL.md` (builds), and follows ADR-015: the engine owns
musical timing, every request ends in an explicit outcome, and nothing on the audio path
allocates. Where this file and the code disagree, the code is wrong.

## Phrase fills

### The request

| Engine (`engine-core/src/fills.rs`) | Returns |
|---|---|
| `queue_fill_at(request_id: u32, index: u32, phrase_bars: u8, length: u8) -> u8` | 0 accepted, else the reason (also reported as `fill rejected`) |
| `queue_fill(request_id: u32, index: u32) -> u8` | Unchanged: `queue_fill_at(id, index, 0, 0)` |

- `phrase_bars` is 0 (the next bar, the Night 3 fill) or 2, 4, 8 or 16. Anything else
  is refused, reason 1.
- `length` is 0, one bar. Anything else is refused, reason 1. The argument is there so
  that more lengths fit later without changing the call (`NIGHT8_DECISIONS.md` §3).
- Other refusals are unchanged: 1 no such fill, 7 not playing, 3 a scratch, brake or
  backspin, 8 a fill already queued or playing.
- The phrase length rides on the request. The engine keeps no phrase setting of its
  own: phrase length is an app preference (`NIGHT8_DECISIONS.md` §1).

### Timing

- **Phrase lines sit on the absolute grid from step 0**, every `phrase_bars × 16` steps.
  All four lengths divide the 256-step song, so the song's own wrap is always a phrase
  line too.
- The fill plays **the first bar whose end is a phrase line or the loop's wrap**,
  counting from the step due next. With phrase 0 that is simply the next bar line.

  | Phrase | Bars the fill plays (no loop) |
  |---|---|
  | 2 bars | 16, 48, 80, 112, 144, 176, 208, 240 |
  | 4 bars | 48, 112, 176, 240 |
  | 8 bars | 112, 240 |
  | 16 bars | 240 |

- **Late presses roll on.** The walk only looks ahead, so a press after the phrase's
  last bar line has passed (anywhere in its last bar, or on that line's own onset) goes
  to the next phrase end, at most one phrase away (16 bars at the longest). It is never
  refused for being late. `fill queued` names the bar, so the host can say "Fill · Next
  phrase".
- **Counted in onsets.** On queue the engine walks the clock with `Transport::following`
  (bounded by one pass of the song) and stores `start_serial`, the onset serial of the
  fill's first step. Tempo changes move nothing.
- **Loops.** The loop's wrap is a phrase end, so in a 1-bar loop the fill plays the next
  bar, and in a longer loop it plays the loop's last bar unless a phrase line inside
  the loop comes first. Setting, changing or clearing the loop while a fill waits works
  `start_serial` out again from where the playhead is and reports `fill queued` again.
- A fill still plays all sixteen steps once started; only an interrupt cuts it short
  (Night 3).

### Events

No new kinds for phrase fills.

| kind | name | a | b |
|---|---|---|---|
| 11 | fill queued | the bar it plays (1-based) | its first step |
| 12 | fill started | step | 0, the first recipe position (one-bar fills only) |

The spec's "Phrase end · Beat" (`b` = 12) is not built: `NIGHT8_DECISIONS.md` §3 drops
it.

### Worklet messages

| Host → worklet | Engine call |
|---|---|
| `{type: 'fill', requestId, generation, index, phrase?, length?, deck?}` | `queue_fill_at(requestId, index, phrase ?? 0, length ?? 0)`. A phrase other than 0, 2, 4, 8 or 16, or a length other than 0, goes in as 255 (refused, reason 1) |

The host API is `EngineHost.queueFill(requestId, index, generation, phrase = 0)` with
`FILL_PHRASE_BARS` in `frontend/lib/engine.ts`.

## Fill into

One press: a phrase fill, and a scene (Drop, or any slot) that **commits on the onset
the fill ends**. A separate performance action beside Fill, not a Switch on choice
(`NIGHT8_DECISIONS.md` §5).

### The request

| Engine (`engine-core/src/fills.rs`) | Returns |
|---|---|
| `queue_patterns(patternsId, 2, link = scene_id, data)` just before, if the scene sets lanes | 0 staged, else `patterns rejected` (Night 4) |
| `queue_fill_into(fill_id: u32, index: u32, phrase_bars: u8, length: u8, scene_id: u32, values: &[f32]) -> u8` | 0 accepted, else the reason |
| `cancel_fill(fill_id) -> bool` | true while there was something to cancel (below) |
| `cancel_scene(scene_id) -> bool` | Unchanged signature; cancels the whole request (below) |

- `phrase_bars` and `length` are `queue_fill_at`'s: the fill plays the phrase's last
  bar (or the next bar with phrase 0), and the scene lands on the phrase line.
- `values` is the 44-value scene vector (Night 3), validated as a whole.
- Two request ids: the fill's and the scene's. The host already numbers fills and
  launches from one counter, so they never collide.

### All or nothing

Everything is checked before anything changes: the scene vector, the fill (index,
phrase, length), the transport, and that no fill is queued or playing. Either both parts
are queued or neither is.

| Refused for | Reason | `b` (part) |
|---|---|---|
| The scene vector | 1 invalid | 1 scene |
| The fill index, phrase or length | 1 invalid | 2 fill |
| A fill already queued or playing | 8 already playing | 2 fill |
| Stopped | 7 not playing | 0 the whole request |
| A scratch, brake or backspin | 3 transport | 0 |
| The lanes (worklet: the engine refused the payload) | 1 invalid | 3 lanes |
| Mixing, a stale generation, no engine yet (worklet) | 6, 9, 7 | 0 (1 for a vector that is not 44 long) |

A refusal posts **both** `fill rejected` (15, the fill's id) and `scene rejected` (5,
the scene's id), with the same reason and the same `b`, then withdraws the lanes staged
for the scene with that reason. A scene, a build or a fill already pending keeps what it
was accepted with, lanes included (the staging rule from `night8/staging`).

Accepted, the events are, in order: `scene replaced` for a scene that was pending (and
`patterns cancelled`, reason 10, for its lanes), `fill queued` (the bar the fill plays),
`scene queued` (`a` = the landing bar, `b` = the landing step), and `fill linked` (51).

### Timing

- No new slots: the one pending fill and the one pending scene, tied by id. The scene
  waits as `Timing::Linked`, due on onset serial `start_serial + 16`.
- On the landing onset the order is unchanged (Night 4, Night 7):

  > pattern edit → **the scene commits, with its lanes** → build → `fill_onset` (**the
  > fill ends**) → that step's notes.

  So the downbeat plays the new scene's drums: not silence, and not the fill.
- A loop change while waiting moves both together: `fill queued` and `scene queued` are
  posted again with the new bar and landing. Tempo changes move nothing.

### Cancel and replace

| Situation | Outcome |
|---|---|
| `cancel_fill(fill_id)` or `cancel_scene(scene_id)` before the fill starts | Both cancelled, reason 10, and the lanes (10). Events: `scene cancelled`, `fill cancelled`, `patterns cancelled` |
| Either of those while the fill plays | The scene is cancelled (10) with its lanes; the fill plays out its bar and is unlinked (52, `a` = 10). Returns true |
| Stop, seek, scratch, brake, backspin, Play while playing, track load, panic, the host's `cancel_pending` | Both cancelled, or the fill cut short (`fill ended`, -1), with that reason, and the lanes. Nothing is unlinked: both are gone |
| Another scene launched (any timing) | The scene is `replaced` (latest wins) and its lanes withdrawn (10). The fill is unlinked (52, 10) and plays as a plain phrase fill. The new scene keeps **its own** timing |
| A Rise queued | The scene is `replaced` by the build (Night 7); the fill is unlinked (52, 10) |
| A Rise running when the Fill into lands | The scene commits and replaces the build (`build replaced`, `a` = the scene's id) on the phrase line; the fill played on top |
| Another Fill into, or any fill | Refused, 8 (no stacking). The pending one is untouched |
| A pattern edit | Unaffected (Night 4). On a lane both set on the same onset, the scene's lanes win |

### Events: kinds 51 and 52

| kind | name | a | b |
|---|---|---|---|
| 51 | fill linked | the id of the request the fill leads into | the predicted landing step |
| 52 | fill unlinked | the reason its partner went (10) | 0 |

`fill linked` comes once, on acceptance; a re-announce after a loop change is `fill
queued` and `scene queued`. After `fill unlinked` the fill is a plain fill and reports
11-15 as usual.

### Worklet messages

| Host → worklet | Engine call |
|---|---|
| `{type: 'fillInto', fillId, sceneId, generation, index, phrase?, length?, values, deck?, patterns?, patternsId?}` | `patterns` (if any) staged first with `queue_patterns(patternsId, 2, sceneId, patterns)`; then `queue_fill_into`. Refusals made here post both rejected events, as above |
| `{type: 'cancelFill', requestId}` | `cancel_fill`, answered with `fillCancelResult`, and the events drained at once |

The host API is `EngineHost.queueFillInto(fillId, sceneId, index, values, generation,
{phrase, patterns})` with `FILL_INTO_REJECTED_PART`, `ENGINE_EVENT.fillLinked` and
`fillUnlinked` in `frontend/lib/engine.ts`. `frontend/lib/scenes.ts` folds a fill's
events with `foldFillEvent` (`FillRequest`: status, bar, `linkedTo`, `landing`); the
scene part is an ordinary launch for `foldSceneEvent`. When the scene is applied the
worklet carries it to the idle deck, as for a launch.

## Rise + Fill

A Rise (Night 7 build) can **finish with a fill**: "Finish with Fill" on Rise, off by
default (`NIGHT8_DECISIONS.md` §6). The fill plays the Rise's last bar; the landing scene
and its lanes commit on the next downbeat, which is the existing build landing.

### The request

| Engine (`engine-core/src/build.rs`) | Returns |
|---|---|
| `queue_build_with(request_id: u32, bars: u32, target: &[f32], land: &[f32], fill_id: u32, fill_index: u32) -> u8` | 0 accepted, else the reason |
| `queue_build(request_id, bars, target, land) -> u8` | Unchanged: `queue_build_with(…, 0, 0)` |
| `cancel_build(request_id) -> bool`, `cancel_fill(fill_id) -> bool` | Either cancels the whole request (below) |

- `fill_id` 0 means no fill. Otherwise it is the fill's own request id, and `fill_index`
  the track's fill to play.
- Lanes are staged before it with `link` = the build's id, as in Night 7.

### One transaction

Everything is checked before anything changes, and a refusal of any part refuses all of
it. With a fill, the refusal posts `fill rejected` (15) and `build rejected` (45), in
that order, with the same reason and the same `b` (`build::detail`), and the build's
staged lanes are withdrawn with that reason. Without a fill nothing changes from Night 7.

| Refused for | Reason | `b` (part) |
|---|---|---|
| Bars, target, landing (Night 7) | 1 | 1, 2, 3 |
| Lanes (worklet) | 1 | 4 |
| **No such fill** | 1 | **5 fill** |
| **A fill already waiting** (a plain fill, a Fill into, another Rise's) | 8 | **5 fill** |
| Stopped, scratch/brake/backspin (Night 7) | 7, 3 | 0 |

A fill **playing** now does not block it: that fill ends within a bar, and the Rise's
fill plays its last bar, at least a bar after the Rise starts. A waiting fill does
block it, except the fill of the Rise this one replaces, which goes with that Rise.

Accepted with a fill, the events are `build queued`, `fill queued` (the bar the fill
plays: the Rise's last) and `fill linked` (51: `a` = the build's id, `b` = the landing
step).

### Timing

- The fill waits, unarmed, in the one pending fill slot. When the build starts (its bar
  line, onset serial S) the fill is armed for S + bars × 16 − 16: the build's last bar,
  counted in onsets like the build, so tempo changes and loops move neither.
- On the landing onset the Night 7 order stands: pattern edit → a scene due there →
  **the build writes its target, commits the landing scene and swaps in its lanes** →
  `fill_onset` (**the fill ends**) → that step's notes.
- A loop change re-announces the waiting Rise (`build queued`) and its fill (`fill
  queued`). While the Rise runs, the fill's onset is fixed, but the step it falls on may
  move, so `fill queued` is posted again with the new bar.
- While a Rise + Fill waits or runs, the fill slot is taken: Fill and Fill into are
  refused (8) until its fill has started.

### Cancel and replace

| Situation | Outcome |
|---|---|
| `cancel_build(id)` or `cancel_fill(fill_id)` before the fill starts | Build cancelled (10) and restored, its lanes withdrawn (10), the fill cancelled (10). Events in that order |
| Either during the fill's bar | The same for the build; the fill runs its bar (Night 3) and is unlinked (52, 10) |
| Stop, seek, scratch, brake, backspin, Play while playing, track load, panic, the host's `cancel_pending` | Both cancelled, or the fill cut short, with that reason (as Night 7 and Night 3) |
| A scene commits over the Rise (Night 7), or a newer Rise replaces it, or the idle deck's follower | `build replaced`; the waiting fill is cancelled with **reason 11 (linked)**, or, if it is already playing, unlinked (52, 11) and played out |

Reason 11 is used only here: the fill did nothing wrong and nobody cancelled it; it went
because the Rise it belonged to was replaced.

### Worklet messages

| Host → worklet | Engine call |
|---|---|
| `build` gains `fillId?, fillIndex?` | `queue_build_with(requestId, bars, target, land, fillId ?? 0, fillIndex ?? 0)`. Refusals made in the worklet post `fill rejected` for the fill too |

The host API is `EngineHost.queueBuild(requestId, bars, target, generation, land?,
patterns?, {fill: {requestId, index}})`, with `BUILD_REJECTED_PART.fill` (5),
`BUILD_REJECTED_PART.lanes` (4) and `ENGINE_REASON.linked` (11). The fill folds with
`foldFillEvent` like any other (`linkedTo` = the build's id).
