# Contracts

The data shapes that more than one program reads. The UI, saved projects, exports and
the MCP companion ([bckgrnd-msc-mcp](https://github.com/chrislanejones/bckgrnd-msc-mcp))
should all agree on these files. None of them should keep a private copy.

| File | What it is | Read by |
|---|---|---|
| [`parameters.json`](parameters.json) | Every engine parameter: id, range, default, unit, scope, and the worklet message that sets it. | `frontend/lib/contract.ts`, `App\Support\Project\Contract`, and the MCP from Night 6 |
| [`project.schema.json`](project.schema.json) | A saved project, version 1. | The same, plus anything that writes a project file |

## Saved data vs. telemetry

Two kinds of state, never mixed.

| | **Project (saved musical data)** | **Telemetry (transient playback)** |
|---|---|---|
| What | Track, tempo, swing, stem levels, cuts and solos, master and effects settings, and later pattern edits. | Meters, the playhead step, playing or stopped, which deck is live, whether a mix is running, master peak. |
| Where it comes from | The user's intent. | The audio thread, about 30 times a second. |
| Shape | `project.schema.json` | The worklet's `Float32Array` frame, laid out in `frontend/worklets/engine-processor.ts` |
| Saved, undone, exported? | Yes | **Never** |

A parameter's `scope` says which side it is on:

- `project`: part of the song as the user has shaped it. Saved.
- `performance`: a gesture in the moment (loop, echo throw). Not saved. Scenes in
  Night 3 may record these as cues, but a project never reopens mid-gesture.

## Parameters

```jsonc
{
  "id": "fx.filter",         // stable forever; projects key on it
  "kind": "continuous",      // continuous | enum | toggle
  "min": 0, "max": 1,        // what the engine accepts
  "control": { ... },        // optional narrower range the UI offers
  "default": 1,              // a number; "track" for the track's own value; "stem"
                             // for each stem's own (listed in "defaults")
  "taper": "engine",         // how a control spreads the range: linear, log, db, or
                             // the engine's own curve
  "scope": "project",
  "engine": "filter"         // the worklet message type
}
```

Ids never change meaning. To change a parameter's meaning, add a new id and migrate.

## Projects

```json
{
  "format": "bckgrnd-msc/project",
  "version": 1,
  "name": "Warehouse, no drums",
  "trackId": "warehouse",
  "params": { "transport.bpm": 124, "fx.filter": 0.6 },
  "stems": { "kick": { "volume": 0.9, "send": 0, "muted": true, "solo": false } },
  "patterns": {}
}
```

- A missing `params` key or stem field means its default. A project only needs to
  carry what differs, but writers may write everything.
- `patterns` is reserved for Night 4 and must be empty in version 1.
- Readers **reject** an unknown `format` or a newer `version`. They never guess.
  Readers **upgrade** older versions through a migration, and a migration never drops
  data it doesn't understand silently.

### Migrations

| From | To | How |
|---|---|---|
| Legacy preset (`PresetController`, no `format`) | v1 | `trackId`, `bpm`, `swing` → `transport.*`; `mix`/`muted`/`solo` → `stems`. Effects take their defaults, because legacy presets never stored them. |
| MCP `MixSettings` (bckgrnd-msc-mcp `src/settings.ts`) | v1 (Night 6) | `track` → `trackId`; `cut[]` → `stems.*.muted`. Its loudness, ducking and fades are render settings for mixing under a voice, not musical data. They stay in the MCP's own presets. |

The engine's own defaults and ranges are held against the registry too
(`engine-core/tests/contract.rs`), so "default" on a knob is the engine's default.

Both implementations live next to their readers: `migrateProject()` in
`frontend/lib/contract.ts` and `Contract::migrate()` in
`app/Support/Project/Contract.php`. `tests/Unit/ContractTest.php` keeps them honest.
