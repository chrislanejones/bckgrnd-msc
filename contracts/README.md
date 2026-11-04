# Contracts

The data shapes that more than one program reads. The UI, saved projects, exports and
the MCP companion ([bckgrnd-msc-mcp](https://github.com/chrislanejones/bckgrnd-msc-mcp))
should all agree on these files. None of them should keep a private copy.

| File | What it is | Read by |
|---|---|---|
| [`parameters.json`](parameters.json) | Every engine parameter: id, range, default, unit, scope, and the worklet message that sets it. | `frontend/lib/contract.ts`, `App\Support\Project\Contract`, and the MCP from Night 6 |
| [`project.schema.json`](project.schema.json) | A saved project, version 3. | The same, plus anything that writes a project file |
| [`patterns.json`](patterns.json) | The nine lanes a project may override (kind, stem, engine index, id prefix, editable or not), the musical unit, and pattern limits. | `frontend/lib/patterns.ts`, `App\Support\Project\Patterns`, the engine's tests |
| [`scenes.json`](scenes.json) | The four scene slots, the parameters a scene holds (`sceneVector`, also the engine's vector order) and the factory recipes. | The same, plus `engine-core/tests` |

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
- `performance`: a gesture in the moment (loop, echo throw). Not saved, and never
  part of a scene. A project never reopens mid-gesture.

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
  "version": 2,
  "name": "Warehouse, no drums",
  "trackId": "warehouse",
  "params": { "transport.bpm": 124, "fx.filter": 0.6 },
  "stems": { "kick": { "volume": 0.9, "send": 0, "muted": true, "solo": false } },
  "patterns": {},
  "scenes": { "slots": [ { "slot": "full", "name": "Full", "factory": "full", "revision": 1, "params": {}, "stems": {}, "patterns": {} } ] }
}
```

(The `scenes` above is abbreviated: on disk there are always four slots, each
complete.)

- A missing `params` key or stem field means its default. A project only needs to
  carry what differs, but writers may write everything.
- In version 2, `patterns` is reserved and must be empty. Version 3 fills it: see
  [Patterns (version 3)](#patterns-version-3).
- `scenes` holds four complete snapshots: every stem, every scene parameter. Unlike
  `params`, a scene is never clamped or filled: a malformed one refuses the whole
  set, so a bad scene cannot reach the mix. Which scene is active is not saved.
  Details: [`docs/NIGHT3_PROTOCOL.md`](../docs/NIGHT3_PROTOCOL.md).
- Readers **reject** an unknown `format` or a newer `version`. They never guess.
  Readers **upgrade** older versions through a migration, and a migration never drops
  data it doesn't understand silently.

## Patterns (version 3)

```json
"patterns": {
  "hat": {
    "id": "p-hat", "revision": 3, "lane": "hat", "length": 256,
    "events": [{ "id": "h2", "step": 2, "vel": 0.45 }],
    "origin": { "kind": "variation", "generator": "php-variation-1", "seed": 42, "strength": "moderate",
                "scope": { "from": 128, "to": 191 }, "sourceRevision": 2, "sourceHash": "9c1e04d2", "mode": "drums" }
  },
  "kick": { "id": "p-kick", "revision": 2, "lane": "kick", "length": 256, "events": [] }
},
"locks": { "lanes": ["bass"], "events": { "hat": ["h2"] } }
```

- **Unchanged and silent are different.** A lane absent from `patterns` plays the
  factory lane. A lane present with no events plays nothing. So clearing a bar never
  brings the factory pattern back.
- **Unit:** sixteenths of the 16-bar song. `step` is 0..255, and a note's `len` is in
  sixteenths and must end by step 256. Nothing on screen (selection, scroll,
  playhead) is ever stored here.
- **Identity:** every pattern has an `id` and a `revision` that goes up with every
  accepted edit. Every event has an `id`, unique in its pattern. The factory's ids
  come from the lane prefix and the step (`k0`, `h12`, `b64`), so a project and the
  factory agree on them.
- **Nothing is flattened:** a note keeps every pitch (chords of up to six), its
  length, velocity and accent. A drum event is `{id, step, vel}`. The extra
  percussion on the hats stem is not a lane here and is never touched.
- **Provenance** (`origin`) records how a pattern was made. For a variation or a
  humanize, that's the generator and its version, the seed, the settings and the
  source revision. The resulting events are stored too, so a later generator update
  never changes a saved pattern.
- **Scenes pin patterns.** A v3 scene's `patterns` maps the lanes it sets to a copy
  of the pattern as captured, or to `{"factory": true}`. A lane the scene leaves out
  is left alone when it launches. Editing the working pattern never rewrites a
  scene: the scene shows as modified until you capture it again.
- **Malformed is refused whole**, with the same error text from both readers.

### Migrations

| From | To | How |
|---|---|---|
| Legacy preset (`PresetController`, no `format`) | v1 | `trackId`, `bpm`, `swing` → `transport.*`; `mix`/`muted`/`solo` → `stems`. Effects take their defaults, because legacy presets never stored them. |
| v2 | v3 | Adds empty `locks`. Patterns stay empty and scenes set no lanes, so nothing that plays changes. A v1 or v2 document carrying patterns or locks is refused rather than silently dropped. |
| v1 | v2 | Adds the track's four factory scenes. Nothing else changes, and no scene is applied: the working mix stays what was saved. A v1 document that already carries `scenes` is refused. |
| MCP `MixSettings` (bckgrnd-msc-mcp `src/settings.ts`) | v1 (Night 6) | `track` → `trackId`; `cut[]` → `stems.*.muted`. Its loudness, ducking and fades are render settings for mixing under a voice, not musical data. They stay in the MCP's own presets. |

The engine's own defaults and ranges are held against the registry too
(`engine-core/tests/contract.rs`), so "default" on a knob is the engine's default.

Both implementations live next to their readers: `migrateProject()` in
`frontend/lib/contract.ts` and `Contract::migrate()` in
`app/Support/Project/Contract.php`. `tests/Unit/ContractTest.php` keeps them honest.
