# Night 11: one-beat fills and recording a performance

Status: **built on `night11/run`, 11-26-2026.** No one has listened to it yet. Chord editing
moved again, to keep the morning to about 110 minutes.

The aim: a song you can perform with scenes, short fills, Rise and Beat Repeat, then save
a record of the performance as JSON. That record is what the Night 12 timeline reads.

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

Contracts: [PERFORMANCE_EVENTS.md](PERFORMANCE_EVENTS.md) (take v2),
[NIGHT8_PROTOCOL.md](NIGHT8_PROTOCOL.md) (fill length), [NIGHT10_PROTOCOL.md](NIGHT10_PROTOCOL.md)
(repeat events). ADR-027 (beat fills) and the ADR-026 amendment (take v2) are drafts.

## Rules kept

| Rule | How |
|---|---|
| The engine owns musical timing | Beat fills, the repeat grid line and the onset serial all come from Rust |
| Nothing allocates on the audio path | no_alloc covers beat fills and the repeat events |
| Renders don't change unless a new feature plays | Bypass hashes for Beat Repeat and beat fills against main |
| A take is not part of a project | Export is its own file; the project format is unchanged |
| The toolbar stays 70 px collapsed | Measured at 1440, 1280, 1180 and 900, with the drawer open and closed |

## Deferred

| Item | To |
|---|---|
| Chord editing | Night 12 or later |
| Arrangement timeline | Night 12 |
| Replay of a take | Night 13 |
| Arrangement WAV export | Night 14 |
| Recording Filter, Echo and platter gestures | Night 12 (reserved in v2) |
| Importing a take | Night 13 (`parseTake` exists; nothing calls it) |

## Roadmap

| Night | Focus |
|---|---|
| **11** | Short fills and recording export |
| 12 | Arrangement timeline |
| 13 | Replay recorded performances |
| 14 | Arrangement WAV export |
| 15 | AI/MCP arrangement generation |
| 16 | New genres and release polish |
