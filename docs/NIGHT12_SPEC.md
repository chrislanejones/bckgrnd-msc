# Night 12: the arrangement editor

Status: **built on `night12/run`, 11-28-2026.** No one has listened to anything yet. No
replay or audio: an edited arrangement is saved and reopened, not played (Night 13).

The aim: record a performance, rearrange its musical events, and save the edited
arrangement, without ever changing the take it came from.

## What was built

| Piece | Where | Detail |
|---|---|---|
| **Working arrangement** | `frontend/lib/arrangement.ts`, `contracts/arrangement.json` | Its own document, `bckgrnd-msc/arrangement` v1. Events sit at `at`, a step from bar 1 that never wraps. ADR-028 (draft) |
| Linked events folded | same | Fill into Drop is one `fill` with `into`; Rise with Fill is one `rise` with `withFill`; a Beat Repeat's start and end are one span. Nothing can be orphaned |
| From a take | `fromTake()` | Bar 1 on the first event's bar line. Canceled Rises are dropped, fills cut short become whole, recaptured repeats chain. Each choice is listed in plain English (`notes`). At least 16 bars, with 4 bars of room past the take |
| **Snapping** | `snapAt`, `effectiveGrid` | Bar, Beat or 1/16, never finer than the kind allows: scene 1/16, fill and Rise a bar, repeat its division |
| **Conflict rules** | `validate()` | Two scene changes on one step, a scene change inside a Rise, overlapping Rises, fills or repeats, a landing past the end. An edit that would break one is refused with the reason |
| **Undo and redo** | `ArrangementEditor` | Immutable snapshots, 200 steps, with the selection |
| **Editor UI** | `ArrangementDrawer.tsx` | Take or Edit; one toolbar row: + Scene, + Fill, Duplicate, Delete, Undo, Redo, Snap, Save, Open, shortcuts. Drag with a snapping ghost; a refused drop springs back with the reason. An inspector that edits the selection |
| Keyboard | same | ←/→ nudge, Shift a bar, Alt+←/→ between events, Delete, Ctrl/⌘+D, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z or Ctrl+Y, Esc |
| Resizable drawer | same | Drag or arrow keys, 180 px up to the window, remembered. Lanes 30 px |
| **Files** | `save()`, `open()` | `bckgrnd-arrangement-<track>-<date>.json`. Open also takes a take v2 file and converts it. Project and take formats unchanged |
| **Stale telemetry after Panic** | `engine.ts`, `engine-processor.ts` | Transport commands carry a serial the worklet echoes; a telemetry frame older than the newest command is dropped |

## Rules kept

| Rule | How |
|---|---|
| The take is never edited | The arrangement is a copy; the take stays byte-identical after edits (checked) |
| A working arrangement is always valid | Conflicting edits are refused; an opened file may list conflicts |
| No replay or audio | Nothing in the arrangement reaches the engine |
| The toolbar stays 70 px collapsed | Measured at 1440, 1280, 1180 and 900, editing and not |
| No page scroll | Page height unchanged with the drawer open, at every width |
| Touch targets | 44 px on the phone, with ◀ ▶ nudge in the inspector |

## Deferred

| Item | To |
|---|---|
| Playing an arrangement | Night 13 |
| WAV export of an arrangement | Night 14 |
| Setting an arrangement's length | Later; 16 bars or 4 past the take for now |
| Split, multi-select, copy and paste | Later |
| MCP resync for `contracts/arrangement.json` | When this PR merges; the MCP doesn't read arrangements |

## Roadmap

| Night | Focus |
|---|---|
| 11 / 11B | Short fills, take files, timeline preview |
| **12** | Editable arrangement |
| 13 | Play an arrangement |
| 14 | Arrangement WAV export |
| 15 | MCP arrangement composition |
| 16 | Release polish and more tracks |
