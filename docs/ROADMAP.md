# Roadmap: six nights

**Target:** a playable music instrument with an approachable interface, editable
patterns, expressive performance controls, reliable saving, and the same sound engine
across the browser, NativePHP and MCP.

Nights 1 and 2 set the design philosophy, the layout and genuinely tactile controls.
Nights 3–5 make it more creative and dependable. Night 6 is integration and release,
not another feature night.

The features already in the README (meters, two decks, jog wheels, performance pads,
looping, effects, automatic mixing) are **preserved and improved**. They are never
rebuilt as if they were new.

The standard for every night is [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md).

| Night | Focus | What exists at the end |
|---|---|---|
| 1 | Design philosophy, layout, architecture boundaries | A coherent new interface using the existing working features. |
| 2 | High-quality turning knobs, mixer and effects | Controls that look, feel and sound like an instrument. |
| 3 | Performance mode, scenes and transitions | A track you can actively perform without knocking it out of time. |
| 4 | Pattern editing and musical variation | The ability to make a track your own, not only remix it. |
| 5 | Projects, undo, export and release hardening | A complete browser workflow: create → save → reopen → export. |
| 6 | NativePHP packaging and MCP reconnection | A packaged desktop build and an updated, tested MCP companion on the same engine and project data. |

**Release target for Night 6:** the packaged *desktop* app, with a separate mobile
compatibility check. A working desktop package isn't proof that the phone version
works. iOS/Android packaging and mobile audio behavior are their own work (see
[PARKING_LOT.md](../PARKING_LOT.md)).

---

## Night 1: design philosophy, layout, architecture boundaries

- `docs/DESIGN_PHILOSOPHY.md`: principles, tokens, state vocabulary, layout map.
- Layout: persistent transport, collapsible library, central performance area, right
  inspector, bottom editor drawer. On phones, Perform / Mix / Edit views.
- Control shells: `ControlLabel`, `ValueReadout`, `InstrumentPanel`,
  `PerformancePad`, `StemStrip`, `StatusIndicator`.
- A master output meter with clip indication (peak measured in the worklet, not React).
- One versioned project and parameter contract in `contracts/`, shared by the UI,
  saved projects, exports and MCP. Saved data is separate from telemetry.
- A real PHP test gate: `phpunit.xml.dist`, arrangement tests, API tests, contract tests.
- Night 6 prep: an inventory of NativePHP, assets and MCP sync, plus an early
  native-shell audio probe ([NIGHT6_INVENTORY.md](NIGHT6_INVENTORY.md)).

**Done when:** existing playback, decks, stem controls and effects work in the new
layout; keyboard focus is clear; narrow screens stay usable; the design rules are
written down.

**Status:** done 11-03-2026.

## Night 2: knobs, mixer, effects

- A `Knob` shell: drag vertically, fine adjustment with Shift, arrow keys, double-click
  to reset, value readout while turning, `role="slider"` with `aria-valuetext`.
- Larger, more responsive faders. Double-click resets. A per-stem reset.
- **Gain smoothing on mute, solo, faders, master and EQ** (PARKING_LOT #1). A click on
  every stem toggle is the most audible defect in the app, and an instrument can't
  click.
- An effects rack exposing what the engine already has: filter (cutoff, resonance),
  echo (time, feedback, wet/dry), reverb (size, decay, wet/dry), stereo (width,
  balance), EQ (low, mid, high). Each new engine parameter lands in
  `contracts/parameters.json` first.
- A stretch goal, only if the master rack is solid: per-stem sends (delay on the lead
  without the kick).
- A compact and an expanded mixer. *Moved to Night 3*, where performance mode
  decides what the compact view needs.

**Status:** done 11-03-2026. One `Knob` (stable lighting, 270° sweep, vertical and
circular drag, Shift fine, keyboard, typed values, double-click and Reset, every
state), built on a native range for screen readers. Smoothing in the engine for every
user-moved gain, tested at waveform peaks (ADR-013). New DSP controls, each wired and
tested before it was shown: filter resonance, echo feedback and return, room mix and
decay, stereo width, per-stem echo sends. Faders kept for stem volume, now larger,
with double-click/Delete to the track's level. Messages are coalesced per frame,
controls are memoized, and a gesture is one edit. Not done: testing with touch
screen readers on a device (checklist in DESIGN_PHILOSOPHY.md).

## Night 3: performance mode, scenes, transitions

- A compact and an expanded mixer (moved from Night 2). *Not built; moved to Night 4.*

- Quantized performance controls: trigger a break, a build or a drop on the next bar;
  a fill at the end of a phrase; momentary filter sweep, echo throw and stutter while
  held. **Quantization runs on the engine's sample clock**. React sends intent and
  shows the **Queued** state until it fires.
- Group pads that mute or restore groups of stems on the next bar.
- Scene snapshots: several mixes of the same track, switched during playback. A/B
  between two without interrupting playback.

**Status:** done 11-04-2026. Four scene slots (Full, Sparse, Build, Drop) stored as
complete snapshots in project version 2, with a v1 migration that adds the track's
factory scenes and applies none (ADR-014). A scheduler in the engine that commits a
whole scene at once, Now, on the next beat or on the next bar (the default), counted
on its own onset clock, with an explicit outcome for every request; only the engine's
`applied` marks a scene active (ADR-015). The scene strip with Queued · Bar N,
Active · Modified, Cancel queued and a menu for capture, rename, duplicate and reset;
Shift+1–4. Echo throw and Filter hold as held overrides on top of the mix, Release
FX, and Panic. A one-bar fill per track, prepared in PHP. Compare A/B for the
session. Silence rules: a launch makes no transition sound, solo suppresses them and
flushes the echo and room, and every stem cut fades out the returns. The working
protocol is [NIGHT3_PROTOCOL.md](NIGHT3_PROTOCOL.md). Not done: the compact and
expanded mixer (*moved to Night 4*), stutter (*moved to Night 4*), group pads on the
next bar (the Stem groups buttons still apply at once; see
[PARKING_LOT.md](../PARKING_LOT.md)), and a fill at the end of a phrase: the fill
starts on the next bar, wherever that falls.

## Night 4: pattern editing and musical variation

- The bottom drawer becomes the editor: a 16-step grid per drum stem with velocity,
  and a compact piano roll for bass, lead and chords, constrained to the track's key.
- Duplicate, vary and clear a pattern. The playhead follows engine telemetry.
- Pattern edits are saved musical data in the project contract (`patterns`). The
  arrangement still comes from PHP, so an edit is a delta applied to the arranged
  groove, not a second sequencer in React.
- Humanize (velocity and timing), generated variations that respect key and harmony,
  and a "randomize mix" that only picks musically sensible levels and mutes.

Picked up from Night 3:

- **Pattern references in scenes.** Every scene already carries a `patterns` key that
  must be empty; today any key in it refuses the whole set (ADR-014). Filling it is a
  contract change: schema, both readers and the fixtures move together.
- **Timed builds and automation.** A Build that rises over several bars instead of
  landing on one boundary.
- **A last-beat fill and fill-into-drop.** Today's fill starts on the next bar,
  wherever that falls. Next: a fill that lands at the end of a phrase and leads
  straight into a Drop launch.
- **Drop + Crash accents.** A scene launch makes no transition sound, by design. A
  Drop with a crash on its downbeat has to be a separate, explicit choice.
- **Stutter / beat-repeat while held** (from Night 3's list), as another tokened
  gesture.
- **A compact and an expanded mixer** (moved from Night 3), sized around the scene
  strip and the editor drawer.

## Night 5: projects, undo, export, hardening

- Save, reopen, rename and delete projects. Migrate project v1 and legacy presets
  forward without loss.
- Undo and redo over project changes. Telemetry is never part of history.
- Export to WAV by rendering offline with the same engine (the MCP companion already
  does this in Node).
- Reliability: rapid parameter changes, tab suspension, device changes, long sessions.

Picked up from Night 3:

- **Project save carries the scenes.** Version 2 already holds them; the active scene
  stays session state and is never saved. Today a track change starts over on that
  track's factory scenes.
- **Whether Compare A/B is ever saved.** It is session-only now, and the UI says so.
- **Scene ownership across a crossfade.** Launches wait while Auto mix runs, and the
  incoming track starts on its factory scenes. Decide which deck's scenes the strip
  shows during a mix and what carries over after it.

## Night 6: NativePHP packaging and MCP reconnection

- Move from the abandoned `nativephp/electron` and `nativephp/laravel` to
  `nativephp/desktop`, and fix the leftover `dev.floor.stemmachine` app id.
- Package the desktop app and run the audio probe *inside* the package.
- Resync `bckgrnd-msc-mcp` to the current engine and adopt the project contract for
  its presets, with tests in both repos.
- A separate mobile compatibility check, reported as such.
