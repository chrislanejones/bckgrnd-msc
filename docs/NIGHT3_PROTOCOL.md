# Night 3: scenes, scheduling and performance — the working protocol

The specification is the Night 3 brief (scenes, a musical scheduler, held effects, a
one-bar fill, Compare A/B, silence rules). This file pins down the shapes every part
of the app agrees on: the project contract, the vector the engine receives, the
commands and the events that come back. Where this file and the code disagree, the
code is wrong.

## The rule

Scenes change the underlying musical state. Performance gestures sit on top of it,
temporarily. The audio engine decides when changes happen.

## Three kinds of state

| State | Lives in | Saved? | Changed by |
|---|---|---|---|
| Stored snapshots (four scene slots) | The project, `scenes` (v2) | In the project (the app has no file save until Night 5) | Capture, Rename, Duplicate, Reset to Factory |
| Working mix | The project's `params` and `stems`; the engine's *base* values | Yes | Knobs, faders, a scene being applied |
| Temporary overrides | The engine's gesture slots only | **Never** | Held Echo Throw, Filter Hold |

An override never writes the working mix. Releasing it removes the override and
exposes whatever the base is *now* (which may be a different scene's).

## What a scene holds

All eight stems' `volume`, `send`, `muted`, `solo`, and every parameter listed in
`sceneVector` in `contracts/scenes.json` (all twelve `fx.*`: filter, resonance, the
three isolators, echo time, feedback and return, room mix and decay, width, balance).

Outside a scene, on purpose: `transport.bpm`, `transport.swing`, `master.level`,
`performance.*`, the playhead, the loop, the deck, held gestures.

## Project version 2

```json
{
  "format": "bckgrnd-msc/project",
  "version": 2,
  "name": "Warehouse",
  "trackId": "warehouse",
  "params": { "...": 0 },
  "stems": { "...": {} },
  "patterns": {},
  "scenes": {
    "slots": [
      {
        "slot": "full",
        "name": "Full",
        "factory": "full",
        "revision": 1,
        "params": { "fx.filter": 1, "...": 0 },
        "stems": { "kick": { "volume": 0.9, "send": 0, "muted": false, "solo": false } },
        "patterns": {}
      }
    ]
  }
}
```

- Exactly four slots, ids `full`, `sparse`, `build`, `drop`, in that order.
- `factory` names the recipe in `contracts/scenes.json` that **Reset to Factory**
  restores. `revision` goes up by one on every overwrite (capture, duplicate into,
  reset, rename).
- A scene is **complete** on disk: every scene parameter and every stem field. Missing
  values are resolved against the registry *when capturing*, not when reading.
- `patterns` must be empty in Night 3. Any key is an unsupported pattern reference
  and the whole scene is rejected.
- A malformed scene (unknown key, wrong type, out of range, wrong slot set) rejects
  the **whole document's scenes** with an error; the working mix is never touched by
  a scene that failed to read. (Project-level `params` keep their v1 clamp-and-fill
  rule, which is unchanged.)
- Migration v1 → v2 adds the four factory scenes built for the project's track and
  changes nothing else. Opening an older project never applies a scene: no slot is
  active after a migration.
- The active scene is **not** saved. It is session state: after reload nothing is
  active and the working mix is what was saved.

## Factory recipes

`contracts/scenes.json` holds the four recipes, written relative to the track's own
mix (`scale` multiplies the track's level for that stem; `cut` mutes it). Both
readers (`Contract::factoryScenes()` in PHP, `factoryScenes()` in
`frontend/lib/contract.ts`) build them the same way; `tools/check-contract.mjs`
holds them to the same fixtures. Drop does not raise the master or push every stem
up: its levels are at or below the track's own mix.

## The engine scene vector

One `Float32Array` of length **44**, in this order:

| Index | Value |
|---|---|
| `4*i + 0` | stem `i` volume, 0..1 |
| `4*i + 1` | stem `i` send, 0..1 |
| `4*i + 2` | stem `i` muted, 0 or 1 |
| `4*i + 3` | stem `i` solo, 0 or 1 |
| 32 | `fx.filter` |
| 33 | `fx.filterQ` |
| 34 | `fx.low` |
| 35 | `fx.mid` |
| 36 | `fx.high` |
| 37 | `fx.echoTime` (beats; 0 = echo off) |
| 38 | `fx.echoFeedback` |
| 39 | `fx.echoReturn` |
| 40 | `fx.reverbMix` |
| 41 | `fx.reverbDecay` |
| 42 | `fx.width` |
| 43 | `fx.stereo` |

Stem `i` is `Stem::ALL` order: kick, clap, hats, bass, stab, lead, pad, arp (the
registry's `stems`). The order of 32..43 is `sceneVector` in `contracts/scenes.json`;
the Rust tests read that list so the two cannot drift.

The engine validates the whole vector (length, finite, each value inside its registry
range, toggles exactly 0 or 1) **before** touching anything, and rejects it as a
whole.

## Timing

| Mode | Code | Applies at |
|---|---|---|
| Now | 0 | The first sample of the next render call after the request is accepted. Smoothing still applies. |
| Next Beat | 1 | The first step onset after the request whose step is a multiple of 4. |
| Next Bar | 2 | The first step onset after the request whose step is a multiple of 16. **Default for scenes.** |

- "After the request" is measured on the engine's monotonically increasing onset
  serial, never on a step number, so a loop that repeats bar 9 cannot make a request
  fire twice or fire early. A request made exactly on a boundary's sample waits for
  the next one: late requests go to the next eligible boundary.
- Tempo changes move no deadline: the target is musical (an onset), not a time.
- At the boundary the order is fixed: **commit the scene**, then **activate the
  fill**, then **trigger that step's notes**. All targets change in one place; gains
  and effects glide with their existing smoothing (ADR-013), nothing jumps.
- A scene selected while stopped applies immediately and does not start playback.

## The bounded queue

- At most **one pending scene** and **one pending fill** per engine.
- Latest valid request wins. A replacement is validated first; only then is the old
  one dropped (`replaced`). It keeps the boundary already announced unless the new
  request is `Now`.
- Cancel by request id. Cancelling something already applied returns "not pending";
  the UI says it already applied.
- The snapshot is copied when queued, so overwriting the slot while queued does not
  change what launches (its `revision` is pinned in the request).

### What cancels pending scenes and fills

| Event | Pending scene | Pending / active fill | Held gestures |
|---|---|---|---|
| Stop | cancelled (`stopped`) | cancelled / ended | released |
| Cue, seek, scratch, brake, backspin | cancelled (`transport`) | cancelled / ended | kept |
| Track load on that deck, auto-mix start | cancelled (`track`) | cancelled / ended | released |
| Panic | cancelled (`panic`) | cancelled / ended | released |

During an auto-mix crossfade the worklet rejects new scene and fill requests
(`mixing`).

## Requests and outcomes

Every request carries `requestId` (u32, from the UI), `slot`, `revision`, `deck`,
`generation` (the deck's loaded-track counter, kept by the worklet) and `timing`.
The worklet rejects a request whose generation is stale before it reaches the engine.

```
requested → queued → applied
requested → rejected
queued → cancelled | replaced | applied
```

Only `applied` changes the UI's active-scene indicator. Until then the pad shows
*Sending…* then *Queued · Bar N*.

### Engine events

The engine keeps a fixed ring of events; the worklet drains it after each render
call and posts them to the UI only when there are any. Each event is four numbers:

| kind | name | a | b |
|---|---|---|---|
| 1 | scene queued | predicted bar (1-based, of the 16-bar grid) | predicted step |
| 2 | scene applied | step it applied on (-1 for Now / stopped) | 0 |
| 3 | scene cancelled | reason | 0 |
| 4 | scene replaced | id of the request that replaced it | 0 |
| 5 | scene rejected | reason | 0 |
| 11 | fill queued | predicted bar | predicted step |
| 12 | fill started | step | 0 |
| 13 | fill ended | step | 0 |
| 14 | fill cancelled | reason | 0 |
| 15 | fill rejected | reason | 0 |
| 21 | gesture expired (lease ran out) | gesture kind | 0 |

Reasons: 1 invalid, 2 stopped, 3 transport, 4 track, 5 panic, 6 mixing, 7 not
playing, 8 already playing, 9 stale generation, 10 cancelled by the user.

## Fills

- One prepared drum variation per recipe, starting next bar, lasting one bar (16
  steps), then returning to the **current** underlying pattern (never a copy).
- Recipes are written in the PHP music layer and exported with each track as
  `fills` in the track JSON, so the static build has them too. Nothing is generated
  in the audio callback.
- A fill replaces only the drum lanes its recipe defines (`kick`, `clap`, `hat`,
  `hatOpen`). Every stem's level, cut and solo still apply: a fill cannot unmute a
  stem.
- First press queues; a second press before it starts cancels; a press while it
  plays is refused (`already playing`). A fill while stopped is refused (`not
  playing`) and the UI says playback is needed.

## Gestures (temporary overrides)

- Two kinds in Night 3: **Echo Throw** (the existing throw: send, feedback, return
  held open within safe limits) and **Filter Hold** (a defined dark, resonant
  treatment).
- Each begins with a unique token. Ending a token ends that gesture only. At most
  **four** at once; the most recently begun wins for any parameter it controls;
  releasing it reveals the next active one or the base.
- The engine holds a **lease** per gesture: it expires after 3 s of rendered audio
  unless renewed (the UI renews while held). Suspension is separate: the UI also
  releases on blur and visibility change, because a watchdog counted in rendered
  samples does not advance while the context is suspended.
- **Release FX** ends every gesture and leaves the working mix alone.
- Capture never sees an override: it reads the base.

## Silence, solo and transition sounds

- A scene launch alone produces no crash or riser.
- While any stem is soloed, the automatic transition sounds (riser, crash,
  downsweep) are suppressed.
- Entering solo ducks and clears the shared echo and room history, so the soloed
  stem is heard alone and not over another stem's tail.
- Every stem cut: the final output fades to silence (about 30 ms), wet returns and
  transition sounds included. A single cut still lets existing tails decay.
- Scratch and backspin are not gated by any of this.
- **Panic** cancels everything queued, releases every gesture, stops playback and
  clears the tails. It is not the same as Cancel Queued.

## Compare A/B

Session-only, never saved, clearly separate from Deck A / Deck B. Same engine, same
playhead. Capture A, capture B, listen to either through the same scheduler as
scenes. **Keep Current** adopts what is audible as the working mix (no scene is
overwritten). **Exit Comparison** restores the working mix from before entering.
Editing while listening to B shows *B · Modified*; replacing B needs **Update B**.
