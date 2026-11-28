# ADR-026: A performance take is its own versioned contract of applied events at engine song steps, outside the project format
Date: 2026-11-25   Status: draft
Amended 2026-11-26 (draft): version 2. See "Amendment: version 2" at the end. Where it
and the v1 text disagree, the amendment wins.

## Context
Chris's roadmap puts a timeline on Night 12, replay on 13, WAV export on 14 and MCP
arrangement generation on 15. All of them need a record of what the performer did, one
that both a person and the MCP can produce. The engine settles every request with
exactly one outcome (`NIGHT7_PROTOCOL.md`), but most requests never sound: they are
queued, canceled, rejected or replaced. The project format (ADR-012, ADR-014) holds the
mix and scenes, not a performance. Spec: `docs/PERFORMANCE_EVENTS.md`, schema
`contracts/performance.json`, code `frontend/lib/recording.ts`.

## Decision
A take is a separate document, `bckgrnd-msc/performance` version 1. Readers refuse an
unknown format or a newer version. It lives in memory only (`RecordingSession`): nothing
saves it, and it is never part of a project, a snapshot or an export. Only what the
engine applied becomes an event: `sceneApplied` (a `scene`, or the `fillInto` landing),
`fillStarted` (`fill`) and `buildStarted` (`rise`). Queued, canceled, rejected and
replaced requests go only to the developer log, which keeps the newest 500 entries. A
Rise canceled or replaced after it started keeps its event, with outcome `cancelled` or
`replaced`, because it was heard. `landed` means any `buildApplied`. Its `b` is 1 only
when a separate landing vector was committed, and the host's Rise never sends one.
Positions are engine song steps 0–255, with bar, beat and sixteenth derived from the
step, never from a wall clock. A step of -1 (Now, or while stopped) is placed at the
sounding step (0 when stopped) and flagged `offGrid`. `seq` gives the order. Stop,
Panic, a track change and auto-mix end the take (`stoppedBy`). Cue, seek and loop
changes keep recording. One take is one uninterrupted run of one track. After 10,000
events the take ends (`stoppedBy: "cap"`, `truncated`). The kinds `repeat`, `filter`,
`echo` and `gesture` are reserved: a v1 writer never writes them, and the v1 schema
refuses them. No engine, wasm or event-ring change.

## Consequences
+ No project format change. Because nothing saves a take, v1 can still change cheaply
  until saving ships.
+ A take holds only what was heard, so replay and export won't have to filter intent
  from fact.
- No elapsed position. Steps repeat after a wrap, a loop or a cue, and `seq` gives the
  order but not the distance. A take that crosses any of those can't be laid on a bar
  timeline yet.
- Reload or close the tab and the take is gone. Request ids only mean something inside
  one session.
- Held gestures aren't captured. A take with Beat Repeat (ADR-025), Filter Hold or Echo
  Throw in it will replay without them until a later version adds the reserved kinds.
- Only the browser host records today. The MCP can't produce a take yet.

## Alternatives rejected
- Inside the project format: it would mean a version bump and a migration for something
  that isn't the project.
- Recording every request outcome: the take would mix intent with what sounded. The
  developer log already keeps those.
- Wall-clock timestamps: they drift from the engine's onsets, and tempo changes would
  move them. Song steps are musical.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: positions were only
song steps. The Night 12 timeline needs elapsed bars, and both fixes cost more than they
would have now. Putting the engine's onset serial (`Scheduler::serial`) on the event ring
changes a ring the MCP shares. Counting onsets in the host from telemetry gives a count
the MCP can't reproduce, and it is only right if the host sees every onset. If
saving takes ships before this is settled, v1 files with no elapsed position become
permanent, and no upgrade can recover the distances they never recorded.
Early warning sign to watch for: timeline code that guesses elapsed position from `seq`
and wrap detection, or a PR that saves or exports a take while
`contracts/performance.json` still has no elapsed field.

## Amendment: version 2 (2026-11-26, extended 2026-11-27, draft)

### Context
The pre-mortem's risk came due. Night 11 exports takes (`exportTake`, and Export in the
events drawer), so a take needed an elapsed position before any file got written. Code:
`contracts/performance.json` v2, `frontend/lib/recording.ts`, and
`frontend/lib/take-schema.ts` (one validator, shared by the app and the checks). Spec:
`docs/PERFORMANCE_EVENTS.md`.

### Decision
- **Engine:** every engine event carries the onset serial `s` (`Scheduler::serial`).
  Beat Repeat reports events 61 (started) and 62 (ended). The ring is now five numbers
  wide (`507d209`).
- **Onset:** every event has `onset = s - s(first event of the take)`, and an end has
  `endOnset`. The origin is the take's first event, not the Record press, because
  telemetry carries no serial. `startedAtStep` still says where Record was pressed.
- **`pass`** is a 1-based label for people. It's stored but derived from the steps and
  onsets; `onset` is the position.
- **`repeat`** is no longer reserved. Each repeat is one event with both ends: `token`,
  `division`, `endedBy` (`engine`, `recapture`, `take` or `open`), `endStep`,
  `endOnset` and `reason`. A press released before its grid line goes only to the
  developer log. A repeat still held when the take stops gets `endedBy: "take"`, at an
  estimated end: counted forward from the last engine event to the last playing frame's
  step. `filter`, `echo` and `gesture` stay reserved.
- **Fill `length`** on `fill` and `fillInto` is the length that played (ADR-027), not
  the preference.
- **No serial, no onset:** an engine without serials gives events no `onset` or `pass`.
  Nothing is made up, and that take doesn't validate as v2.
- **Export:** a take exports as its own file with `recordedAt` (ISO 8601 UTC, a label
  and never a position). It's still never part of a project, a snapshot or a project
  export, and the project format doesn't change.
- **Versions:** v2 readers (`parseTake`) refuse v1 as well as anything newer. No v1 file
  was ever written, and v1 has no onsets.
- **`initial`** (11-27) is the state at Record: track, bpm, swing, `scene { slot | null,
  modified }`, the mix (all 17 parameter ids, plus 8 stems × volume, send, muted and
  solo), the fill style and its effective length, `repeatDivision` and `loopBars`. The
  app always writes it. A reader treats it as optional. Inside `initial.mix`, a reader
  requires no parameter or stem id, accepts ids it doesn't know, and still range-checks
  the ones it knows (`42a3bad`). So a take opens after parameters or stems are added or
  removed.
- **Opening a take** (11-27): `inst.recording.openTake(text, filename?)`, `opened`,
  `openedFile` and `closeOpened()`, with an Open button in the events drawer. It runs
  `parseTake`, then the event kinds, then the whole schema, and reports errors in plain
  English. It's view only: it never touches the live take, the transport or the engine.

`initial` is an amendment, not v3, because no v2 file has ever been pushed or released.
A bump would mean a v2-to-v3 reader path for files nobody has, so v2 stays the one
format. Opening is view only because replay is Night 13. Loading a mix without the
timing would be a half replay, and it would overwrite the performer's live state.

This replaces three v1 rules: "never part of ... an export", "no engine, wasm or
event-ring change", and the reserved `repeat`.

### Consequences
+ A timeline can lay events at `onset` across wraps, loops, cues and seeks. The v1
  warning sign (an export with no elapsed field) is answered before export ships.
+ A repeat reads straight onto a timeline lane, with nothing to pair up.
+ Replay has a start state, so Night 13 won't have to guess the mix a take began from.
+ The Arrangement drawer (`e3ef8c2`) already lays a take out by `onset`, read only, so
  it doesn't guess position from `seq`, which was v1's warning sign.
- Onset 0 is the first event, so a timeline can't place the empty bars between Record
  and that event by onset. The fix is a serial on telemetry, but that changes what
  `onset` means, so it has to land before takes are imported anywhere (PARKING_LOT,
  11-26-2026). The same serial would make a held repeat's stop exact. Until then the
  estimate is wrong if a loop, cue or seek came after the last engine event.
- The ring the MCP shares gains a column. An MCP on an older engine has no serials, so
  it can't write a valid v2 take.
- The tolerant reader means an opened take can be missing mix values, or carry ids
  this app doesn't know. That's harmless while opening is view only, but Night 13's
  replay has to decide what a missing id starts from.
- Tempo and loop now appear more than once (`bpm`, `initial.bpm` and
  `mix.params['transport.bpm']`; `loopBars` twice), and nothing checks that the copies agree.
- The v1 pre-mortem's warning sign has fired: `openTakeText` calls `parseTake` outside
  the checks, and the origin is still the first event (PERFORMANCE_EVENTS, Deferred).
  Moving the origin to the Record press now changes the meaning of files that exist.
- `pass` is stored but derived, so two writers could disagree about it.

### Alternatives rejected
- Onsets counted by the host from telemetry: the MCP can't reproduce the count, and it's
  wrong whenever the host misses a frame (v1 pre-mortem).
- A repeat as a start event and an end event: a timeline would have to pair them, and a
  lost end leaves half a repeat.
- Reading v1 files with onsets left blank: nothing can recover the distances, and no v1
  file exists.
- Making up onsets for an engine without serials: the file would look positioned when
  it isn't.
- `initial` as v3: the reader paths would cost more than the change, and no v2 file
  has been pushed or released.
- Opening that loads the take's mix: that's replay's job (Night 13), and doing it now
  would overwrite the live state.

### Pre-mortem
It is six months later and this was a mistake. Most likely reason: the origin moved
too late. Takes were imported (timeline, replay or MCP) before telemetry carried a
serial. When the origin then moved to the Record press, `onset` 0 meant two different
things in files with the same version number. Or replay filled a missing `initial.mix`
id with its default without saying so, and a replay didn't start from what was heard.
Early warning sign to watch for: the v1 sign has already fired (Open). The next one is
replay code that reads `initial.mix` with no rule for an id that's missing.
