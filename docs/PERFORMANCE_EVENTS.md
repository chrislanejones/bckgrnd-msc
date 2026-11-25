# Performance events: the recording contract, version 1

A performance recording is a take of what the performer actually did. It holds the
scenes, fills, Rises and Fill intos the engine **applied**, each at the engine step it
applied on. The schema is [`contracts/performance.json`](../contracts/performance.json).
The code is `frontend/lib/recording.ts`. Where this file and the code disagree, the code
is wrong.

This is the foundation for a later timeline (lanes for Scenes, Rise, Fills, Repeat and
Filter against bars), replay and arrangement export, for people and for the MCP. None of
those exist yet. A take lives in memory only. It is not part of the project format, a
snapshot or an export, and nothing saves it.

## The document

```json
{
  "format": "bckgrnd-msc/performance",
  "version": 1,
  "track": "warehouse",
  "bpm": 124,
  "stepsPerBar": 16,
  "startedAtStep": 10,
  "stoppedBy": "user",
  "truncated": false,
  "events": [
    { "seq": 1, "kind": "scene", "requestId": 1, "step": 16, "bar": 2, "beat": 1, "sixteenth": 1,
      "slot": "sparse", "name": "Sparse", "timing": "bar", "crash": true },
    { "seq": 2, "kind": "fill", "requestId": 2, "step": 32, "bar": 3, "beat": 1, "sixteenth": 1,
      "style": "busy", "phraseBars": 0, "link": "none", "outcome": "played", "endStep": 48 },
    { "seq": 3, "kind": "rise", "requestId": 5, "step": 48, "bar": 4, "beat": 1, "sixteenth": 1,
      "slot": "drop", "name": "Drop", "bars": 2, "withFill": true, "fillRequestId": 6,
      "outcome": "landed", "endStep": 80, "crash": true }
  ]
}
```

| Field | Meaning |
|---|---|
| `track` | The track id the take was recorded on. A track change ends the take. |
| `bpm` | The tempo when Record was pressed. Positions are musical, so tempo changes move nothing. |
| `startedAtStep` | The song step sounding when Record was pressed. -1 if no step had sounded yet: stopped, or pressed with Play before its first onset. |
| `stoppedBy` | `user`, `stop`, `panic`, `track`, `mix` or `cap`. Null while recording. |
| `truncated` | True when the cap ended the take. |
| `events` | In the order the engine applied them. At most 10,000. |

Readers **reject** an unknown `format` or a newer `version`, as for projects.

### Every event

| Field | Meaning |
|---|---|
| `seq` | 1, 2, 3 and so on, in the order applied. This is the order, including two events on one step. |
| `kind` | `scene`, `fill`, `rise` or `fillInto`. |
| `requestId` | The host's request id. It is session-local and only links events inside one take (a fill to its Rise or Fill into). |
| `step` | Song step 0..255. |
| `bar`, `beat`, `sixteenth` | 1-based, derived from `step`: bar 1..16, beat 1..4, sixteenth 1..4. |
| `offGrid` | Present and `true` only when the engine gave no step. See below. |

### By kind

| Kind | When it is recorded | Fields |
|---|---|---|
| `scene` | `sceneApplied` for a scene pad (Compare listens and restores are not performance) | `slot`, `name` (as shown then), `timing` (`now`, `beat`, `bar`), `crash` |
| `fill` | `fillStarted` | `style` (resolved, or null), `phraseBars` (0, 2, 4, 8, 16), `link` (`none`, `fillInto`, `rise`), `partner`, `outcome` (`played`, `cutShort`, `open`), `endStep`, `reason` |
| `rise` | `buildStarted` | `slot`, `name` (the landing scene), `bars` (2, 4, 8), `withFill`, `fillRequestId`, `outcome` (`landed`, `cancelled`, `replaced`, `open`), `endStep`, `reason`, `crash` |
| `fillInto` | `sceneApplied` for the scene half of a Fill into | `slot`, `name`, `fillRequestId`, `crash` |

- A Fill into is two events: its `fill` (with `link: "fillInto"` and `partner`), then the
  `fillInto` landing on the step the fill ended. If the scene half is canceled while the
  fill plays, the fill stays (it was heard), unlinked, and there is no `fillInto`.
- A Rise's landing is part of its `rise` event (`outcome: "landed"`, `endStep`). There
  is no separate scene event for it. `landed` means `buildApplied`: the Rise ran its bars
  and reached the scene. (`b` on that event only says whether a separate landing vector
  was committed as well, which the host's Rise need not send.)
- `crash` turns true when the engine's `accentFired` follows for that request.
- Outcomes are filled in later by `fillEnded`, `buildApplied`, `buildCancelled` and
  `buildReplaced`, while the take is still recording. `open` means the take stopped
  first.
- **Reserved kinds:** `repeat` (Beat Repeat), `filter`, `echo` and `gesture`. A later
  version adds them. A v1 writer never writes them, and the v1 schema refuses them.

## Applied, and nothing else

The engine settles every request with exactly one outcome (docs/NIGHT7_PROTOCOL.md).

| Outcome | In the take? | In the developer log? |
|---|---|---|
| queued | No | Yes, `queued` |
| canceled | No | Yes, `canceled`, with the reason |
| rejected | No | Yes, `rejected`, with the reason |
| replaced | No | Yes, `replaced` |
| applied (started, for a fill or a Rise) | **Yes**, while recording | Yes, `applied`, marked recorded |

A Rise canceled or replaced **after** it started keeps its event, because its start was
applied and heard. Its `outcome` says `cancelled` or `replaced`. A Rise canceled while
queued never appears. A canceled action is never recorded as applied.

## Positions

Positions come from the engine step on each event, never from `performance.now()` or
any wall clock.

- **What the engine step is.** The song position, 0..255: 16 bars of 16 sixteenths from
  the start of the track (`engine-core/src/transport.rs`). It wraps from 255 to 0, a loop
  keeps it inside the loop, a cue or a seek jumps it, and Play starts it at 0. The
  engine's own monotonic onset counter (`Scheduler::serial`) is not on the event ring.
- **Derived fields.** `bar = floor(step / 16) + 1`, `beat = floor((step % 16) / 4) + 1`,
  `sixteenth = step % 4 + 1`.
- **Off the grid.** `sceneApplied` reports step -1 for a Now launch or a launch while
  stopped. The event is placed at the step sounding then, per telemetry, or at 0 when the
  transport is stopped (Play starts there), and flagged `offGrid: true`.
- **Song positions repeat.** After a wrap, a loop or a cue, a later event can have a
  smaller step. `seq` is the order. Elapsed bars since the start of a take are not in
  v1 (see Deferred).

## The session

`RecordingSession` is in memory: `start(track, bpm, step)`, `stop()`, `clear()`,
`record(input)`, `interrupt(what)`, and `state`: `idle`, `recording` or `stopped`.
Start replaces any earlier take. Stop keeps the take. Clear drops it.

| Interruption | What happens to a take that is recording |
|---|---|
| Transport Stop (including a brake that comes to rest) | Ends it, `stoppedBy: "stop"`. Play starts at step 0, so positions after it would mean a new take. Detected from the engine's telemetry going from playing to stopped after Start, not from the UI's `playing` flag, which Play sets before the engine confirms it. |
| Panic | Ends it, `stoppedBy: "panic"`, before the engine's cancels arrive. They are logged and never recorded. |
| Track load (Play on another track, Open project) | Ends it, `stoppedBy: "track"`. A take names one track. |
| Auto-mix, including continuous mix | Ends it as the mix begins, `stoppedBy: "mix"`. Everything queued is canceled by the engine anyway. |
| Cue, seek, loop change | Keeps recording. Song positions stay correct; `seq` keeps the order. Cue is noted in the log. |
| 10,000 events | The next applied event is dropped, and the take ends with `stoppedBy: "cap"` and `truncated: true`. |

Record while stopped is allowed: `startedAtStep` is -1 and events start with Play.

## The host

`useInstrument()` returns, for the Record indicator:

```ts
inst.recording: {
  state: 'idle' | 'recording' | 'stopped';
  count: number;
  startRecording(): void;
  stopRecording(): void;
  clearRecording(): void;
  log: readonly LogEntry[];
}
```

The host remembers what each request asked for when it is sent (`RequestCatalog`, fed
from the request book and the fill job), so an outcome is named correctly whatever order
the engine's listeners run in. Nothing is sent to the engine, and the event ring is
unchanged.

## The developer log

`window.__BCKGRND_RECORDING__`, like the other `__BCKGRND_*__` hooks:

| Call | Returns |
|---|---|
| `table()` | Prints the log with `console.table`. |
| `log()` | The newest 500 entries: `{ n, status, kind, requestId, step, recorded, detail }`. |
| `recording()` | A copy of the take, as the contract describes it, or null. |
| `state()`, `start()`, `stop()`, `clear()` | The session. |

There is no production UI beyond the Record indicator.

## Deferred

- Replay, a timeline, arrangement editing, automation curves and WAV export.
- Capturing Beat Repeat, Filter and Echo holds and other gestures (the reserved kinds).
- Elapsed position across wraps, loops and cues. It needs the engine's onset serial on
  the events (a change to the shared event ring), or a host-side count.
- Saving or exporting a take. It would be a new file next to the project, never inside
  it.
