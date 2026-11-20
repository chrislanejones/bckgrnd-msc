# Night 8: Chris's product decisions (11-19-2026)

These decisions are approved for the Night 8 implementation. Where they differ from
`NIGHT8_SPEC.md`, this file wins; the spec's "Decisions applied" table lists each change.

## 1. Phrase length
- Support 2, 4, 8 and 16 bars. Default 4.
- A loop's end also counts as a phrase boundary.
- Phrase length is an app preference (like Rise's bars), not a project-format change.
  Revisit if people build different performance setups per project.

## 2. Late Fill requests
- Never refuse a valid Fill because the current phrase is in its last bar.
- Queue it for the next eligible phrase end.
- Show the queued destination clearly, for example "Fill · Next phrase".

## 3. Fill length
- Keep the existing one-bar fill for the first implementation.
- No dedicated one-beat fills yet; a one-beat fill is a different musical event.
- Keep the engine call open to more fill lengths later.

## 4. Fill timing
- Next bar stays the default.
- Add Phrase end as the alternative.
- Keep Now where it's supported.

## 5. Fill into Drop
- A separate performance action beside Fill, not a fifth Switch on choice.
  Full, Sparse, Build and Drop are scenes; Rise is a transition; Fill → Drop is a
  performance action.
- Fill and Drop are one scheduled operation.
- Cancel can never leave one half of it queued.
- Both Fill and Fill → Drop show their queued destination and can be canceled.

## 6. Rise finishing with a fill
- An optional Finish with Fill toggle on Rise. Off by default.
- The fill plays the Rise's last bar; the landing scene applies on the next downbeat.
- Pattern lanes, the fill and the landing scene are coordinated as one transaction in
  the engine. No React-side timing.

## 7. Crash accents
- Optional crash accent saved per scene. Off by default.
- Stored in the versioned project format.
- Never automatic.

## Later, not Night 8: fill variations
Separate from phrase length: what a fill sounds like (Simple, Busy, Syncopated), fixed or
rotating. Phrase length controls *when* fills happen; variations control *what* plays.

## Implementation order
1. Merge and verify the transactional pattern-staging fix.
2. Phrase-aware Fill scheduling.
3. Fill into Drop.
4. Rise + Fill.
5. Per-scene crash accents.
6. Responsive UI, accessibility and regression tests.

Preserve existing behavior, sound-engine boundaries and project compatibility. No
release or deployment without approval. Sound-quality calls stay with Chris's ears.
