# Performance events: the recording contract, version 2

A performance recording is a take of what the performer actually did. It holds the
scenes, fills, Rises, Fill intos and Beat Repeats the engine **applied**, each at the
engine step it applied on and at its **onset**, a position that never wraps. The schema
is [`contracts/performance.json`](../contracts/performance.json). The code is
`frontend/lib/recording.ts`. Where this file and the code disagree, the code is wrong.

This is the foundation for a later timeline (lanes for Scenes, Rise, Fills, Repeat and
Filter against bars), replay and arrangement export, for people and for the MCP. A take
lives in memory, and **exports as its own file**. It is never part of the project format,
a snapshot or a project export, and nothing saves it into one.

## What changed from version 1

| | v1 (Night 10) | v2 (Night 11) |
|---|---|---|
| Positions | Song step only, so a step repeats after a wrap, a loop or a cue | Song step **and** `onset` (the engine's onset serial, from the take's first event) and `pass` |
| Beat Repeat | Reserved, refused | `repeat`: start, end and division |
| Fill length | Not recorded | `length: 'bar' \| 'beat'` on `fill` and `fillInto` |
| Header | | `recordedAt` |
| Saving | In memory only | Exports as a standalone file |
| Reserved kinds | `repeat`, `filter`, `echo`, `gesture` | `filter`, `echo`, `gesture` |

v1 was never written to disk, so there are no v1 files. **A v2 reader refuses version
1** as it refuses a newer version: a v1 take has no onsets, and nothing can recover the
distances it never recorded.

## The document

```json
{
  "format": "bckgrnd-msc/performance",
  "version": 2,
  "track": "warehouse",
  "bpm": 124,
  "stepsPerBar": 16,
  "recordedAt": "2026-11-26T21:07:00.000Z",
  "startedAtStep": 240,
  "stoppedBy": "user",
  "truncated": false,
  "events": [
    { "seq": 1, "kind": "scene", "requestId": 71, "step": 240, "bar": 16, "beat": 1, "sixteenth": 1,
      "onset": 0, "pass": 1, "slot": "sparse", "name": "Sparse", "timing": "bar", "crash": false },
    { "seq": 2, "kind": "repeat", "token": 72, "step": 248, "bar": 16, "beat": 3, "sixteenth": 1,
      "onset": 8, "pass": 1, "division": 16, "endedBy": "engine", "endStep": 8, "endOnset": 24, "reason": 0 },
    { "seq": 3, "kind": "scene", "requestId": 73, "step": 16, "bar": 2, "beat": 1, "sixteenth": 1,
      "onset": 32, "pass": 2, "slot": "drop", "name": "Drop", "timing": "bar", "crash": false },
    { "seq": 4, "kind": "fill", "requestId": 76, "step": 28, "bar": 2, "beat": 4, "sixteenth": 1,
      "onset": 44, "pass": 2, "style": "busy", "length": "beat", "phraseBars": 0, "link": "none",
      "outcome": "played", "endStep": 32, "endOnset": 48 }
  ]
}
```

The repeat engaged on step 248 and ended on step 8 of the next pass: 16 onsets, across
the song's wrap.

| Field | Meaning |
|---|---|
| `track` | The track id the take was recorded on. A track change ends the take. |
| `bpm` | The tempo when Record was pressed. Positions are musical, so tempo changes move nothing. |
| `recordedAt` | When Record was pressed, ISO 8601 UTC. A label for the file; never a position. |
| `startedAtStep` | The song step sounding when Record was pressed. -1 if no step had sounded yet: stopped, or pressed with Play before its first onset. |
| `stoppedBy` | `user`, `stop`, `panic`, `track`, `mix` or `cap`. Null while recording. |
| `truncated` | True when the cap ended the take. |
| `events` | In the order the engine applied them. At most 10,000. |

Readers **reject** an unknown `format`, a newer `version`, and version 1.

### Every event

| Field | Meaning |
|---|---|
| `seq` | 1, 2, 3 and so on, in the order applied. This is the order, including two events on one step. |
| `kind` | `scene`, `fill`, `rise`, `fillInto` or `repeat`. |
| `requestId` | Every kind but `repeat`: the host's request id. Session-local; it only links events inside one take (a fill to its Rise or Fill into). |
| `token` | `repeat` only: the gesture token of the hold. Session-local, and not a request id. |
| `step` | Song step 0..255. |
| `bar`, `beat`, `sixteenth` | 1-based, derived from `step`: bar 1..16, beat 1..4, sixteenth 1..4. |
| `onset` | Onsets since the take's first event, which is 0. See Positions. |
| `pass` | 1-based run through the song, for people. See Positions. |
| `offGrid` | Present and `true` only when the engine gave no step. See below. |

### By kind

| Kind | When it is recorded | Fields |
|---|---|---|
| `scene` | `sceneApplied` for a scene pad (Compare listens and restores are not performance) | `slot`, `name` (as shown then), `timing` (`now`, `beat`, `bar`), `crash` |
| `fill` | `fillStarted` | `style` (resolved, or null), `length` (`bar`, `beat`), `phraseBars` (0, 2, 4, 8, 16), `link` (`none`, `fillInto`, `rise`), `partner`, `outcome` (`played`, `cutShort`, `open`), `endStep`, `endOnset`, `reason` |
| `rise` | `buildStarted` | `slot`, `name` (the landing scene), `bars` (2, 4, 8), `withFill`, `fillRequestId`, `outcome` (`landed`, `cancelled`, `replaced`, `open`), `endStep`, `endOnset`, `reason`, `crash` |
| `fillInto` | `sceneApplied` for the scene half of a Fill into | `slot`, `name`, `fillRequestId`, `length` (its fill's), `crash` |
| `repeat` | `repeatStarted` (61) | `division` (4, 8, 16), `endedBy` (`engine`, `recapture`, `take`, `open`), `endStep`, `endOnset`, `reason` |

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
- **Fill length** is the length that played: the effective one, so `bar` when the track
  has no beat fills, whatever the preference says. A fill keeps the length it was sent
  with. A `beat` fill plays only the bar's last beat, so it starts on beat 4
  (step 12 of its bar). A Fill into's `fillInto` repeats its fill's length.
- **Reserved kinds:** `filter`, `echo` and `gesture`. A later version adds them. A v2
  writer never writes them, and the v2 schema refuses them.

### Beat Repeat

One `repeat` event per engaged capture, holding its start and its end, like a Rise. One
event with both ends reads straight onto a timeline lane (a bar from `onset` to
`endOnset`), with nothing to pair up.

| Engine event | `id` | `a` | `b` | In the take |
|---|---|---|---|---|
| 61 repeat started | gesture token | song step it engaged on | division (4, 8, 16) | A `repeat` event at that step, `endedBy: "open"` |
| 62 repeat ended | token | song step | reason code | Closes it: `endedBy: "engine"`, `endStep`, `endOnset`, `reason` |

- **Engaged only.** A press waits for the division's next grid line (NIGHT10_PROTOCOL.md).
  A press released before that never engaged: there is no 61, nothing is in the take,
  and the developer log shows the press and the release ("released with no engage
  seen"). The host logs both from the pad, `pressed` and `released`.
- **Stopped while held.** If the take stops (Record, Stop, Panic, a track change, a mix,
  the cap) while a repeat is held, it is closed at the stop with `endedBy: "take"` and
  no `reason`. `endStep` is the song step of the engine's last playing frame, and
  `endOnset` counts forward from the last engine event seen to that step. A telemetry
  step that trails the engine (output latency) counts as no time. The 62 the engine
  posts afterwards is logged, not applied.
- **Captured again on the same hold** (a division change while held, or Play from step
  0): a second 61 with the same token. The first capture ends where the second begins,
  `endedBy: "recapture"`, and the second `repeat` carries the new division. If the
  engine instead posts 62 before the second 61, the first simply ends by `engine`.
- **`open`** appears only in a take still recording (an export taken mid-take).
- `reason` is the engine's code, as sent. Its meanings are the engine's
  (`docs/NIGHT11_PROTOCOL.md` once it lands).

## Applied, and nothing else

The engine settles every request with exactly one outcome (docs/NIGHT7_PROTOCOL.md).

| Outcome | In the take? | In the developer log? |
|---|---|---|
| queued | No | Yes, `queued` |
| canceled | No | Yes, `canceled`, with the reason |
| rejected | No | Yes, `rejected`, with the reason |
| replaced | No | Yes, `replaced` |
| applied (started, for a fill, a Rise or a repeat) | **Yes**, while recording | Yes, `applied`, marked recorded |
| a repeat pressed and released before its grid line | No | Yes, `pressed`, `released` |

A Rise canceled or replaced **after** it started keeps its event, because its start was
applied and heard. Its `outcome` says `cancelled` or `replaced`. A Rise canceled while
queued never appears. A canceled action is never recorded as applied.

## Positions

Positions come from the engine on each event, never from `performance.now()` or any wall
clock.

- **The song step.** The song position, 0..255: 16 bars of 16 sixteenths from the start
  of the track (`engine-core/src/transport.rs`). It wraps from 255 to 0, a loop keeps it
  inside the loop, a cue or a seek jumps it, and Play starts it at 0.
- **Derived fields.** `bar = floor(step / 16) + 1`, `beat = floor((step % 16) / 4) + 1`,
  `sixteenth = step % 4 + 1`.
- **The onset.** Every engine event carries `s`, the scheduler's monotonic onset serial
  (`Scheduler::serial`): the count of step onsets since the deck started. It never
  wraps, jumps or resets inside a take (Stop, a track load and a mix end the take). The
  take's first event fixes the origin: `onset = s - s(first event)`, so the first event
  is onset 0. Two events on the same song step in different passes have different
  onsets, and onsets never go back in `seq` order. `endOnset` is the same count for an
  end. Onsets are distances in sixteenths, so a timeline lays an event at `onset` and
  labels it with its `bar`, `beat` and `sixteenth`.
- **The pass.** A label for people: 1 for the first event's run through the song. From
  one on-grid event to the next, it goes up by the number of song wraps the onsets
  allow when the step moved by exactly the onsets elapsed (the song ran straight), and
  by at least one otherwise (a loop, a cue or a seek happened in between). It counts
  what the take's events show: several loop laps with no event between count once.
  `onset` is the position; `pass` is how the inspector says "the second time through".
- **Off the grid.** `sceneApplied` reports step -1 for a Now launch or a launch while
  stopped. The event is placed at the step sounding then, per telemetry, or at 0 when
  the transport is stopped (Play starts there), and flagged `offGrid: true`, as in v1.
  Its `onset` comes from its `s`, the onset sounding when it applied (a Now applies
  between onsets, at the start of the next render), and its `pass` is the one that
  onset falls in, counting wraps from the last on-grid event. An off-grid event does
  not move the reference the next pass is counted from, because its telemetry step can
  trail the engine by the output latency.
- **The origin is the first event, not the press.** The host has no serial for the
  moment Record is pressed (telemetry carries the song step only), so the take's onsets
  start at its first event. `startedAtStep` still says where Record was pressed.
- **An engine with no serials** (before Night 11's ring) gives events no `onset` or
  `pass`. Nothing is made up: such a take keeps its steps, and does not validate as v2.

## The session

`RecordingSession` is in memory: `start(track, bpm, step, recordedAt)`, `stop(reason,
step)`, `clear()`, `record(input)`, `interrupt(what, step)`, `recording()`,
`exportTake()`, and `state`: `idle`, `recording` or `stopped`. Start replaces any earlier
take. Stop keeps the take. Clear drops it. The `step` given to stop and interrupt is the
song step of the engine's last playing frame, where a held repeat is closed.

| Interruption | What happens to a take that is recording |
|---|---|
| Transport Stop (including a brake that comes to rest) | Ends it, `stoppedBy: "stop"`. Detected from the engine's telemetry going from playing to stopped after Start, not from the UI's `playing` flag, which Play sets before the engine confirms it. |
| Panic | Ends it, `stoppedBy: "panic"`, before the engine's cancels arrive. They are logged and never recorded. |
| Track load (Play on another track, Open project) | Ends it, `stoppedBy: "track"`. A take names one track. |
| Auto-mix, including continuous mix | Ends it as the mix begins, `stoppedBy: "mix"`. Everything queued is canceled by the engine anyway. |
| Cue, seek, loop change | Keeps recording. Song steps jump; onsets don't, and `pass` goes up. Cue is noted in the log. |
| 10,000 events | The next applied event is dropped, and the take ends with `stoppedBy: "cap"` and `truncated: true`. |

Any of these closes a held repeat with `endedBy: "take"`. Record while stopped is
allowed: `startedAtStep` is -1 and events start with Play.

## Export

A take exports as its own document. **No project format change**: a take is never saved
into a project, a snapshot or a project export, and opening a project never reads one.

| Function (`frontend/lib/recording.ts`) | Does |
|---|---|
| `exportTake(take)` | `{ filename, json }`: pretty-printed JSON with a final newline |
| `takeFilename(track, recordedAt)` | `bckgrnd-take-<track>-<YYYY-MM-DD-HHmm>.json`, in local time at `recordedAt`, so one take exports under one name. The track id is lowercased to `a-z0-9-`. |
| `downloadTake({ filename, json })` | Saves it as a file in the browser |
| `parseTake(text)` | Reads one back, refusing another format, a newer version and version 1. It checks the header; the full shape is the schema's. |

An export taken while recording is valid too: `stoppedBy` is null, a fill or Rise still
running says `open`, and a held repeat says `endedBy: "open"` with no end.

## The host

`useInstrument()` returns, for the Record indicator and the event inspector:

```ts
inst.recording: {
  state: 'idle' | 'recording' | 'stopped';
  count: number;
  log: readonly LogEntry[];          // a new array whenever the take changes: the memo key
  startRecording(): void;
  stopRecording(): void;
  clearRecording(): void;
  recording(): PerformanceRecording | null;   // a copy of the take
  exportTake(): TakeExport | null;            // { filename, json }
  downloadTake(t?: TakeExport | null): boolean; // saves t, or a fresh export; false with no take
}
```

For each event, `describeEvent(e)` gives `{ label, position, detail }`, for example
`{ label: 'Busy beat', position: 'Bar 8.4 · pass 2', detail: '' }`, or `'Repeat 1/8'`,
`'Bar 9.1 · pass 2'`, `'held 6 steps'`. The position is `Bar <bar>.<beat>`, with
`.<sixteenth>` when it is not the first, then the pass, then `off grid` for a Now
launch. A bar fill's label is its style ("Busy"), a beat fill's adds "beat"; with no
style, "Fill" or "Beat fill". `describePosition(p)` gives the position alone.

The host remembers what each request asked for when it is sent (`RequestCatalog`, fed
from the request book and the fill job), so an outcome is named correctly whatever order
the engine's listeners run in. Beat Repeat needs no catalog: events 61 and 62 name their
token. Nothing is sent to the engine.

## The developer log

`window.__BCKGRND_RECORDING__`, like the other `__BCKGRND_*__` hooks:

| Call | Returns |
|---|---|
| `table()` | Prints the log with `console.table`. |
| `log()` | The newest 500 entries: `{ n, status, kind, requestId, step, recorded, detail }`. For `repeat`, `requestId` is the token. |
| `recording()` | A copy of the take, as the contract describes it, or null. |
| `exportTake()`, `download()` | The export, and the browser download. |
| `state()`, `start()`, `stop()`, `clear()` | The session. |

## Deferred

- Replay, a timeline, arrangement editing, automation curves and WAV export.
- Capturing Filter Hold, Echo Throw and other gestures (the reserved kinds).
- An onset origin at the Record press. It needs the onset serial on telemetry.
- Importing a take into the app. `parseTake` reads the header; nothing opens a take yet.
