# ADR-028: A working arrangement is its own v1 document, made from a take and never the take
Date: 2026-11-28   Status: draft

## Context
Night 12 makes a performance editable. A take (ADR-026 v2) is a record of what the
engine applied. Its positions are song steps plus onsets that start at its first event,
it stores linked actions as separate events (a fill and its Fill into landing, a Rise
and its fill, a repeat and its recaptures), and it keeps what was heard, cut-short fills
and canceled Rises included. Editing that in place would break the one guarantee a take
has: it's what happened. Spec: `docs/ARRANGEMENT.md`. Schema:
`contracts/arrangement.json`. Code: `frontend/lib/arrangement.ts`.

## Decision
An arrangement is a separate document, `bckgrnd-msc/arrangement` version 1. It's made
from a take by `fromTake`, which never changes the take, or started empty. It's not part
of a project, and neither the project format nor take v2 changes.

- **Positions:** every event has `at`, an integer step from bar 1 (0), which never
  wraps. There are no song steps, passes or onsets.
- **Linked pairs are one event:** a Fill into is a `fill` with `into`, a Rise + Fill is
  a `rise` with `withFill`, and a repeat is one span (`length`). So an orphan can't
  exist.
- **Always valid while editing:** `validate` lists every conflict in plain English. An
  edit that would add one is refused with a reason and changes nothing. An opened file
  may still carry conflicts: they're listed, and edits elsewhere or edits that fix one
  are allowed.
- **Conversion** keeps what was heard and reports each choice in `notes`. A Rise
  canceled or replaced mid-rise is dropped, because take v2 has no step for the cut. A
  fill cut short becomes a whole fill. Recaptured repeats chain into one span at the
  first division. Events that land off their grid are snapped.
- **Snapping:** each kind has its own grid (scene 1/16; bar fill and Rise a bar; beat
  fill bar + 12; repeat its division). An event moves on the coarser of that grid and
  the viewer's Snap (`bckgrnd-msc:arrangement-snap`, default `bar`).
- **History:** immutable snapshots, 200 undo and redo steps with the selection. A
  refused edit adds no step.
- **Files:** save writes `bckgrnd-arrangement-<track>-<YYYY-MM-DD-HHmm>.json`. Open reads
  an arrangement v1, or a take v2 file converted by `fromTake`. The schema check is
  `frontend/lib/take-schema.ts`, the same as for takes.
- **`initial`** is copied from the take as it was. Its schema is the take contract's,
  word for word (`check-arrangement` compares them), so it inherits ADR-026's rule: a
  reader requires no mix id and accepts unknown ones.
- **Replay (Night 13) will read arrangements, not takes.** A take reaches replay by
  converting it first.

## Consequences
+ The take stays a faithful record however much the arrangement is edited.
+ No arrangement can hold a half-linked pair, and an edited one never has an overlap,
  so replay won't have to resolve either.
+ One time base (`at`) with no wraps or passes: the editor and replay read positions
  straight off.
- The conversion loses information. Canceled Rises disappear, cut fills become whole,
  and a division change while held collapses into one division. An arrangement made
  from a take doesn't sound like the take until replay can say otherwise.
- A third performance-shaped contract, after the project and the take. `initial`,
  `stemSettings` and `fillLength` are now copied in two schemas, kept equal only by a
  check.
- The missing-mix-id question (PARKING_LOT, "Replay needs a rule for a missing
  `initial.mix` id") moves from takes to arrangements, and it now also covers an empty
  arrangement, which takes the live mix.
- "Arrangement" now means three things: the track's `TrackArrangement`, the Night 11B
  Arrangement drawer (a timeline of a take), and this document.

## Alternatives rejected
- **Editing the take in place:** the take would stop being what was heard. Every edit
  would also have to invent song steps, onsets and passes the engine never reported.
- **Keeping linked pairs as separate events with link ids:** every move, delete and
  undo would have to keep both halves in step. One missed path leaves an orphan landing,
  the failure ADR-021 exists to prevent.
- **Allowing invalid states with warnings:** replay would have to decide what two scene
  changes on one step, or overlapping fills, mean. Refusing at the edit keeps that
  decision out of the audio path. Opened files are the one exception, so a file with
  conflicts still opens.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the conversion was
too lossy. Performers wanted the canceled Rise or the cut fill they actually played,
and "replay reads arrangements" meant replay could never reproduce a take as heard. The
fix needs either a cut step in the take (v3) or arrangement events that model partial
actions, which would bring back the invalid states this ADR refuses. Or replay landed
without a rule for missing mix ids, and an arrangement started from defaults instead of
what was heard.
Early warning sign to watch for: a request to "replay this take exactly", or `notes`
that routinely list dropped Rises or whole-ified fills.
