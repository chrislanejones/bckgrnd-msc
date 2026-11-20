# Night 8: phrase-ending fills, Fill into Drop, Drop + Crash (proposal)

Status: **proposal, 11-19-2026.** Nothing here is built. It extends
`docs/NIGHT3_PROTOCOL.md` (fills, scene timing), `docs/NIGHT4_PROTOCOL.md` (lanes) and
`docs/NIGHT7_PROTOCOL.md` (builds), and follows ADR-015: the engine owns musical timing,
every request ends in an explicit outcome, and nothing on the audio path allocates.

## Order of work

| Order | Feature | Why this order |
|---|---|---|
| 1 | **A. Phrase-ending fills** | Small engine change (a new start rule for the one fill slot); B needs it |
| 2 | **B. Fill into Drop** | Links a fill and a scene into one request. Waits on Silas's staging fix (`night8/staging`) |
| 3 | **C. Drop + Crash** | Separate follow-up: a contract change (scene field) and an ADR-008 amendment |
| later | Stutter / beat repeat | After A–C are in and Chris has listened to them |

## What exists today

| Piece | Today |
|---|---|
| Fill | One per track, one bar (16 steps), from `Fills.php`. Replaces the drum lanes its recipe defines |
| Fill timing | Next bar line only (`FILL_GRID = 16`), on the onset serial |
| Fill slots | One pending, one active; a second request is refused (8) |
| Onset order | edit → scene → build → **fill** → notes → transition sounds (`lib.rs`) |
| Phrase | Not an engine idea. Auto mix uses 4-bar phrases on the absolute grid (`samples_to_next_downbeat(4, …)`); the song is four 4-bar parts (ADR-008) |
| Crash | `transition.rs` crash on the Drop's natural crossing (step 192) only; a scene launch is silent by design (ADR-008) |

## A. Phrase-ending fills

### Behavior

A fill can be set to **end on the phrase line** instead of starting on the next bar.
**Phrase length is a choice: 2, 4, 8 or 16 bars**, aligned to step 0, default **4** (the
grid Auto mix and the song form already use). All four divide the 16-bar song form, so
every phrase line is also a 16-bar line or falls inside one evenly. Chris, 11-19-2026:
"maybe there can be variations".

| Phrase | Steps | Fill (Bar) starts on | Feel |
|---|---|---|---|
| 2 bars | 32 | step 16 of 32 | Busy: a fill every other bar |
| **4 bars (default)** | 64 | step 48 of 64 | The song's own part length |
| 8 bars | 128 | step 112 of 128 | One fill per two parts |
| 16 bars | 256 | step 240 of 256 | Once per song pass, before the top |

| Choice | Starts | Plays | Ends on |
|---|---|---|---|
| Next bar (today) | Next bar line | 16 steps, recipe 0–15 | The bar line after |
| Phrase end · Bar | The phrase's last bar line (step 48 of 64 at 4 bars) | 16 steps, recipe 0–15 | **The phrase line** |
| Phrase end · Beat | The phrase's last beat (step 60 of 64 at 4 bars) | 4 steps, recipe 12–15 | **The phrase line** |

"Beat" reuses the last beat of the existing one-bar recipe, which is where its roll
sits. PHP doesn't need new recipes. If a recipe's last beat turns out too thin, a
`beat` recipe in `Fills.php` can come later without changing the engine call.

### Engine scheduling

- `queue_fill_at(request_id, index, phrase_bars: u8, length: u8) -> u8`, where
  `phrase_bars` is 0 (next bar, today's behavior) or 2, 4, 8 or 16, and `length` is 0 bar
  or 1 beat. Any other value is refused. `queue_fill(id, i)` stays as
  `queue_fill_at(id, i, 0, 0)`. The phrase length rides on the request, so the engine
  keeps no phrase setting of its own.
- `PendingFill` gains `start_serial: u64` and `first_pos: u8` (0 or 12). Both are
  fixed-size, so nothing allocates.
- On queue, walk the clock with `Transport::following` (as `predict` does, bounded by
  `STEPS`) to the first start step whose fill would end on a phrase line, then store
  `start_serial = serial + onsets_until_start`. `fill_onset` starts the fill when
  `serial == start_serial`. Counted in onsets, so tempo changes move nothing.
- **Too late for this phrase:** if the start step has already passed (for example a
  Bar fill asked for during bar 4 of a 4-bar phrase), the fill goes to the **next**
  phrase, up to one phrase away (16 bars at the longest). The `fill queued` bar number says which.
- **Loops:** the phrase end is the first bar (or beat) whose end is a phrase line **or
  the loop's wrap**. So in a 1- or 2-bar loop the fill plays the loop's last bar and
  turns it around. A loop change while a fill waits recomputes `start_serial` and
  re-announces (`fill queued` again), as scenes and builds do.
- A fill still plays in full once started. The existing rule stands: a playing fill
  isn't cut short except by an interrupt.

### Events and reasons

There are no new events for A. `fill started` (12) carries `b` = the first recipe
position (0 or 12), where today it is always 0. A bad `at` or `length` is
refused with the existing reason 1 (invalid).

### Cancel and replace

Unchanged from Night 3: the user's cancel (10) works while it waits, and Stop (2),
transport (3), track (4) and panic (5) cancel it or cut it short. There's still no
stacking: a second fill is refused with 8.

## B. Fill into Drop

### Behavior

One press: the fill plays the phrase's last bar (or beat), and the scene **commits on
the phrase line**, on the same onset the fill ends. There's no gap, because the
scene commits before the fill ends on that onset and before that step's notes. So
the downbeat plays the new scene's drums, not silence and not the fill.

### Engine scheduling

- `queue_fill_into(fill_id, index, length, scene_id, values: &[f32]) -> u8`.
  - `at` is always phrase end.
  - The scene's lanes, if any, are staged first with
    `queue_patterns(patternsId, 2, link = scene_id, data)`, the scene path today.
- **Atomic.** It validates the scene vector, the fill index, the transport, `fill_busy`
  and the staged lanes **before changing anything**. Either both parts are queued or
  neither is.
  - On refusal the engine posts `fill rejected` (15) and `scene rejected` (5), both with
    the same reason, and `b` = the part refused (1 scene, 2 fill, 3 lanes).
  - A scene or build already pending keeps its own lanes. **This depends on the
    transactional staging slot from `night8/staging`.** B must not merge before it.
- The pending scene gets a new `Timing::Linked`, whose deadline is
  `start_serial + 16` (or `+ 4`). `on_onset` commits it when `serial` reaches it. The
  existing order on that onset is unchanged:

  > edit → **scene commits** (with its lanes) → build → `fill_onset` (**fill ends**,
  > `pos` reaches its length) → notes.

- No new slots: it uses the one pending scene and the one pending fill, tied by ids.

### Events: a new decade, 51+

41–47 are builds; 48–50 stay free for builds.

| kind | name | a | b |
|---|---|---|---|
| 51 | fill linked | id of the scene it leads into | predicted landing step |
| 52 | fill unlinked | reason | 0 |

The scene reports the usual 1–5 (`scene queued` gives the landing bar), and the fill
reports 11–15.

New reason **11 linked**: one part was refused or canceled because its partner was.

### Cancel and replace

| Situation | Outcome |
|---|---|
| User cancels before the fill starts (pad or Fill pressed again) | Both canceled, 10 |
| User cancels while the fill plays | Scene canceled, 10; fill plays out its bar (Night 3 rule) |
| Stop, seek, scratch, brake, track, panic | Both canceled or cut short with that reason (`interrupt` already does both) |
| Another scene launched while linked | Scene `replaced` (latest wins); the fill **unlinks** (52, 10) and plays as a plain phrase-end fill |
| A Rise queued while linked | Scene `replaced` by the build (Night 7 rule); fill unlinks (52, 10) |
| A Rise running when Fill into lands | The scene commits and replaces the build on the phrase line (Night 7 rule); the fill plays on top as usual |
| A pattern edit while linked | Unaffected (Night 4 rules); on a lane both set, the scene's wins |

### Pattern lanes

The scene's captured lanes land on the phrase line with it, exactly as a scene launch's
do. The fill only overrides drum lanes for its own bar and touches no stored lanes.
A refused or canceled Fill into withdraws only its own staged lanes. That's the
same acceptance rule as the staging fix: a refused request never strips an accepted
one's.

## C. Drop + Crash (separate follow-up)

### Behavior

A scene can carry **`accent: "crash"`**. When it commits **during playback**, the track
kind's crash (`transition.rs`) fires on that onset. It's off by default and never
automatic: you set it per scene from the scene menu ("Crash on launch").

| Rule | Why |
|---|---|
| A scene applied while stopped: no crash | Nothing is playing to accent |
| On the natural Drop crossing (192) the crash fires once, not twice | ADR-008's crash already fires there |
| Under a solo: counted, silent | Same rule as ADR-008's transition sounds |
| A Rise landing on a crash scene: crash on the end onset | The landing is a commit |
| Fill into a crash scene: crash on the phrase line | Same |

### Contract and engine

- Project scenes gain an optional `accent` field (`contracts/scenes.json`, schema, PHP
  and TS readers, fixtures).
  - Absent means none, so v3 files still load unchanged.
  - Whether that's an additive v3 field or a v4 bump is an ADR-012 call.
- The scene vector stays 44 values. The accent travels as a separate `u8` on
  `queue_scene`, on the `land` of `queue_build`, and on `queue_fill_into`.
- New event **53 accent fired**: `a` = step, `b` = 1 played, 0 silent under solo,
  2 merged with the natural crash.

## UI feedback

| Where | A | B | C |
|---|---|---|---|
| Fill button | "Fill · Bar 8" (phrase end) / "Fill playing" | "Fill · Bar 8 → Drop" | — |
| Control | A "Fill at" picker beside Fill: **Next bar · Phrase end**, plus Bar · Beat; with Phrase end, a **2 · 4 · 8 · 16** bars picker (the Rise bars pattern, remembered) | A Switch on choice **Fill** (pads launch with a fill and land on the phrase line) | "Crash on launch" in the scene menu; a small mark on the pad |
| Pad lines | — | "Fill in · Bar 9" → "Filling into Drop" → "Active" | Unchanged |
| Status line | "Fill queued for the end of bar 8" | "Drop lands on bar 9 after a fill" / "… not started: <reason>" | "Drop active, with a crash" |
| Shortcuts | — | Shift+1–4 follows Switch on, so it does Fill into with Fill on | — |

**Width.** The Switch on row now fits at 1180 and 1280 px (Lacey, `ccf3ece`, with checks at
nine widths). A fifth option, and the phrase bars picker beside Fill, have to be measured
against those checks before they are accepted. The phrase picker can share the space the
Rise bars picker uses, since a Rise and a phrase fill are rarely set up at the same moment. The fallback is a Fill
toggle next to the Fill button, so Switch on stays at four options.

## Accessibility

- Every state has a full aria-label, such as "Fill into Drop at the end of bar 8.
  Press again to cancel."
- The status line is a polite live region, announced once per state change and never
  per bar (Night 7's rule).
- The pickers are `Segmented` radio groups with visible labels, or labeled and hidden
  where space is short (the Rise bars pattern).
- Touch targets stay at least 44 px. Nothing relies on color alone: the queued and
  linked states have text.
- Reduced motion: the pad's progress rule doesn't animate between bars; it steps.

## Tests

| Layer | Cases |
|---|---|
| cargo (`fill_tests.rs`, new) | For each phrase length 2/4/8/16, Bar starts one bar before every phrase line (4 bars: 48/112/176/240) and Beat one beat before; bad `phrase_bars` (3, 5, 32) refused; a late request rolls to the next phrase; a 1-bar, a 2-bar and a phrase-aligned loop; a tempo change while waiting moves nothing; a loop change re-announces; `fill started` b = 0 / 12 |
| cargo (Fill into) | The scene commits on the onset the fill ends; the landing step's kick is the scene's, not silence and not the fill; render energy is continuous across the line (no gap); refusal is atomic for each part; lanes untouched on refusal; each row of the cancel/replace table; interrupts end both |
| cargo (C) | Crash fires once on commit; once on 192 (merged); silent under solo; none when stopped; on Rise landing and Fill into |
| cargo, no allocation | Queue, wait, start, land and cancel under a counting allocator. Use the one `night8/staging` adds if it lands; otherwise add one |
| bench | `cargo bench --bench render`: compare against `plain` from the same run (±4% drift on this machine) |
| check-scenes.mjs | Folding 51–53 and reason 11; pad and status lines for each state; Fill into wire message shape |
| verify-ui.mjs | Fill at picker; Fill into sequence (queued → filling → active); cancel at each stage; aria-labels; Switch on row width at 1180/1280/1440; Shift+N with Fill on |
| Listening (Chris) | Fill into Drop at 70, 105 and 140 bpm; Bar against Beat; a crash scene against the natural 192 crash |

## Decisions applied (11-19-2026)

All seven questions are answered in `docs/NIGHT8_DECISIONS.md`. Where this spec says
otherwise, the decisions win:

| # | Decision | Changes to this spec |
|---|---|---|
| 1 | Phrase 2 · 4 · 8 · 16 bars, default 4, loop end counts; an app preference | As written above |
| 2 | A late press queues for the next phrase, never refused | As written above; the Fill button reads "Fill · Next phrase" when it rolls over |
| 3 | One-bar fill only for now | **Drop "Phrase end · Beat"** and `first_pos`. Keep the `length` argument (0 only for now) so more lengths fit later |
| 4 | Next bar stays the default; Phrase end added; Now kept where supported | Fill has no Now today; nothing to add |
| 5 | Fill → Drop is its own action beside Fill | **No fifth Switch on choice.** A "Fill → Drop" button beside Fill; Shift+N unchanged |
| 6 | Rise can finish with a fill (toggle, off) | **In scope** (was B2): `queue_build` gains a fill index; the fill plays the Rise's last bar; the landing scene and lanes commit on the next downbeat, atomically |
| 7 | Crash accent saved per scene, off, in the versioned project format | As section C; the project-format change needs ADR-012/014 handling |

Later, not Night 8: fill variations (Simple, Busy, Syncopated).

## ADR-level decisions (for Dara)

| Decision | Touches |
|---|---|
| The engine knows a phrase grid of 2, 4, 8 or 16 bars, passed per request (and the loop wrap) for fills | Bends ADR-001 again, as ADR-008 did. Same pre-mortem: a track form that isn't 4-bar parts |
| A fill and a scene can be one atomic linked request with a shared deadline | Extends ADR-015 ("one scene and one fill") and leans on the staging fix |
| A scene launch may make a transition sound when the scene says so | Amends ADR-008 ("a launch makes no transition sound") |
| Scenes gain an `accent` field | ADR-014 (scene contents), and ADR-012 (whether it's a version bump) |
| A new event decade, 51+, and reason 11 | Protocol only; record it in the Night 8 protocol, not an ADR |
