# Night 4: pattern editing and variation — the working protocol

The specification is the Night 4 brief (pattern editing, constrained variation,
better vertical faders). This file pins down the shapes every part of the app agrees
on: the contract, the payload the engine receives, the events that come back, the
order things happen at a boundary, and how the editor, scenes and variations use
them. Where this file and the code disagree, the code is wrong.

## The rule

An edit changes the composition, not the playhead. The screen shows the edit at once.
The engine hears it at the next bar while playing, or immediately while stopped, and
the editor says which of those has happened.

## Where things live

| Thing | Lives in | Saved? |
|---|---|---|
| Working patterns (the edited lanes) | `project.patterns` (v3), `usePatternWorkspace().working` | Yes (in the project; file save is Night 5) |
| Locks | `project.locks` | Yes |
| Scene lanes | `scene.patterns`, pinned copies or `{factory: true}` | Yes |
| Undo/redo stacks, the preview candidate, selection, the bar on screen, Follow Playback | The workspace and the editor | **Never** |
| What the engine is playing | The engine's lanes, swapped at a boundary | Derived; never read back |

The contract (lanes, units, ids, provenance, migration) is in
[`contracts/README.md`](../contracts/README.md#patterns-version-3) and
[`contracts/patterns.json`](../contracts/patterns.json).

## The pattern payload

The UI compiles the lanes of one revision into a flat `Float32Array`
(`compileLanes`, `frontend/lib/patterns.ts`):

```text
[laneCount, (laneIndex, kind, n, ...data) * laneCount]
drum lane  (index 0..3, kind 0): n = 256, then 256 velocities (0 = silent)
note lane  (index 4..8, kind 1): n events of 11 floats each:
           step, len, vel, accent (0/1), count, pitch × 6 (unused = -1)
```

Lane indices follow `engine` in `contracts/patterns.json`: kick, clap, closed hat,
open hat, bass, stab, lead, pad, arp.

- `PatternSet::parse` (`engine-core/src/patterns.rs`) validates the **whole** payload
  in the worklet's message handler, outside the render callback, and refuses it whole.
  It checks every count and index, rejects a lane given twice or of the wrong kind,
  and checks velocities 0..1, steps inside the song and used once, notes that end by
  step 256, pitches 0..127 with unused slots -1, and that every float is accounted
  for. A refused payload keeps whatever was pending.
- It is the only place lanes are allocated. At the boundary the engine swaps each
  staged lane in with `std::mem::swap` and keeps the old lanes until the next
  message, so `process()` neither allocates nor frees.

## Messages (UI → worklet)

| Message | Fields | Effect |
|---|---|---|
| `patterns` | `requestId, generation, timing, data, deck?` | Stage a revision on the live deck. Coalesced like a parameter (`postParam('patterns')`): of several posted in one frame only the latest is sent, which is what "latest wins" means anyway. |
| `cancelPatterns` | `requestId` | Withdraw a pending revision; answers `patternsCancelResult`. |
| `scene` | adds `patterns?, patternsId?` | A launch's lanes, linked to the scene; queued with it (below). |
| `audition` | `bar` | Hear Bar: jump the live deck to the bar and loop it. The only action that moves the playhead to what is being edited. |

The worklet refuses a revision itself (event 35) for a malformed message, during an
auto-mix (`mixing`), for a stale deck or generation (a revision made for the
previous track), or before boot.

**Boot order.** Messages sent before the first Play are held and replayed after
`init` and the track loads, and only then the coalesced parameters. `init` goes out
through `send`, not `post`, because `post` flushes the coalesced parameters first.
Before this was fixed, an edit (or any value) made before the first Play reached the
worklet ahead of its track and was refused as stale.

## Events (worklet → UI), kinds 31–35

`[kind, requestId, a, b]`, drained with the scene events:

| Kind | Name | `a` | `b` |
|---|---|---|---|
| 31 | queued | the bar it lands on (1-based) | the step |
| 32 | applied | the step it landed on, or -1 if applied off the grid (stopped, stop, panic, a jump) | — |
| 33 | cancelled | reason | — |
| 34 | replaced | the id that replaced it | — |
| 35 | rejected | reason | — |

The reasons are Night 3's: 1 invalid, 2 stopped, 3 transport, 4 track, 5 panic,
6 mixing, 7 not playing, 9 stale, 10 user.

## Timing

- **Stopped:** a revision applies at once.
- **Playing:** a revision waits for the next bar line. Pattern edits are always sent
  with `bar` timing. A second revision before that boundary **replaces** the first
  (event 34) and **keeps the boundary**, so editing never delays a change already
  promised.
- **Stop, panic, a jump or seek (including Hear Bar):** a pending revision applies
  at once (-1). Nothing edited is lost to an interruption.
- **Loading a track:** the pending revision is cancelled (reason 4), and the
  generation check refuses any late one. An edit for one track can never reach the
  next.

## The boundary order

At an onset that carries several changes, the engine applies them in this order,
before any note on that step sounds:

1. the pending **pattern edit**;
2. the **scene**, with its linked lanes (on the same lanes, the scene's win);
3. the **fill** (start or end);
4. the step's **triggers**.

A fill plays its own bar and returns to the *latest* lanes, so an edit that landed
during the fill is what plays after it.

## Voices at a swap

Every tone voice remembers the onset step of the event that started it. When a note
lane is swapped, a voice whose event is gone or changed (different pitches or length)
is **released** through its envelope, not cut. A voice whose event is unchanged
carries on. Drum voices are one-shots and are never touched.

## The workspace (`frontend/lib/workspace.ts`)

- Every accepted edit is one **undo entry**, holding the lanes it changed before and
  after (`LaneChange`, `applyChange`, `inverseOf` in `lib/editing.ts`). A painted
  row, a velocity drag, a paste, a clear, a kept variation and a scene launch that
  set lanes each count as one. Undo and redo are themselves revisions sent to the
  engine. An undo made before the edit was heard simply replaces the pending
  revision.
- Every revision carries **every lane this session has touched**, so "latest wins"
  is exact: no revision depends on an earlier one having landed.
- The header's **Change** line follows the latest request only: Sending, Queued for
  bar N, In the music, Withdrawn (reason), or Not applied (reason).
- A new track resets everything (patterns, locks, history, preview).

## Preview, Keep, Revert

One candidate at a time. Previewing stages the candidate over the working lanes, and
the working lanes stay untouched (*source kept → prepared → queued → playing*).
**Keep** makes the candidate one undoable edit. **Revert** stages the working lanes
again. Composition edits wait during a preview. Mixing, playback, scenes and faders
do not: a fader moved during a preview stays where it was moved after Revert,
because the mix is not part of the preview.

## Scenes with lanes

- **Capture** stores a pinned copy of every lane this session edited, and
  `{factory: true}` for a lane touched and put back. Lanes nobody touched are left
  out, so a scene captured from an unedited track still launches the mix only.
- **Launch** compiles the scene's lanes at request time, so the revision that plays
  is the one launched even if the slot is captured again while it waits. They are
  queued in the engine linked to the scene, apply on the scene's boundary after any
  pending edit, and are withdrawn with it. A launch whose lanes are refused is
  rejected as a whole.
- **Applied:** the working patterns adopt the scene's lanes as one undo step
  ("Launch Drop"). A revision still on its way is re-sent on top, so the engine never
  ends up behind the screen.
- A scene reads **Modified** when its mix differs or any lane it sets differs from
  the working pattern.

## Humanize

Velocity only. Seeded, with an amount (±20% at 100%), Preserve Accents, and a range
of the bar, the part or the whole lane. It is always computed from the source (the
working lane, which a preview never touches), so trying amounts never wears a
pattern down. Locked events and lanes are untouched, and velocities stay inside
0.02..1. Provenance records `ui-humanize-velocity-1`, the seed, the settings and the
source revision.

## Variations

PHP writes them (`App\Support\Project\Variation`, generator `php-variation-1`):

```text
POST /api/variations
{ lane, from, to, strength: subtle|moderate|adventurous, seed, source: Pattern, locks, context?: Patterns }
→ { status: "ok", candidate, mode: drums|rhythm, reason, preserved: [...] }
| { status: "unavailable", reason }
422 { error } for anything malformed (read with the project's own strict readers)
```

- **Scope** is the song part on screen (four bars), shown before generating
  ("Vary: Closed hat · Bars 9–12 (Break)"), with what is preserved.
- **Same inputs, same output:** mulberry32 seeded from the seed, the lane and the
  range. **Only the range changes.** A locked lane is unavailable, and a locked event
  keeps its step and velocity.
- **Anchors hold:** kicks on the beat, backbeat claps, offbeat hats, and the first
  note of every bar.
- **Drums:** ghost hits added and removed on the lane's grid, an offbeat lift at
  Moderate and up, a flourish into the last beat, and velocity movement. A closed hat
  is never added on an open one.
- **Melodic lanes are rhythm-only:** no track records its harmony, so pitches,
  chords included, are never changed. The panel says so before generating.
- **Static build:** `tools/export-variations.php` exports, per track, every editable
  lane × part × strength × seeds 1–3, keyed by `sourceHash` of the source range. An
  entry is used only when the phrase on screen hashes the same. Otherwise the answer
  is *unavailable*, with the reason, and nothing is substituted. An entry that would
  change a locked event is refused too.

## The editor (`frontend/ui/PatternDrawer.tsx` and `frontend/ui/pattern/`)

- **Header:** Editing (lane · bar · part), Playing (bar · part, or Stopped), Change.
  Follow Playback shows the playing bar until a bar is picked or an edit starts.
- **Cells:** content is a fill (brighter means louder), selection is an outline, the
  playhead is a narrow tick. Steps 1, 5, 9 and 13 start beat groups.
- **Drums:** paint mode is decided where the gesture starts, and the release commits
  one edit. The velocity lane shows an empty marker where there is no hit; a drag
  is one edit; lowering stops at the floor and never deletes. With a multi-selection,
  Set Together and Adjust Together act on it, and the inspector takes exact numbers.
- **Notes:** click to add, drag to move, drag the right edge to resize, with 16th
  snapping. An overlap shows while dragging and is refused on release (nothing is
  shortened to make room). Chords move and transpose together. Notes carried in
  from an earlier bar, or running on past this one, say so. The song's end clamps.
  The inspector has pitch, bar, step, length, velocity, accent and lock.
- **Scoped actions** say their scope: "Copy Closed hat · Bar 9", "Clear Drums · Bar
  9", "Duplicate … to bar 10" (never wraps), "Paste … over …" (replaces).
- **Keys:** inside the editor, digits do not cut stems and Space on a step toggles
  the step. Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z (or Ctrl+Y) undo and redo.
- **Phone:** eight steps at a time with prev/next through half bars, real step
  numbers.

## Checks

| Check | Covers |
|---|---|
| `cargo test` (`patterns.rs`, `pattern_tests.rs`, `tests/contract.rs`) | Parse/refuse, boundary landing without moving the playhead, latest wins, interruptions, a new track withdraws, empty lane = silence, release on change, fill returns to the latest lanes, scene lanes and the boundary order |
| `pnpm check:editing` | Undo exactness, one revision per gesture, the velocity floor, paste/duplicate/overlap rules, chords, humanize determinism and locks |
| `pnpm check:contract` | v3 fixtures, PHP/TS factory and `sourceHash` parity |
| PHPUnit `VariationTest`, `VariationApiTest` | Seeded determinism, range, locks, anchors, open/closed hats, rhythm-only melodic, 422s |
| `pnpm verify:editor` | The Night 4 demonstration in the browser |
| `pnpm verify:audio` | An edit sent mid-bar is heard from the next bar; a malformed one changes nothing |
| `pnpm verify:static` | The catalog varies the factory phrase; a changed phrase is unavailable |
