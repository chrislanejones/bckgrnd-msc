# Night 11 and 11B: one-beat fills, take files and a timeline preview

Status: **built on `night11/run`, 11-26-2026 (Night 11) and 11-27-2026 (Night 11B).** No one
has listened to it yet. Chord editing moved again.

The aim: perform a song with scenes, short fills, Rise and Beat Repeat, save the
performance as a take file, open it again later, and see it laid out on a timeline.

## What was built

| Piece | Where | Detail |
|---|---|---|
| **One-beat fills** | `Fills.php`, `fills.rs`, `scheduler.rs`, `fills.ts` | Dedicated PHP recipes beside the track (`beatFillStyles`). The engine plays fill length 1 on the bar's last beat (4 steps). Bar is the default. ADR-027 |
| Styles and modes | `fills.ts`, `instrument.ts` | Classic, Simple, Busy, Syncopated, Random and Rotate work at either length. A queued fill keeps its length |
| Linked fills | engine `build.rs`, host | Fill into Drop and Rise with Fill at Beat length. The scene lands on the same line as with Bar |
| Fill length control | `SceneStrip.tsx` | One pill: **Fill [style ▾ \| Bar \| Beat]**, 24 px with a mouse, 44 px on touch |
| **Repeat events** | engine, worklet | 61 repeat started and 62 repeat ended, with the song step and the division or a reason |
| **Onset serial** | engine event ring | Every event carries the scheduler's monotonic onset count, so positions don't repeat across song loops |
| **Take v2** | `contracts/performance.json`, `recording.ts` | Repeat events, `onset` and `pass` on every event, `length` on fills, `recordedAt` |
| **JSON export** | `inst.recording.exportTake()` / `downloadTake()` | A standalone, versioned file `bckgrnd-take-<track>-<date>.json`. No project format change |
| **Events drawer** | `EventsDrawer.tsx` | Collapsed by default, beside Record. Lists the take's events, with Export and Clear. Esc closes it |
| **State at Record** (11B) | `recording.ts`, `contracts/performance.json` | `initial`: track, bpm, swing, active scene, the whole mix (17 parameters, 8 stems), fill style and length, repeat division, loop. An amendment to v2: always written, optional to read |
| **Opening a take** (11B) | `inst.recording.openTake()`, `EventsDrawer.tsx` | Open a `.json` take in the events drawer. View only: the live take, transport and engine are untouched. Plain-English errors for a bad file. One validator, `frontend/lib/take-schema.ts` |
| Tolerant reader (11B) | `contracts/performance.json` | A take still opens after a mix parameter or stem is added or removed |
| **Arrangement timeline** (11B) | `ArrangementDrawer.tsx` | A read-only bottom sheet, opened from the events drawer's Timeline button. Bars 1…N of the take on onsets, lanes for Scenes, Fills, Rise and Repeat, click to inspect, zoom 8–256 px per bar, keyboard steps through events |

Contracts: [PERFORMANCE_EVENTS.md](PERFORMANCE_EVENTS.md) (take v2, `initial`, opening a take),
[NIGHT8_PROTOCOL.md](NIGHT8_PROTOCOL.md) (fill length), [NIGHT10_PROTOCOL.md](NIGHT10_PROTOCOL.md)
(repeat events). ADR-027 (beat fills) and the ADR-026 amendment (take v2) are drafts.

## Rules kept

| Rule | How |
|---|---|
| The engine owns musical timing | Beat fills, the repeat grid line and the onset serial all come from Rust |
| Nothing allocates on the audio path | no_alloc covers beat fills and the repeat events |
| Renders don't change unless a new feature plays | **120/120** renders bit-identical to main 5e2e809 (plain, Rise, bar fills); **160/160** to 5ce2fba including a heavy Beat Repeat pass. MCP parity 48/48 |
| A take is not part of a project | Export and Open use their own file; the project format is unchanged |
| Opening a take is view only | Nothing reaches the engine; replay is Night 13 |
| The toolbar stays 70 px collapsed | Measured at 1440, 1280, 1180 and 900, with the drawer open and closed |

## Deferred

| Item | To |
|---|---|
| Chord editing | Night 12 or later |
| Editing the timeline (move, remove, duplicate) | Night 12 |
| Replay of a take | Night 13 |
| Showing `initial` in the timeline inspector | Night 12 |
| Arrangement WAV export | Night 14 |
| Recording Filter, Echo and platter gestures | Night 12 (reserved in v2) |

## Roadmap

| Night | Focus |
|---|---|
| 11 | Short fills and recording export |
| **11B** | Take files and a timeline preview |
| 12 | Editable arrangement timeline: move, remove and duplicate events |
| 13 | Replay: play the recorded arrangement |
| 14 | Arrangement WAV export |
| 15 | MCP arrangement generation |
| 16 | Release polish: more tracks and final testing |
