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
- `length` is 0, one bar, or (Night 10) 1, the bar's last beat: see the Night 10
  addendum at the end. Anything else is refused, reason 1.
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
| 12 | fill started | step | the first recipe position it plays: 0, or 12 for a beat fill (Night 10) |

The spec's "Phrase end · Beat" (`b` = 12) was dropped in Night 8 (`NIGHT8_DECISIONS.md`
§3) and came back in Night 10 as fill length 1, with dedicated one-beat patterns.

### Worklet messages

| Host → worklet | Engine call |
|---|---|
| `{type: 'fill', requestId, generation, index, phrase?, length?, deck?}` | `queue_fill_at(requestId, index, phrase ?? 0, length ?? 0)`. A phrase other than 0, 2, 4, 8 or 16, or a length other than 0, goes in as 255 (refused, reason 1) |

The host API is `EngineHost.queueFill(requestId, index, generation, phrase = 0)` with
`FILL_PHRASE_BARS` in `frontend/lib/engine.ts`.

Which fill: in Night 8 the host always sent index 0, the track's one fill. Since Night 9
the engine is loaded with the track's four `fillStyles` as its fills, and Fill, Fill into
and Rise + Fill send the index of the chosen Fill Style, looked up by `style` key with
`fillIndex()` in `frontend/lib/fills.ts` (0, Classic, when a track has no styles). See
ADR-024. The engine side is unchanged.

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
  the track's fill to play (the chosen Fill Style's index since Night 9, as for Fill).
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

## Crash accents

A scene can carry a **crash accent**: when it commits during playback, the transition
crash (`engine-core/src/transition.rs`, the Drop's own voice, no new synthesis) plays
once on that onset. Off by default and never automatic (`NIGHT8_DECISIONS.md` §7).
Storing the flag per scene in the project format is the host's job (ADR-012/014); the
engine only takes it on the request.

### The requests

| Engine | Accent argument |
|---|---|
| `queue_scene_with(request_id: u32, timing: u8, values: &[f32], accent: u8) -> u8` | the launch's; `queue_scene(id, timing, values)` is this with 0 |
| `queue_fill_into(…, values, accent: u8) -> u8` | the Fill into's scene |
| `queue_build_with(…, fill_id, fill_index, accent: u8) -> u8` | the Rise's landing |

`accent` is 0 (none) or 1 (crash). Anything else is refused as invalid: `scene rejected`
(`b` 0) for a launch, part 1 (scene) for a Fill into, part 3 (landing) for a Rise.

### When it fires

| Rule | Why |
|---|---|
| On the onset the scene commits, after that step's transition sounds have run | So it can tell whether the Drop's crash fired on the same onset |
| A Now launch while playing: at once, on the first sample of the render call it commits in; `a` = -1 | Now has no onset |
| Applied while stopped: nothing, no event | Nothing is playing to accent |
| On the Drop's natural crossing (191 → 192): **one** crash, the Drop's; `b` = 2 merged | ADR-008's crash already fires there |
| On 192 reached by a loop's wrap (not a crossing): the accent plays, `b` = 1 | There is no natural crash to merge with |
| Under a solo, the scene's own included: counted and silent, `b` = 0 | The transition sounds' rule (ADR-008) |
| A Rise with the accent: on its end onset, after the landing scene, its lanes and the fill's end, with or without a landing scene | The landing is a commit |
| A Fill into with the accent: on the phrase line, after the scene and the fill's end | The same |
| Replaced, cancelled or refused before it commits: nothing | It never landed |

### Events: kind 53

| kind | name | a | b |
|---|---|---|---|
| 53 | accent fired | the step (-1 for a Now launch) | 0 silent under solo, 1 played, 2 merged with the natural crash |

`requestId` is the scene's (or the Rise's). It comes after that request's `applied`.

### Worklet messages

`scene`, `fillInto` and `build` gain `accent?` (1 for a crash). Absent or 0 is none;
anything else goes in as 255 and is refused. The host API takes `SCENE_ACCENT` on
`EngineHost.queueScene(…, patterns?, accent)`, `queueFillInto(…, {accent})` and
`queueBuild(…, {accent})`, with `ENGINE_EVENT.accentFired` and `ACCENT_FIRED` for `b`.

## Checks

| Check | Covers |
|---|---|
| `cargo test` `fill_tests.rs` | Phrase fills for 2/4/8/16 bars on every phrase line, bad phrase or length, late presses, loop wraps, tempo and loop while waiting; Fill into landing order, the scene's kick on the line, no gap, atomic refusal per part, every cancel/replace row, interrupts; Rise + Fill at 2/4/8 bars, refusal per part, cancel from either part, interrupts, replace, loop and tempo, the held slot; accents once on commit, merged on 192, silent under solo, none stopped, on a Rise landing and a Fill into, bad codes |
| `cargo test --test no_alloc` | A counting allocator over every `process()` call and the request calls through all of the above (tone stems too since `473d13c`: see below) |
| `cargo bench --bench render` | `fills` (back-to-back Fill into) against `night3`, the same music through Night 3 calls, and both against `plain` |
| `pnpm check:scenes` | `foldFillEvent` for 11-15, 51, 52, reason 11 and 53 |

In Night 8 `process()` still allocated when it triggered a tone note (the `NoteEvent`
clone and the voicing's detune `Vec`), so the no-allocation test played drums alone.
Night 9 fixed that (`473d13c`, ADR-016's amendment): the test now plays every library
track with its tone stems.

## Where this departs from the spec

For the ADRs (`docs/NIGHT8_SPEC.md` as amended by `NIGHT8_DECISIONS.md`):

| Spec | Built | Why |
|---|---|---|
| `queue_fill_into(fill_id, index, length, scene_id, values)`, "`at` is always phrase end" | Takes `phrase_bars` too (0 to 16), and `accent` | Phrase 0 gives a next-bar Fill into, as the task asks; the accent rides on the request (§C) |
| `PendingFill` gains `first_pos` | Not added | "Phrase end · Beat" was dropped (§3); `fill started` `b` stays 0 |
| Rise + Fill: "`queue_build` gains a fill index" | A new `queue_build_with(…, fill_id, fill_index, accent)`; `queue_build` is unchanged | Keeps every Night 7 caller; the fill gets its own request id, as Fill into's does |
| The accent travels "on `queue_scene`" | A new `queue_scene_with(…, accent)`; `queue_scene` is unchanged | The same |
| Refusal: "both with the same reason, and `b` = the part" | As written, and `b` = 0 when the whole request is refused (stopped, scratch) | No single part is at fault |
| Reason 11: "one part was refused or canceled because its partner was" | Used only for a Rise's fill when its Rise is **replaced** | Refusals carry the real reason on both parts (the spec's other sentence); a user cancel is 10 on both (the spec's table); only a replaced Rise's fill went for no reason of its own |
| "Another scene launched while linked: latest wins" | The new scene keeps **its own** timing, not the Fill into's landing | Inheriting it would make it a Fill into with an unlinked fill |
| A fill in a Rise (Rise + Fill) blocked by a fill playing now | Only a **waiting** fill blocks it | A playing fill ends before the Rise's last bar can begin; latest-wins for Rises stays intact |
| A replaced Rise's fill | Cancelled (11) while waiting, unlinked (52, 11) if playing | A Fill into's fill outlives its scene because it was the action; a Rise's fill was a part of the Rise |
| The accent on a Rise with no landing scene | Fires on the end onset anyway | The Rise's end is the landing |
| Event 51's re-announce | 51 comes once; a loop change re-sends 11 and 1 (or 41) | 51 is the tie, not a prediction |

## Night 10 addendum: beat fills (length 1)

`FILL_LENGTHS` is `[0, 1]` (`engine-core/src/scheduler.rs`, `scene::fill_length`):

| length | name | What plays |
|---|---|---|
| 0 | bar | As before: the fill's 16 positions replace the drum lanes for the whole bar, from its bar line. Bit-identical to Night 9. |
| 1 | beat | Only the bar's **last beat**, steps 12-15, from positions 12-15 of the fill's recipe. Beats 1-3 play the groove as it is, pattern edits included. It ends on the same downbeat a bar fill of that bar would. |

Every path takes it:

| Request | Length argument | With length 1 |
|---|---|---|
| `queue_fill_at(id, index, phrase, length)` | existing | Next bar (phrase 0) or phrase end (2/4/8/16): the last beat of the bar a bar fill would play by the same rule (see below) |
| `queue_fill_into(…, phrase, length, …)` | existing | The beat fill, and the scene committing on the next downbeat, the onset the fill ends |
| `queue_build_with_length(request_id, bars, target, land, fill_id, fill_index, accent, fill_length) -> u8` | **new** | Only the last beat of the Rise's last bar is the fill; the landing commits on the next downbeat as before. A bad length is refused as a whole, part 5 (the fill). Ignored without a fill. |
| `queue_build_with(…, fill_id, fill_index, accent)` | unchanged | `queue_build_with_length(…, 0)` |
| `queue_fill(id, index)` | unchanged | `queue_fill_at(id, index, 0, 0)` |

- **Timing, and the late-press rule.** The rule is the one bar fills have always had:
  the first start ahead that qualifies, counted from the step due next, never one
  already passed (`fill_offset_for`). A bar fill's start is its bar line; a beat fill's
  is step 12 of its bar, and the bar qualifies the same way (its end is a phrase line,
  or the loop's wrap). So **a beat fill pressed before this bar's last beat has started
  plays it**, even in the phrase's last bar (pressed on step 59, it plays 60-63 and ends
  on the line at 64); pressed on or after step 12 it goes to the next qualifying bar,
  with phrase 0 the next bar, with a phrase the next phrase end. Never refused for being
  late.
- `fill queued` `a` is the bar and `b` the first step (12 mod 16); `fill started` `b`
  is 12, the first recipe position. `fill linked` `b` and a Fill into's `scene queued`
  carry the downbeat it lands on, as before.
- Cancel: a waiting beat fill can be cancelled until step 12 of its bar has fired;
  once started it plays out its beat, the bar fill's rule.
- Loop and tempo changes: as for bar fills (counted in onsets, re-announced on a loop
  change).
- A beat fill playing ends within a beat, so it never blocks a Rise; a waiting one does,
  as any waiting fill does (the host withdraws it first).

The lanes are 16-step bars like every fill: a beat fill's are silent before step 12,
so nothing changes in `Fill` or the track JSON. The engine plays whatever positions
12-15 of the fill it is given hold: the four dedicated one-beat patterns travel beside
the track as `beatFillStyles` (`Fills::beatStyles`), and the host loads the engine with
the four styles then the four beat fills, so a beat fill's index is 4-7.

Worklet messages: `fill` and `fillInto` `length` 0 (or absent) or 1, anything else 255
(refused); `build` gains `fillLength?` (0 or absent, the last bar; 1 its last beat) and
calls `queue_build_with_length`. The host API: `queueFill(…, phrase, length)`,
`queueFillInto(…, {length})`, `queueBuild(…, {fill: {requestId, index, length}})`, with
`FillLength = 0 | 1` (`frontend/lib/engine.ts`).

`FILL_LENGTHS` is not mirrored in `contracts/`: fill requests are performance, not
project format, and the worklet's `fillLength` is the one copy outside the engine.
