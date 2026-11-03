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
- Touch targets are at least 44 px (`--control-md`). The only smaller targets are
  secondary badges inside a larger hit area.

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
| **Off by solo** | Silent because *another* stem is soloed. | Warning dot, "Off: solo on Bass". Strip dimmed. Cut badge lit. |
| **Queued** | A change waiting for the next bar or phrase. | Reserved for Night 3 (quantized performance). Pulsing outline, "Next bar". |

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

## Layout

| Area | Contents |
|---|---|
| **Persistent transport** (top) | Play/stop, track name, tempo, current section and bar, master meter, save status. Visible in every view at every width. |
| **Library panel** (left) | Tracks by section and style, a favorites filter, saved projects. Collapsible. |
| **Performance area** (center) | The two decks, the jog wheel and pads, loop, the mix-to-next controls, and the eight-stem mixer. |
| **Inspector** (right) | The selected stem's controls, or the master effects. |
| **Editor drawer** (bottom) | The pattern editor. Opened on purpose. It never permanently takes space. |

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
| `StemStrip` | One stem: spine, status, meter, bar pattern, fader, Solo and Cut. |
| `StatusIndicator` | A dot plus words for one of the states above. |

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
- [ ] Does React still hold no audio state and no musical clock?
