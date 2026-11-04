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
range, toggles exactly 0 or 1, `fx.echoTime` exactly one of the registry's options)
**before** touching anything, and rejects it as a whole. A rejected replacement leaves
the scene already pending, pending.

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
- Changing the loop while a scene is pending keeps the rule (next eligible onset) but
  may move which step that is, so the engine reports `queued` again with the new
  prediction.
- `Now` reports no `queued`; its `applied` carries step -1.
- At the boundary the order is fixed: **commit the scene**, then **activate the
  fill**, then **trigger that step's notes**. All targets change in one place; gains
  and effects glide with their existing smoothing (ADR-013), nothing jumps.
- A scene selected while stopped applies immediately (`applied` with step -1, no
  `queued`) and does not start playback.
- A scene requested while a scratch is held, a brake is slowing the deck or a
  backspin is running is rejected (`transport`): the clock is not running at its own
  pace, and each of those gestures cancels a pending scene anyway.

## The bounded queue

- At most **one pending scene** and **one pending fill** per engine.
- Latest valid request wins. A replacement is validated first; only then is the old
  one dropped (`replaced`, `a` = the new request's id). It keeps the boundary already
  announced unless the new request is `Now`, and the engine then reports `queued` for
  the new request with that same boundary.
- Cancel by request id. Cancelling something already applied returns "not pending";
  the UI says it already applied.
- The snapshot is copied when queued, so overwriting the slot while queued does not
  change what launches (its `revision` is pinned in the request).

### What cancels pending scenes and fills

| Event | Pending scene | Pending / active fill | Held gestures |
|---|---|---|---|
| Stop (including a brake that runs to a halt) | cancelled (`stopped`) | cancelled / ended | released |
| Cue, seek, scratch (grab or drop), brake, backspin, Play while already playing (restarts from step 0) | cancelled (`transport`) | cancelled / ended | kept |
| Track load on that deck, auto-mix start, `promote` to the other deck | cancelled (`track`) | cancelled / ended | released |
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
call and posts them to the UI only when there are any, as
`{type: 'sceneEvents', deck, events: number[]}`. Each event is four numbers,
**`[kind, requestId, a, b]`**:

| kind | name | a | b |
|---|---|---|---|
| 1 | scene queued | predicted bar (1-based, of the 16-bar grid) | predicted step |
| 2 | scene applied | step it applied on (-1 for Now / stopped) | 0 |
| 3 | scene cancelled | reason | 0 |
| 4 | scene replaced | id of the request that replaced it | 0 |
| 5 | scene rejected | reason | 0 |
| 11 | fill queued | predicted bar | predicted step |
| 12 | fill started | step | 0 |
| 13 | fill ended | step the track's drums resume on (-1 when cut short) | 0 when it played its bar, else the reason it was cut short |
| 14 | fill cancelled | reason | 0 |
| 15 | fill rejected | reason | 0 |
| 21 | gesture expired (lease ran out); `requestId` is the token | gesture kind | 0 |

Reasons: 1 invalid, 2 stopped, 3 transport, 4 track, 5 panic, 6 mixing, 7 not
playing, 8 already playing, 9 stale generation, 10 cancelled by the user.

- The ring holds 64 events. If it fills between two drains (only possible with dozens
  of requests landing between two render calls) the **oldest** event is overwritten
  and counted (`Engine::dropped_events`). The newest events describe the one pending
  slot, so the UI treats a `queued` or `applied` for a request as superseding any
  older request it was still waiting on.
- Rejections the engine makes (1 invalid, 3 transport) arrive through the ring.
  Rejections the worklet makes before the engine sees the request (6 mixing,
  9 stale generation, 1 for a vector that is not 44 long, 7 before the engine has
  booted) are posted by the worklet in the same `sceneEvents` shape.
- `cancelScene` is answered with `{type: 'sceneCancelResult', deck, requestId,
  cancelled}`: `cancelled: false` is the "not pending" case (already applied,
  replaced or unknown). A successful cancel also produces the `cancelled` event
  (reason 10). `cancelFill` is answered the same way with `fillCancelResult`.
- The worklet drains the live engine's events straight after handling a `scene` or
  `fill` message as well as after every render call, so a scene applied on a stopped
  deck reports `applied` even while the context is suspended.
- When a scene applies on the live deck the worklet updates its auto-mix mirrors
  (stem volume, send, filter) and sets the same values on the idle deck at once,
  without events, so a later handover does not restore the mix from before it.

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
- A second `fill` request that reaches the engine while one is **queued** is refused
  the same way (`already playing`, 8): the queued fill keeps the bar it announced. The
  engine never replaces or stacks fills; cancelling is the UI's job.
- Refusals, as `fill rejected` (15): 1 no such fill index, 3 a scratch, brake or
  backspin is running, 7 not playing, 8 one already queued or playing (all from the
  engine); 6 mixing, 9 stale generation, 7 engine not booted (from the worklet).
- `cancelFill` withdraws a queued fill only. A fill that has started runs its bar;
  cancelling it answers `cancelled: false`.
- The bar is counted in onsets, so a tempo change moves neither end; a loop change
  re-announces a queued fill (`fill queued` again).
- The engine reads only the four lanes from the exported recipe (`id` and `name` are
  the UI's). A lane that is missing or empty is not replaced: the track's own lane
  plays through the fill. Hats fold open over closed as they always do, each from
  whichever source owns that lane.
- Host messages: `{type: 'fill', requestId, generation, index, deck?}` and
  `{type: 'cancelFill', requestId}`; events come back on `sceneEvents`.

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
- `gestureBegin` is refused (answered `{type: 'gestureBeginResult', deck, token,
  accepted: false}`) for an unknown kind, a token already held, or a fifth gesture.
  `gestureEnd` and `gestureRenew` for an unknown token do nothing. Gestures act on the
  live deck; a track load, auto-mix start or `promote` releases the outgoing deck's.
- The lease is counted once per render call, so it runs out at the end of the call in
  which its 3 s are reached (within 128 samples).
- The two kinds control different parameters, so "most recently begun wins" only
  ever chooses between overrides of the same kind, which apply the same treatment:
  a parameter is overridden while any gesture of its kind is held.
- **Echo Throw** is the throw the engine always had: an extra feed off the summed bus
  into the echo, the dry at 0.55 and the return at 0.95, and the feedback opened to at
  least 0.78 (`THROW_FEEDBACK`, never above the 0.9 the knob allows). Releasing it puts
  the dry, the return and the feedback back on the base; repeats already in the line
  ring out on that feedback.
- **Filter Hold** closes the tape filter to 0.3 of its travel (about 880 Hz on the
  240 Hz to 18 kHz sweep) at a resonance of Q 3.0, and trims the output by 1.5 dB while
  held. If the base filter is already darker it stays where it is, and if the base Q
  is already higher that is kept. The trim is there because the resonant peak sits on
  the stab and lead band: untrimmed, a dense mix measured about 1 dB louder held than
  open; trimmed it is 0.5 to 1.2 dB quieter. It glides in and out with the filter's
  own 30 ms smoothing.
- The older latched toggle (`{type: 'echo', on}`, `Engine::set_echo`) still works
  until the UI moves to tokens. It is combined with any held Echo Throw, is not
  leased, and survives Stop and track loads (the UI owns the latch); Release FX and
  Panic turn it off, so the UI clears its latch on those too.

## Silence, solo and transition sounds

- A scene launch alone produces no crash or riser.
- While any stem is soloed, the automatic transition sounds (riser, crash,
  downsweep) are suppressed.
- Entering solo ducks and clears the shared echo and room history, so the soloed
  stem is heard alone and not over another stem's tail.
- Every stem cut: the final output fades to silence (about 30 ms), wet returns and
  transition sounds included. A single cut still lets existing tails decay.
  "Cut" means the stem cannot be heard: muted, its fader at 0, or left out by another
  stem's solo. Un-cutting fades back over the same 30 ms.
- Scratch and backspin are not gated by any of this. The policy is explicit in
  `Engine::render_sample`: the all-cut gate scales the stem sum, the transition sounds
  and the echo and room returns; the backspin take and the scratch reader are added
  after it, ungated. (Their own echo and room, if any, are returns, so those follow
  the gate.)
- The solo flush: the echo and room returns duck to silence over 16 ms, stay there
  48 ms while the other stems' faders finish gliding out (their sends are post-fader),
  have their history cleared at zero gain, and come back over 16 ms. Any transition
  sound in flight fades out (60 ms) and none start while a stem is soloed; the song's
  seams are still counted, so leaving solo needs nothing special.
- **Panic** cancels everything queued, releases every gesture, stops playback and
  clears the tails. It is not the same as Cancel Queued. In the engine: the pending
  scene `cancelled` and the queued fill `fill cancelled` with reason 5, a playing fill
  `fill ended` (-1, 5), every gesture and the echo latch released, Stop, transition
  sounds silenced. The worklet panics both decks and abandons an auto-mix in progress
  where it is (live deck at full trim, the other silent; no `mixEnd` is sent).
- `Engine::cancel_pending(reason)`, the host's structural cancel (auto-mix start,
  `promote`), withdraws the pending scene **and** fill and ends an active fill. It does
  not touch gestures; the host calls `release_gestures` for that.

## Compare A/B

Session-only, never saved, clearly separate from Deck A / Deck B. Same engine, same
playhead. Capture A, capture B, listen to either through the same scheduler as
scenes. **Keep Current** adopts what is audible as the working mix (no scene is
overwritten). **Exit Comparison** restores the working mix from before entering.
Editing while listening to B shows *B · Modified*; replacing B needs **Update B**.
