# ADR-026: A performance take is its own versioned contract of applied events at engine song steps, outside the project format
Date: 2026-11-25   Status: draft

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
