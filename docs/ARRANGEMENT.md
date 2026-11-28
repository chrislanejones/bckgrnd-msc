# The working arrangement, version 1

An arrangement is an editable document made from a performance take, or started empty.
It is **not** the take: the take stays exactly as recorded (`docs/PERFORMANCE_EVENTS.md`),
and converting it never changes it. It is not part of a project either: the project
format and take v2 are unchanged. The schema is
[`contracts/arrangement.json`](../contracts/arrangement.json); the code is
`frontend/lib/arrangement.ts`. Where this file and the code disagree, the code is wrong.

There is no replay and no audio. This is the editing model the arrangement editor
binds to.

## The document

```json
{
  "format": "bckgrnd-msc/arrangement",
  "version": 1,
  "track": "warehouse",
  "bpm": 124,
  "stepsPerBar": 16,
  "lengthBars": 16,
  "source": { "track": "warehouse", "recordedAt": "2026-11-26T21:07:00.000Z", "events": 10 },
  "initial": { "track": "warehouse", "bpm": 124, "…": "the take's initial, as it was" },
  "createdAt": "2026-11-28T05:45:00.000Z",
  "events": [
    { "id": "e1", "kind": "scene", "at": 4, "slot": "sparse", "crash": false },
    { "id": "e2", "kind": "fill", "at": 16, "style": "busy", "length": "bar" },
    { "id": "e3", "kind": "fill", "at": 44, "style": "simple", "length": "beat" },
    { "id": "e4", "kind": "fill", "at": 64, "style": "classic", "length": "bar", "into": "drop", "crash": true },
    { "id": "e5", "kind": "rise", "at": 96, "slot": "build", "bars": 2, "withFill": true, "crash": false },
    { "id": "e6", "kind": "repeat", "at": 160, "division": 8, "length": 16 }
  ]
}
```

| Field | Meaning |
|---|---|
| `track`, `bpm` | The track, and the tempo (the take's `initial.bpm`, else its `bpm`). |
| `stepsPerBar` | 16. |
| `lengthBars` | The length. Every event, span and landing sits before `lengthBars * 16`. 1 to 1024. |
| `source` | The take it was made from (`track`, `recordedAt`, its event count), or null for one started empty. |
| `initial` | The take's state at Record (same shape as take v2's `initial`), when it had one. An empty arrangement takes the mix as it is when started. Optional. |
| `createdAt` | ISO 8601 UTC. A label, never a position. |
| `events` | Sorted by `at`. |

Readers refuse another format, another version and a schema miss. Version 1 is the only
version.

### Positions

`at` is an integer step from the arrangement's start: bar 1 beat 1 is 0, bar 2 is 16.
Positions **never wrap**: there are no song steps, passes or onsets here, only the
arrangement's own time. Every event has a stable string `id`, unique in the document.

### Events: linked pairs are one event

A take records linked actions as separate events (a fill and its Fill into landing; a
Rise and its fill; a repeat and its recaptures). An arrangement folds each pair into one
event, so an orphan (a landing without its fill, a Rise's fill without its Rise) can't
exist.

| Kind | Fields | Starts on | Occupies | Changes the scene at |
|---|---|---|---|---|
| `scene` | `slot`, `crash` | any sixteenth | its step | `at` |
| `fill` | `style` (or null), `length` (`bar`, `beat`), `into?` (a slot), `crash?` (the landing's, only with `into`) | a bar line (bar fill), beat 4 of a bar, `bar + 12` (beat fill) | 16 steps (bar), 4 (beat) | with `into`: the next bar line after `at` |
| `rise` | `slot`, `bars` (2, 4, 8), `withFill`, `crash` | a bar line | `bars * 16` steps; with Fill, its fill plays the last bar | its landing, `at + bars * 16` |
| `repeat` | `division` (4, 8, 16), `length` (steps, at least 1) | its division's line (every 4, 2 or 1 steps) | `length` steps | (none) |

Slots are `full`, `sparse`, `build` and `drop`.

## Snapping

Snap is `bar` (16 steps), `beat` (4) or `sixteenth` (1). It is a preference per viewer,
`bckgrnd-msc:arrangement-snap` in localStorage, `bar` by default. Each kind also has its
own finest grid: scene 1/16, fill a bar (a beat fill at bar + 12), Rise a bar, repeat its
division. **An event moves on the coarser of the two.** So a scene with Beat snap moves
by beats, a bar fill always moves by bars, a beat fill always sits on beat 4, and a 1/16
repeat with Beat snap moves by beats. Snapping goes to the nearest place, never before
the first.

## Conflicts

`validate(a)` lists every conflict as `{ ids, message }`, in plain English, for example
"Two scene changes at bar 6.1: Scene Full and the Classic fill into Drop landing."

| Rule | Counts |
|---|---|
| Two scene changes on one step | scenes, Fill into landings, Rise landings |
| A scene change inside a Rise | any of those from the Rise's start up to (not including) its landing |
| Overlapping Rises | their spans |
| Overlapping fills | fills, and a Rise + Fill's last bar: one fill plays at a time |
| Overlapping repeats | their spans |
| Past the end | an event at or after the end, a span running past it, a Fill into or Rise landing at or after it |
| Off its grid | an event not on its kind's own grid (an opened file) |
| Duplicate ids | an opened file |

**An edit that would add a conflict is refused** (`{ ok: false, reason }`) and changes
nothing, so the working arrangement never gets worse. An opened file that has conflicts
still opens, with them listed; edits elsewhere are allowed, and so is any edit that fixes
one.

## Converting a take

`fromTake(take)` returns `{ arrangement, notes }`. `notes` says, in plain English, what
the conversion changed, for the UI to show.

- **Bar 1** is the bar line of the first event's song bar, the same mapping as the
  timeline: `at = onset + (first.step % 16) - first.onset`.
- **What was heard is kept.** A scene keeps its sixteenth (a Now launch too). A fill cut
  short keeps its start and becomes a whole fill, with a note. A Rise still rising when
  the take stopped is kept as asked, with a note, and the length covers its landing.
- **Fill into** (its fill and its landing) becomes one `fill` with `into` and the
  landing's `crash`. A landing whose fill is not in the take becomes a scene, with a note.
- **Rise + Fill**: the Rise's fill folds into the `rise` (`withFill`).
- **A Rise canceled or replaced mid-rise is left out**, with a note. Take v2 records no
  step for a cancel or a replace, so where it stopped isn't known; keeping it would mean
  inventing an end.
- **Repeats**: a repeat recaptured on the same hold (`endedBy: "recapture"`) chains into
  one span from its first start to its last end, at the first capture's division. A
  division change while held is noted. A repeat still held at the take's end runs to it.
- **Off the grid**: a cue, seek or loop can move the song's bar lines against the
  onsets; an event that lands off its kind's grid snaps to the nearest place, with a note.
- `lengthBars` covers the last event, span or landing, and the take's last end, plus 4 bars of
  room to keep composing, rounded up to a 4-bar phrase, and never under 16 bars.

## The editor

`ArrangementEditor` holds immutable snapshots: every edit makes a new document, and the
host's `working` is a new object after every change. Undo and redo keep 200 steps and
restore the selection with the document. A refused edit adds no step.

| Operation | Does |
|---|---|
| `move(id, at)` | Moves it to `at`, snapped. |
| `nudge(id, dir, by?)` | One grid place earlier (-1) or later (1), by the snap or `by`. |
| `remove(id)` | Removes it; the selection moves to its neighbor. |
| `duplicate(id)` | A copy at the next free place after it on its grid, or refused if none before the end. |
| `insert(kind, at, props?)` | A `scene` (the slot after the one sounding there, so Full, then Sparse...) or a `fill` (the current Fill style and length), snapped. |
| `update(id, props)` | Changes its own fields: a scene's `slot`, `crash`; a fill's `style`, `length`, `into` (null removes it, and its crash), `crash`; a Rise's `slot`, `bars`, `withFill`, `crash`; a repeat's `division`, `length`; anything's `at`. A change of grid snaps. |

Each returns `{ ok: true, id? }` (the event now selected) or `{ ok: false, reason }`.

## Files

`exportArrangement(a)` gives `{ filename, json }`:
`bckgrnd-arrangement-<track>-<YYYY-MM-DD-HHmm>.json`, in local time when saved.
`openArrangementText(text)` opens an arrangement (version 1), or a **take v2 file**,
converted with `fromTake`. It refuses, in plain English:

| A file that | Says |
|---|---|
| is not JSON | "Not an arrangement or a take: not JSON." |
| is a project | "This is a project file. Open it with Open project; an arrangement is its own file." |
| has another format | "Not an arrangement or a take." |
| is a newer version | "This arrangement is version 2, newer than this app reads (1)." |
| is an older version | "This arrangement is version 0; this app reads version 1." |
| misses the schema | "This arrangement doesn't match the arrangement format (events[0].slot: …)." |
| repeats an id | "Two events share the id e1: ids must be unique." |
| is a take that can't open | "This take can't be arranged: Event 1 has no onset, …" |

The schema check is `frontend/lib/take-schema.ts`, the same validator as a take's.

## The host

`useInstrument()` returns, reactive like `inst.recording`:

```ts
inst.arrangement: {
  working: Arrangement | null;
  dirty: boolean;                 // changed since made, opened or saved
  conflicts: Conflict[];          // { ids, message }
  notes: string[];                // from the conversion or the open
  canUndo: boolean;
  canRedo: boolean;
  snap: Snap;                     // 'bar' | 'beat' | 'sixteenth'
  selected: string | null;
  setSnap(s: Snap): void;         // remembered
  select(id: string | null): void;
  fromTake(): Result;             // inst.recording.opened ?? the live take; never changes it
  startEmpty(): Result;           // the current track, 16 bars, the mix as it is
  move(id, at): Result;
  nudge(id, dir: -1 | 1, by?: Snap): Result;
  remove(id): Result;
  duplicate(id): Result;
  insert(kind: 'scene' | 'fill', at, props?): Result;
  update(id, props): Result;
  undo(): boolean;
  redo(): boolean;
  save(): boolean;                // downloads it; no longer dirty
  exportArrangement(): { filename: string; json: string } | null;
  open(text: string, filename?: string): Result;   // an arrangement, or a take v2 file
  close(): void;
}
```

`Result` is `{ ok: true; id?: string } | { ok: false; reason: string }`. For drawing,
`frontend/lib/arrangement.ts` also exports `spanOf(e)`, `landingOf(e)`, `sceneChanges(a)`,
`describeArrangementEvent(e)`, `eventName(e)`, `placeLabel(at)`, `snapAt(e, at, snap)` and
`effectiveGrid(e, snap)`. `window.__BCKGRND_ARRANGEMENT__()` returns the editor, for the
console and the checks.

## Checks

`node tools/check-arrangement.mjs` covers the conversion, snapping, every conflict rule,
duplicate, undo and redo, and save → open with its refusals. With `--mutants` (as
`verify-suite` runs it) it also runs every check against 22 broken copies of the module
and fails unless each one is caught.
