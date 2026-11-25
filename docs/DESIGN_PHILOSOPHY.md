# Design philosophy

**Music first. Tactile controls. Clear feedback. Progressive complexity.**

bckgrnd-msc is one instrument, not a collection of controls added over time. Every
screen, control and color should pass the rules below. When a change can't, the rule
wins or the rule gets rewritten here first. A quiet exception in the code doesn't count.

This is the standard for every night in [ROADMAP.md](ROADMAP.md).

## The five principles

### 1. Music first

The interface helps someone understand three things at a glance:

1. **What is playing.** The track, the song part, the bar, the tempo, and which stems
   are sounding.
2. **What they can change.** Controls look like controls and sit where you'd look
   for them.
3. **What will happen next.** The next track, the next part, and anything queued.

Decorative animation never competes with that information. Motion is allowed when
it carries information (the playhead, meters, a spinning platter that says "this deck
is running") and is switched off under `prefers-reduced-motion` when it is only
decoration.

### 2. Tactile, not ornamental

Knobs, faders and pads should suggest how they work: a pad looks pressable, a fader
looks like it slides, a platter looks like it turns. Depth and lighting are allowed
when they say "you can press or turn this". Avoid excessive gloss, fake screws,
brushed-metal wallpaper and other decoration unrelated to the control.

Rules:

- Pressable surfaces have a raised gradient and a 2 px bottom shadow. Pressing scales
  them to 0.96.
- Engaged surfaces are filled acid. There is no third "half-engaged" look. A state
  that needs one gets a status indicator instead.
- Touch targets are at least 44 px (`--control-md`) on a touch screen and on the
  phone tier. With a mouse on a desktop-sized window, the compact density below may
  take toolbar buttons to 32 px; nothing a mouse presses goes under 24 px.

### 3. Restrained color

Keep the dark surfaces and the acid-green identity. Color explains state. It does
not decorate every stem differently.

| Role | Token | Used for |
|---|---|---|
| Ground | `--color-bg` | The page. |
| Surface | `--color-surface`, `--color-raised` | Panels, inactive controls. |
| Rule | `--color-line` | Borders, tracks, empty meter wells. |
| Text | `--color-fg`, `--color-muted` | Primary and secondary text. |
| **Active** | `--color-acid` | On, engaged, live, sounding. The only accent for state. |
| **Warning** | `--color-warn` | Needs attention but isn't broken: "silent because something else is soloed", a meter running hot at the limiter. |
| **Error** | `--color-danger` | Broken or harmful: an engine fault, the master clipping. |
| Deck B | `--color-deck-b` | Deck identity only (the B label and its waveform head). Never a state. |

The waveform's three bands (low blue, mid acid, high white) are a measurement and are
allowed to differ. Nothing else uses color as decoration.

### 4. Progressive complexity

Someone should be able to press Play and start cutting stems right away. The first
screen holds the transport, the decks, the stems and the performance pads. That's
all it holds.

Everything else opens when it is needed:

| Opens when | What |
|---|---|
| You select a stem, or open the Master tab | The inspector: the detailed controls for that stem or for the master effects. |
| You open the Pattern drawer | The pattern editor. In Night 1 it is a read-only view of the full 16-bar pattern. |
| You open the library panel (always open on wide screens) | Tracks, styles, favorites, saved projects. |

A detailed control never lives on the first screen just because there was room for it.

### 5. Visible cause and effect

Never make the user guess why something is silent. Every stem shows exactly one of
these states, with the same words and the same treatment everywhere:

| State | Meaning | Treatment |
|---|---|---|
| **Playing** | In the mix and has notes in this bar. | Acid dot. Strip at full strength. |
| **Resting** | In the mix, but the song has no notes for it in this bar (the stab, lead and arp sit out the intro, and the break drops the drums). | Hollow dot, muted text "Rests this bar". Strip at full strength. |
| **Cut** | You cut it. | Filled neutral dot, "Cut". Strip dimmed. Cut badge lit. |
| **Soloed** | You soloed it. | Acid dot, "Solo". Solo badge lit. |
| **Off by solo** | Silent because *another* stem is soloed. | Warning dot, "Off: solo on Bass". Strip dimmed. Cut stays unlit because this stem was not explicitly cut. |
| **Queued** | A scene or fill waiting for its boundary. | Scene pads and the Fill button (Night 3): dashed acid outline that pulses (no pulse under reduced motion), "Queued · Bar 9" or "Fill · Bar 9". |

The same rule applies everywhere else. A disabled control says why. A deck that
can't be scratched says "Mixing". The save indicator says whether your changes
would survive a reload.

## Tokens

All tokens live in `@theme` in [`frontend/styles.css`](../frontend/styles.css). Use
them, not ad-hoc values.

| Kind | Tokens |
|---|---|
| Spacing | `--space-1` 0.25rem · `--space-2` 0.5rem · `--space-3` 0.75rem · `--space-4` 1rem · `--space-6` 1.5rem |
| Control sizes | `--control-sm` 2rem (badges) · `--control-md` 2.75rem (44 px touch minimum) · `--control-lg` 3.25rem (pads) |
| Radii | `--radius-control` 0.875rem (pads, panels) · pills use `999px` |
| Type | `--text-label` 0.6875rem uppercase, tracked 0.1em, for control labels · `--text-value` 0.8125rem tabular for readouts · body 0.875rem |
| Focus | 2 px acid outline at 2 px offset, `:focus-visible` only. Never removed, never recolored. |
| Density | `--panel-pad-y` · `--section-gap` · `--heading-gap` · `--card-pad-y` · `--toolbar-h` · `--button-sm-h` · `--group-gap` · `--knob-size` (see Density, below) |

## Density

**Every pixel of vertical space must earn its place.** bckgrnd-msc is a professional
hardware groovebox, not a dashboard of oversized cards. Adopted in Night 7
(11-16-2026).

- **Compact by default** for a mouse on a desktop-sized window
  (`(pointer: fine) and (min-width: 900px)`).
- **Comfortable when touch requires it.** A coarse pointer and the phone tier keep
  44 px targets. Text sizes never shrink for density; 11 px (`--text-label`) is the
  floor everywhere.
- **Details on demand.** Secondary information lives in a tooltip, a menu or the
  inspector, not in a permanent row.
- **No repeated explanatory text.** One short hint per area at most, and it says the
  next step. No introductory paragraph per section.
- **No unnecessary nested containers.** A card never sits inside another card. A
  group inside a panel is separated by a gap or a single rule, not a second border.
- **No scrolling to reach a control that could fit.** Related actions share one row;
  a status line goes in the header beside the title rather than in a row of its own.
- **Stable under performance.** A row whose words change while playing (a stem's
  status, a scene's state) keeps a fixed height, so nothing moves under the hand.

Panels and toolbars use the shared tokens in [`frontend/styles.css`](../frontend/styles.css)
instead of their own fixed padding:

| Token | Compact (desktop, mouse) | Comfortable (touch, phone) | Used for |
|---|---|---|---|
| `--panel-pad-y` | 8 px | 12 px | A panel's top and bottom padding |
| `--section-gap` | 8 px | 12 px | Between groups inside one panel |
| `--heading-gap` | 6 px | 12 px | From a panel or group heading to its content |
| `--card-pad-y` | 6 px | 10 px | Scene cards, mixer channels |
| `--toolbar-h` | 34 px | 44 px | One row of related actions |
| `--button-sm-h` | 32 px | 44 px | Text buttons and segments inside a toolbar |
| `--group-gap` | 6 px | 8 px | Between controls in one group |
| `--knob-size` | 48 px | 56 px | A knob's dial, so the docked inspector fits 1440 × 900 |

**Review rule.** Before approving a redesign, count the interactive controls fully
visible in a fixed 1440 × 900 desktop viewport, before and after, without scrolling.
A redesign that shows fewer usable controls in that first screen needs a reason
written in its review.

## Layout

| Area | Contents |
|---|---|
| **Persistent transport** (top) | Play/stop, track name, tempo, current section and bar, master meter, save status. Visible in every view at every width. |
| **Library panel** (left) | Tracks by section and style, a favorites filter, saved projects. Collapsible. |
| **Performance area** (center) | The two decks, the jog wheel and pads, loop, the mix-to-next controls, and the eight-stem mixer. |
| **Inspector** (right) | The selected stem's controls, or the master effects. |
| **Editor drawer** (bottom) | The pattern editor. Opened on purpose. It never permanently takes space. |

The Stems panel lets its controls and layout explain the eight musical layers.
Each channel has a short sound description and a visible key number.
Quick selections say what remains audible: All sounds, Drums only, Music only.
Level, Solo, and Cut have visible explanations. Cut becomes Bring in when muted;
Reset restores that channel's original volume. Eight channels share a mixer
surface and wrap into rows on narrower screens instead of hiding sounds behind
horizontal scrolling. Keep supporting explanations brief, muted, and at
`--text-label` (11 px); avoid introductory paragraphs and repeated tips.

Scenes and comparison follow in a separate panel. The four scene cards share one row
on desktop and lead with their name, then a short sound cue, then a miniature preview
of their eight stored levels beside the card's state. Preview bars respect cuts and
solos; custom captures never keep a misleading factory description. The panel
header holds the scene status line and a small Shift 1–4 tag. Under the cards the
toolbar has three rows, each one control high (32 px with a mouse): Switch on (Now,
Next beat, Next bar, Rise, with 2 · 4 · 8 bars and Finish with Fill beside it while
Rise is on) and Cancel; then Fill at (Next bar, Phrase end, with 2 · 4 · 8 · 16 bars
for Phrase end), Drum fill and Fill → Drop; then Compare A/B. The scene and fill
controls can't share one row: squeezed as far as they go they need about 950 px, and
the panel is 798 px wide at 1440. Choosing an option never adds a row, so the toolbar
is 108 px at every mouse width from 900 to 1440. Compare A/B is one strip set off by a
rule: dashed capture buttons become listening buttons with headphone icons, and a
single short hint gives the next comparison step. Current, modified, and queued states
use both text and visual treatment.
Once the scenes panel is 45rem or narrower, Switch on uses its short names (Now, Beat,
Bar, Rise), as the phone does, so Rise never wraps the row; the full names stay the
accessible names. With a mouse, below 38rem (the 1180–1279 px three-column layout, and
900–1000 px with the inspector docked) the pills tighten, the word "bars" goes and
Fill at's word is hidden (kept as the group's name), so every row still holds; the
stacked, thumb-sized toolbar below 34rem is for touch only. On a phone, Rise's bars
and Finish with Fill share a row, and Drum fill and Fill → Drop split theirs by their
words, so "Fill · Next phrase → Drop" is never cut short.
The pickers (Switch on, Rise over, Fill at, the phrase length) are radio groups: one
tab stop each, arrow keys move and pick. Finish with Fill is a switch and Crash on
launch a checkbox. A fill button that can't be pressed is aria-disabled, not
disabled, so it keeps focus and its reason is read as its description.

The inspector fits 1280 × 800 and 1024 × 768 without scrolling. Its one preference
(how knobs turn by dragging) sits beside the Master/stem tabs as an icon pair, a note
such as Resonance's "Heard as it closes" stands in its row's spare third column, and
Output's fold is remembered per viewer (folded until chosen).
The Scenes and Deck panels form one performance surface (Night 10): one border, split
by a single rule, with no gap between two cards. Scenes holds the transition group
(scenes, Switch on and Rise, Fill, Fill → Drop) and Deck holds the momentary group.
Beside the jog wheel, the Deck's pads sit on one five-column grid in three rows. The
first row is the deck's own gestures (Cue, Brake, Backspin, Bend −, Bend +). The second
is **Hold FX**: Echo and Filter, then Beat Repeat in column three with its 1/4 · 1/8 ·
1/16 division across columns four and five. The third is Loop, with Release FX in column
five, apart from the held pads. That column is shorter than the jog column, so moving
Loop into it saved the deck a row. Panic stays in the transport (or the phone's dock), so
it never scrolls away with the surface.

States read the same everywhere on the surface (Night 10). They use the acid tokens
`--state-queued-dim`, `--state-active-tint`, `--state-active-ring` and
`--state-held-glow`:

| State | Means | Treatment | Where |
|---|---|---|---|
| Rest | Nothing happening | Raised gradient, `--color-line` border | Every pad and fill button |
| Queued | Waiting for its beat, bar or phrase | Dashed acid border that pulses (no pulse under reduced motion), and the boundary in words | Scene pads, Fill, Fill → Drop |
| Active | Running or latched | Solid acid border, inset acid ring, 7% acid tint, acid words | The active scene, a Rise building, a fill playing |
| Held | A hand is down | Filled acid, acid-ink words, glow | Echo, Filter, Repeat, Bend ± |

Filled acid means a hand is holding something. A choice pill (Switch on, Loop, the
Repeat division) is also filled when picked, because that is what a picked choice looks like.
Cancel clears the selected scene and returns to the mix from before scene choices.
It stays available for an active scene even when nothing is queued.

The pattern editor keeps its drawer, lane tabs, canvas, and editing toolbar in
place when switching lanes. Read-only lanes use the same space and a small hint.

Breakpoints:

- **≥ 1180 px:** library, performance area and inspector side by side. The drawer
  opens over the bottom of the performance area.
- **900 – 1179 px:** the library collapses to an overlay opened from the transport.
  The inspector stays.
- **< 900 px (phones):** one view at a time, chosen from a tab bar: **Perform**
  (decks, pads, stems), **Mix** (stems and the master effects), **Edit** (the
  pattern and the selected stem). The transport stays pinned. The library opens as a
  sheet. The phone never squeezes in the desktop layout.

## Control shells

Shared components in [`frontend/ui/controls.tsx`](../frontend/ui/controls.tsx). New
controls are built from these and don't restyle them locally.

| Shell | Job |
|---|---|
| `ControlLabel` | The uppercase label above or beside a control. |
| `ValueReadout` | The value next to a label: tabular figures, a unit, and words where a number means nothing ("Stereo", "Off"). |
| `InstrumentPanel` | A titled panel with an optional action in its header. The unit of layout. |
| `PerformancePad` | A raised, pressable pad, momentary or latching, with an optional "held" state. |
| `MixerChannel` | One stem: name, sound description, shortcut, status, vertical fader, meter, Solo, Cut / Bring in, and Reset. |
| `StatusIndicator` | A dot plus words for one of the states above. |
| `Knob` | Every continuous control that turns. One implementation, in [`frontend/ui/Knob.tsx`](../frontend/ui/Knob.tsx). |
| `Fader` | Stem volumes, which stay faders: a row of eight faders reads as a mixer at a glance. |

## Knobs

- **It turns.** A 270° sweep. The indicator's angle comes from the real value
  through the parameter's mapping ([`frontend/lib/mappings.ts`](../frontend/lib/mappings.ts)),
  so the knob shows what the engine has.
- **The light doesn't move.** Only the indicator rotates. The face, its highlight,
  the ticks and the arc track stay fixed.
- **Each parameter has its own curve.** Frequencies are exponential and read in
  Hz/kHz. Gains are laid out in dB. Isolators put unity at twelve o'clock. Times are
  logarithmic. Discrete choices (echo divisions, loop lengths) are stepped buttons,
  never a knob.
- **Units that mean something:** 2.4 kHz, −6.0 dB, 35%, 0.32 s, 1/8., Open, Kill, Mono.
- **States:** default, focused (a ring round the dial), dragging (the arc and pointer
  brighten), disabled (dimmed, with a note saying why), modified (the label lights and
  Reset appears), and changed from outside (the readout flashes briefly).
- **No control without an effect.** If a control can't change the sound in the
  current state, it's disabled and says why ("Echo is off"), rather than moving a
  number nobody hears.
- **One edit per gesture.** A drag, a held key, a reset or a typed value is one entry
  in the edit log, never one per intermediate value.

## Testing controls with touch screen readers

Custom sliders often work with a desktop keyboard and fail with VoiceOver on iOS or
TalkBack on Android, whose swipe-to-adjust gestures send no key events. The knob's
accessible control is therefore a native `<input type="range">`, which both platforms
adjust as a slider. That is a design choice, not proof. The checklist below has
**not yet been run on a device**; it belongs to the mobile compatibility check.

- [ ] VoiceOver (iOS Safari): swipe to a knob. It reads the label and the value in
      words ("Cutoff, Open, 18 kilohertz, adjustable").
- [ ] Swipe up and down adjusts it, and the sound follows.
- [ ] Double-tap and hold, then drag, doesn't leave it stuck after letting go.
- [ ] TalkBack (Android Chrome): the same three.
- [ ] The value button reads as "Type a value" and opens the field.
- [ ] A disabled knob reads as dimmed and its note is read.

## Architecture boundaries

The split from [ADR-001](adr/001-php-owns-the-music-rust-owns-the-dsp-react-only-renders.md)
holds through the redesign:

- **PHP owns the music.** Song form, note grid, swing, tempo and the stem mix.
- **Rust owns the DSP.** Every voice, filter and effect, and the sample clock that
  timing decisions are made on.
- **React presents and sends intent.** It never schedules a note, never keeps a
  musical clock, and never decides when something happens musically. `setInterval`
  in React is only for visual easing (the post-mix tempo glide is the one existing
  case, and it moves a control, not a note).
- **Quantized actions are the engine's job.** When Night 3 adds "on the next bar",
  React sends the intent and the engine fires it on its own sample clock. React shows
  it as **Queued** until telemetry says it happened.

The saved musical data and the transient playback telemetry are separate types.
The first is the project contract in [`contracts/`](../contracts/README.md). The
second is the worklet's telemetry frame. Nothing from telemetry is ever saved.

## Checklist for any UI change

- [ ] Can someone press Play and cut a stem without reading anything?
- [ ] Does every silent stem say why?
- [ ] Is color used only for state (or deck identity)?
- [ ] Can it be reached and operated with the keyboard, with a visible focus ring?
- [ ] Does it work at 375 px wide without horizontal scroll?
- [ ] Does it respect `prefers-reduced-motion`?
- [ ] Does it use the density tokens, and does it show at least as many usable
      controls in a 1440 × 900 viewport without scrolling as before?
- [ ] Does React still hold no audio state and no musical clock?
