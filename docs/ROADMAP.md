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
- A compact and an expanded mixer.

## Night 3: performance mode, scenes, transitions

- Quantized performance controls: trigger a break, a build or a drop on the next bar;
  a fill at the end of a phrase; momentary filter sweep, echo throw and stutter while
  held. **Quantization runs on the engine's sample clock**. React sends intent and
  shows the **Queued** state until it fires.
- Group pads that mute or restore groups of stems on the next bar.
- Scene snapshots: several mixes of the same track, switched during playback. A/B
  between two without interrupting playback.

## Night 4: pattern editing and musical variation

- The bottom drawer becomes the editor: a 16-step grid per drum stem with velocity,
  and a compact piano roll for bass, lead and chords, constrained to the track's key.
- Duplicate, vary and clear a pattern. The playhead follows engine telemetry.
- Pattern edits are saved musical data in the project contract (`patterns`). The
  arrangement still comes from PHP, so an edit is a delta applied to the arranged
  groove, not a second sequencer in React.
- Humanize (velocity and timing), generated variations that respect key and harmony,
  and a "randomize mix" that only picks musically sensible levels and mutes.

## Night 5: projects, undo, export, hardening

- Save, reopen, rename and delete projects. Migrate project v1 and legacy presets
  forward without loss.
- Undo and redo over project changes. Telemetry is never part of history.
- Export to WAV by rendering offline with the same engine (the MCP companion already
  does this in Node).
- Reliability: rapid parameter changes, tab suspension, device changes, long sessions.

## Night 6: NativePHP packaging and MCP reconnection

- Move from the abandoned `nativephp/electron` and `nativephp/laravel` to
  `nativephp/desktop`, and fix the leftover `dev.floor.stemmachine` app id.
- Package the desktop app and run the audio probe *inside* the package.
- Resync `bckgrnd-msc-mcp` to the current engine and adopt the project contract for
  its presets, with tests in both repos.
- A separate mobile compatibility check, reported as such.
