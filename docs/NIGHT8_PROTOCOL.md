# Night 8: phrase fills, Fill into, Rise + Fill, crash accents (the working protocol)

The engine calls, worklet messages and events for Night 8. The specification is
`docs/NIGHT8_SPEC.md` as amended by `docs/NIGHT8_DECISIONS.md`; this file pins down
what was built, and the decisions the spec left open. It extends
`docs/NIGHT3_PROTOCOL.md` (fills, scenes, events, reasons), `docs/NIGHT4_PROTOCOL.md`
(lanes) and `docs/NIGHT7_PROTOCOL.md` (builds), and follows ADR-015: the engine owns
musical timing, every request ends in an explicit outcome, and nothing on the audio path
allocates. Where this file and the code disagree, the code is wrong.

## Phrase fills

### The request

| Engine (`engine-core/src/fills.rs`) | Returns |
|---|---|
| `queue_fill_at(request_id: u32, index: u32, phrase_bars: u8, length: u8) -> u8` | 0 accepted, else the reason (also reported as `fill rejected`) |
| `queue_fill(request_id: u32, index: u32) -> u8` | Unchanged: `queue_fill_at(id, index, 0, 0)` |

- `phrase_bars` is 0 (the next bar, the Night 3 fill) or 2, 4, 8 or 16. Anything else
  is refused, reason 1.
- `length` is 0, one bar. Anything else is refused, reason 1. The argument is there so
  that more lengths fit later without changing the call (`NIGHT8_DECISIONS.md` §3).
- Other refusals are unchanged: 1 no such fill, 7 not playing, 3 a scratch, brake or
  backspin, 8 a fill already queued or playing.
- The phrase length rides on the request. The engine keeps no phrase setting of its
  own: phrase length is an app preference (`NIGHT8_DECISIONS.md` §1).

### Timing

- **Phrase lines sit on the absolute grid from step 0**, every `phrase_bars × 16` steps.
  All four lengths divide the 256-step song, so the song's own wrap is always a phrase
  line too.
- The fill plays **the first bar whose end is a phrase line or the loop's wrap**,
  counting from the step due next. With phrase 0 that is simply the next bar line.

  | Phrase | Bars the fill plays (no loop) |
  |---|---|
  | 2 bars | 16, 48, 80, 112, 144, 176, 208, 240 |
  | 4 bars | 48, 112, 176, 240 |
  | 8 bars | 112, 240 |
  | 16 bars | 240 |

- **Late presses roll on.** The walk only looks ahead, so a press after the phrase's
  last bar line has passed (anywhere in its last bar, or on that line's own onset) goes
  to the next phrase end, at most one phrase away (16 bars at the longest). It is never
  refused for being late. `fill queued` names the bar, so the host can say "Fill · Next
  phrase".
- **Counted in onsets.** On queue the engine walks the clock with `Transport::following`
  (bounded by one pass of the song) and stores `start_serial`, the onset serial of the
  fill's first step. Tempo changes move nothing.
- **Loops.** The loop's wrap is a phrase end, so in a 1-bar loop the fill plays the next
  bar, and in a longer loop it plays the loop's last bar unless a phrase line inside
  the loop comes first. Setting, changing or clearing the loop while a fill waits works
  `start_serial` out again from where the playhead is and reports `fill queued` again.
- A fill still plays all sixteen steps once started; only an interrupt cuts it short
  (Night 3).

### Events

No new kinds for phrase fills.

| kind | name | a | b |
|---|---|---|---|
| 11 | fill queued | the bar it plays (1-based) | its first step |
| 12 | fill started | step | 0, the first recipe position (one-bar fills only) |

The spec's "Phrase end · Beat" (`b` = 12) is not built: `NIGHT8_DECISIONS.md` §3 drops
it.

### Worklet messages

| Host → worklet | Engine call |
|---|---|
| `{type: 'fill', requestId, generation, index, phrase?, length?, deck?}` | `queue_fill_at(requestId, index, phrase ?? 0, length ?? 0)`. A phrase other than 0, 2, 4, 8 or 16, or a length other than 0, goes in as 255 (refused, reason 1) |

The host API is `EngineHost.queueFill(requestId, index, generation, phrase = 0)` with
`FILL_PHRASE_BARS` in `frontend/lib/engine.ts`.
