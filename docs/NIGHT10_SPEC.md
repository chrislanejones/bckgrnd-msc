# Night 10: Beat Repeat and the recording foundation

Status: **built on `night10/run`, 11-25-2026.** No one has listened to it yet. Beat Repeat was
the main deliverable and the recording foundation came second. One-beat fills moved
to Night 11.

## What was built

| Piece | Where | Detail |
|---|---|---|
| **Beat Repeat** | `engine-core/src/repeat.rs`, `gesture.rs` | Gesture kind 3. It loops the pre-master feed at 1/4, 1/8 or 1/16 (default **1/8**). It engages on the next grid line, its seams dip for 2.5 ms, and a release crossfades back over 8 ms |
| Division | `set_repeat_division`, localStorage `bckgrnd-msc:repeat-division` | A live setting. It isn't in the scene vector, the project or a render |
| What ends it | Engine and host | Release, Release FX, Panic, Stop, a track change, pointer cancel, a key release, window blur, and a brake, backspin or scratch (event 21, `b = 1`) |
| Bypass | `repeat_tests.rs`, 80 renders | **Bit-identical** when Repeat isn't held |
| **Performance events v1** | `contracts/performance.json`, `docs/PERFORMANCE_EVENTS.md` | `sceneApplied`, `fillStarted`, `buildStarted` at engine song steps, with `seq` and `offGrid` |
| Recording session | `frontend/lib/recording.ts`, `inst.recording` | Start, Stop and Clear, in memory only. A developer log is on `window.__BCKGRND_RECORDING__` |
| **Performance surface** | `app.tsx`, `HoldFx.tsx`, `TransportBar.tsx` | Scenes and Deck share one surface, there's a Hold FX row (Echo, Filter, Repeat), and pads have four states (rest, queued, active, held) |

Contracts: [NIGHT10_PROTOCOL.md](NIGHT10_PROTOCOL.md) (gesture kind 3),
[PERFORMANCE_EVENTS.md](PERFORMANCE_EVENTS.md) (events v1), ADR-025 (Beat Repeat),
ADR-026 (recording contract). Both ADRs are drafts.

## Rules kept

| Rule | How |
|---|---|
| The engine owns musical timing | The grid line, slice length and release all run in Rust. The host only sends begin and end |
| Nothing allocates on the audio path | The repeat buffer is sized once for a quarter note at 36 BPM (about 1.6 MB per engine at 48 kHz). no_alloc covers it |
| A render doesn't change while Repeat is off | 80 of 80 bypass renders are bit-identical, and MCP parity is rechecked after the resync |
| A take is not part of a project | No project format change, nothing saved, nothing exported |
| Only applied events are recorded | A queued or canceled request is never in a take |

## Deferred

| Item | To | Why |
|---|---|---|
| One-beat fills | Night 11 | Parked on `night10/beat-fills` (db3a946), untested |
| Replay of a take | Night 13 | Needs the timeline first |
| Elapsed position | Night 12 | Song steps wrap and jump. Needs an onset counter on the event ring (shared with the MCP) or host-side counting |
| Recording Repeat, Filter, Echo and gestures | Night 12 | The kinds are reserved in v1 and refused today |
| Saving or exporting a take | Night 14 | v1 is in memory only |

## Roadmap

| Night | Focus | What exists at the end |
|---|---|---|
| **10B** | Beat Repeat and the recording foundation | A held stutter in time, and a versioned record of what was performed |
| 11 | One-beat fills and chord editing | Beat-length fills on the phrase line; chords that can be edited in the pattern editor |
| 12 | Performance timeline and editing | Recorded events on lanes (Scenes, Rise, Fills, Repeat, Filter), with an elapsed position |
| 13 | Replay recorded performances | A take plays back through the engine, in time, with the same outcomes |
| 14 | Arrangement WAV export | A performed or edited arrangement renders to WAV |
| 15 | MCP arrangement generation and rendering | The MCP builds and renders arrangements on the same engine |
| 16 | New genres and tracks | More of the library to perform with |
