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

## Amendment: version 2 (2026-11-26, draft)

### Context
The pre-mortem's risk came due. Night 11 exports takes (`exportTake`, and Export in the
events drawer), so a take needed an elapsed position before any file got written. Code:
`contracts/performance.json` v2, `frontend/lib/recording.ts`,
`tools/performance-schema.mjs`. Spec: `docs/PERFORMANCE_EVENTS.md`.

### Decision
- **Engine:** every engine event carries the onset serial `s` (`Scheduler::serial`).
  Beat Repeat reports events 61 (started) and 62 (ended). This is Silas's part and is
  landing separately. At 171bad6, `EVENT_WIDTH` is still 4.
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

This replaces three v1 rules: "never part of ... an export", "no engine, wasm or
event-ring change", and the reserved `repeat`.

### Consequences
+ A timeline can lay events at `onset` across wraps, loops, cues and seeks. The v1
  warning sign (an export with no elapsed field) is answered before export ships.
+ A repeat reads straight onto a timeline lane, with nothing to pair up.
- Onset 0 is the first event, so a timeline can't place the empty bars between Record
  and that event by onset. The fix is a serial on telemetry, but that changes what
  `onset` means, so it has to land before takes are imported anywhere (PARKING_LOT,
  11-26-2026). The same serial would make a held repeat's stop exact. Until then the
  estimate is wrong if a loop, cue or seek came after the last engine event.
- The ring the MCP shares gains a column. An MCP on an older engine has no serials, so
  it can't write a valid v2 take.
- The app itself doesn't enforce the validation rule. `exportTake` writes whatever the
  session holds, and `parseTake` checks only the header. Only the schema in the checks
  (`tools/performance-schema.mjs`) refuses a v2 file with no onsets.
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

### Pre-mortem
It is six months later and this was a mistake. Most likely reason: the origin moved
too late. Takes were imported (timeline, replay or MCP) before telemetry carried a
serial. When the origin then moved to the Record press, `onset` 0 meant two different
things in files with the same version number. Or a browser export from an engine
without serials got saved and shared as v2, and the reader took it in because only the
header was checked.
Early warning sign to watch for: a `parseTake` caller outside the checks while
telemetry still has no serial, or an exported take whose events have no `onset`.
