# Night 7: timed builds — the working protocol

A Build that rises over several bars instead of landing on one boundary (ROADMAP,
Night 3/4 carry-over). This file pins down the engine call, the worklet messages and
the events. It extends `docs/NIGHT3_PROTOCOL.md` (scene vector, timing, events,
reasons) and follows ADR-015: the engine owns musical timing, every request ends in
an explicit outcome, and gestures stay overrides on top of the base. Where this file
and the code disagree, the code is wrong.

## The request

One request, up to two scene vectors (44 values each, the Night 3 layout), and
optionally the pattern lanes the build sets:

- **target**: where the mix rises to, across the bars.
- **land** (optional): a whole scene committed on the bar line where the build ends,
  such as Drop. It is part of the same request: cancelling the build cancels it.
- **lanes** (optional): a pattern revision (`docs/NIGHT4_PROTOCOL.md`, the payload)
  staged just before the build with `queue_patterns(patternsId, 2, link = requestId,
  data)`, exactly as a scene's linked lanes are. `queue_build` takes them on, and they
  commit on the build's end onset, after the landing scene.

| Engine (`engine-core/src/build.rs`) | Returns |
|---|---|
| `queue_patterns(request_id: u32, timing: u8, link: u32, data: &[f32]) -> u8` with `link` = the build's id, just before `queue_build` | 0 staged, else `patterns rejected` (Night 4) |
| `queue_build(request_id: u32, bars: u32, target: &[f32], land: &[f32]) -> u8` | 0 accepted, else the reason (also reported as `build rejected`) |
| `cancel_build(request_id: u32) -> bool` | true if it was queued or running |
| `pending_build() -> Option<u32>` | the build waiting for its bar line |
| `active_build() -> Option<u32>` | the build in progress |
| `base_into(out: &mut [f32]) -> bool` | the base as a 44-value vector; false if `out` is shorter |

`land` empty means no landing. `bars` is 2, 4 or 8. Both vectors are validated with the
scene validator (`scheduler::valid`) before anything changes; a refused request leaves
whatever was queued or running as it was.

The build's lanes go with it the way a scene's go with the scene (events 31 to 35,
Night 4). Linked lanes announce nothing of their own while they wait (no `queued`). They
end in exactly one of:

| The build | Its lanes |
|---|---|
| applied | `patterns applied` on the end step, after the landing and before `build applied` |
| refused (`build rejected`) | `patterns cancelled` with the same reason; a build already queued or running keeps its own, and so does a scene still pending (staged lanes replace nothing until their request is accepted, `docs/NIGHT4_PROTOCOL.md`) |
| cancelled, by the user or any path below | `patterns cancelled` with the same reason, right after `build cancelled` |
| replaced, by a scene that commits or a newer build | `patterns cancelled`, reason 10, as a replaced scene's are |

`cancel_patterns(patternsId)` withdraws them on their own; the build carries on and lands
without them. A build with no lanes changes nothing about lanes: a pending standalone
edit keeps its own boundary. When a scene commits over a build on an onset, the build's
lanes are withdrawn on the audio path, so the engine parks them and frees them on the
next pattern or build message: `process()` still neither allocates nor frees.

## Timing

- A build always **starts on the next bar line**: the first onset on a multiple of 16
  steps, after the request, on the onset serial. There is no Now or Next Beat: a build
  that started off the bar would end off the bar, and the landing would miss the
  downbeat.
- It **ends exactly `bars * 16` onsets later**, on a bar line. Tempo changes move
  neither end. A loop does not change the count: a two-bar build in a one-bar loop
  starts on one pass's step 0 and ends two passes later, once.
- The start onset is progress 0. Each onset after it moves the base to progress
  `onsets / (bars * 16)`; the existing smoothing (ADR-013) glides between onsets.
- On the end onset the order is fixed: pattern edit, then a scene due there (which
  would replace the build), then **the build writes its target exactly, commits the
  landing scene whole and swaps in its lanes**, then the fill, then that step's notes.
  So the landing and the lanes are sample-accurate, like a scene and its lanes. On a lane
  both set, the build's win over the edit.
- Changing the loop while a build waits re-announces it (`build queued` again).

## What moves, and how

| Slot | Rule |
|---|---|
| Volume, send, filter, resonance, isolators, echo feedback and return, room mix and decay, width, balance | Straight line in the control's own space, so every knob turns at a steady rate. The filter position is already exponential in hertz (`Master::filter_freq`), so the cutoff rises evenly in octaves; the isolators are amounts that `band_db` turns into decibels. |
| A stem muted at the start and playing in the target | Unmuted on the start onset with its fader at 0, then fades in to the target level. |
| A stem playing at the start and muted in the target | Fades out across the build, muted on the end onset (its fader then takes the target value, silently). |
| Solo | Switches on the end onset: a solo changes which stems are heard at all. |
| Echo time | Switches on the end onset: a time between two of the registry's options is not one. |

## The base, gestures and capture

- From its start onset the build **owns the base**: the base is the interpolated
  value. Releasing a gesture lands on the base as the build has it now, not where it
  started (Filter Hold re-derives from the moving filter base; Echo Throw puts the
  return and feedback back on theirs).
- Gestures stay overrides on top. A build never reads or ends one, and a held gesture
  never stops a build.
- **Capture reads the base**: `base_into` returns it (held gestures are never in it). A
  capture during a build stores the mix as it stands on that onset.
- **A control moved during a build is the user's** from then on: the build stops
  driving that slot, and a cancel does not take it back. Coarse on purpose:
  `set_bands` takes all three isolators, and a mute or solo message takes that stem's
  flag. A control moved while the build is still waiting is just where it starts from.

## Interaction

| Situation | Outcome |
|---|---|
| A scene commits while a build waits or runs (any timing) | The build is `replaced` (`a` = the scene's id) on the onset the scene commits, with no restore: the scene is complete. Until then the build carries on. |
| That scene is cancelled before it lands | Nothing happens to the build. |
| A build is queued while a scene is pending | The scene is `replaced` (`a` = the build's id) and its linked lanes are withdrawn. Latest wins. |
| A build is queued while another waits | The waiting one is `replaced`; the new one keeps the bar line already announced. |
| A build is queued while another runs | The running one is `replaced` at once and the mix holds where it got to. The new one starts on the next bar line from there. Cancelling it restores the base from before **both**. |
| A fill during a build | Plays as usual; fills are drums, builds are the mix. |
| A pattern edit during a build | Unaffected (Night 4 rules). |
| The idle deck's follower (`set_scene`) on an engine with a build | The build is `replaced` with `a` = 0. The worklet never does this in practice. |

## What cancels a build

The same table as a pending scene (Night 3), with one difference: a running build is
**restored**, gliding back to the base it started from with the existing smoothing.

| Event | Reason |
|---|---|
| `cancel_build(id)` | 10 cancelled by the user |
| Stop (including a brake that runs to a halt) | 2 stopped |
| Cue, seek, scratch (grab or drop), brake, backspin, Play while playing | 3 transport |
| Track load, auto-mix start, `promote` (`cancel_pending(4)`) | 4 track |
| Panic | 5 panic |

## Events

Same ring, same `[kind, requestId, a, b]` shape as Night 3. Kinds 41 to 45 mean what 1
to 5 mean for a scene.

| kind | name | a | b |
|---|---|---|---|
| 41 | build queued | predicted bar it starts on (1-based) | predicted step |
| 42 | build applied (finished) | step it ended on | 1 if the landing scene landed, else 0 |
| 43 | build cancelled | reason | 0 |
| 44 | build replaced | id of the request that replaced it (0 for `set_scene`) | 0 |
| 45 | build rejected | reason | for reason 1, the part refused: 1 bars, 2 target, 3 landing, 4 lanes (from the worklet) |
| 46 | build started | step | bars |
| 47 | build progress | bar now playing (2 to bars) | bars |

```
requested → queued → started → progress (bar 2 … n) → applied
requested → rejected
queued | started → cancelled | replaced
```

`started` means "bar 1 of n". Exactly one of `applied`, `cancelled` or `replaced` ends
every accepted build, and nothing about it is reported after that. Rejections the
engine makes: 1 invalid (with the part), 7 not playing, 3 transport. The worklet's:
6 mixing, 9 stale generation, 1 for a vector that is not 44 long, 1 with part 4 for
lanes the engine refused (`patterns rejected` comes first), 7 before the engine has
booted.

## Worklet messages

| Host → worklet | Engine call |
|---|---|
| `{type: 'build', requestId, generation, bars, target, land?, deck?, patterns?, patternsId?}` | `patterns` (if any) staged first with `queue_patterns(patternsId, 2, requestId, patterns)`, as the `scene` message does; then `queue_build`. Bars other than 2, 4 or 8 go in as 0 (refused, part 1) |
| `{type: 'cancelBuild', requestId}` | `cancel_build`, answered with `{type: 'buildCancelResult', deck, requestId, cancelled}` |

| Worklet → host | When |
|---|---|
| `{type: 'buildBase', deck, requestId, values}` | The live engine's base (`base_into`, 44 values) while its build runs, on the telemetry tick (~30 Hz), and once more when it is applied or cancelled, posted **before** the event that ends it. Display only: the host moves its knobs, it sends nothing back. |

Events come back on `sceneEvents`. When the live deck reports `build applied`, the
worklet reads the live engine's base (`base_into`) and carries it to its auto-mix
mirrors and onto the idle deck (`set_scene`), as it does for an applied scene. The
host API is `EngineHost.queueBuild(requestId, bars, target, generation, land?,
patterns?)`, where `patterns` is `{requestId, data}` as for `queueScene`, and
`EngineHost.cancelBuild(requestId)` in `frontend/lib/engine.ts`, and
`EngineHost.onBuildBase(listener)` for the `buildBase` messages.

## The UI: Rise

The scene strip's **Switch on** gains a fourth choice, **Rise**, with a 2 · 4 · 8 bars
picker beside it (4 the first time, then whatever was last picked). It is called Rise,
not Build, because one of the four factory scenes is called Build. In Rise, a pad press
(or Shift+1–4) queues a build into that scene instead of a launch. The request is the
same record as a launch (`SceneRequest` with `build: {bars, bar}`), so Cancel, the
other pads and Compare A/B treat it like a pending scene.

| Engine says | Pad line | Status line |
|---|---|---|
| (sent) | Sending… | |
| 41 queued | Rise · Bar N | Drop rises over 4 bars from bar N |
| 46 started | Rising · 1 of 4, a rule along the foot at 1/4 | Drop rising over 4 bars |
| 47 progress | Rising · k of 4, the rule at k/4 | (unchanged: once a bar is too chatty for a live region) |
| 42 applied | Active, or Active · Modified if the user moved a knob | Drop active |
| 43 cancelled | (cleared) | Drop rise cancelled, plus the reason unless it was the user |
| 45 rejected | (cleared) | Drop rise not started: press Play first / not while the deck is scratched or braking |

- **Pressing the rising pad again cancels it**, and the mix glides back. Cancel (the
  button) keeps its meaning: clear the scene and restore the mix from before scene
  choices, which replaces the build.
- **The knobs move with the build.** They follow `buildBase`, so the store, and with it
  capture, Compare A/B and Save, hold the mix as it stands (at most one telemetry tick,
  ~33 ms, behind the engine).
- **A knob the user moves during a build stays theirs.** The host notices a value that
  differs from the last one it showed and stops moving that control, as the engine
  does. A snapshot that React has not rendered yet is not mistaken for the user's hand.
- **Stopped:** a Rise press does nothing but say "Drop can rise only during playback:
  press Play, or switch on Now". The engine would refuse it anyway (reason 7).
- **Lanes:** a rise carries its scene's captured lanes, compiled when the pad is
  pressed (`patterns.scenePayload`), so they land on the build's end bar line with the
  mix, before that step's notes. On applied the working patterns adopt them without
  sending them again, as a launch does. Cancelled, refused or replaced, the rise takes
  its lanes with it.

## Not in Night 7

- Curves other than the straight line, and a build that starts on a beat.
