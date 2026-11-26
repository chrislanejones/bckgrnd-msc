# ADR-027: One-beat fills are dedicated recipes beside the track, played as fill length 1
Date: 2026-11-26   Status: draft

## Context
Night 8 dropped "Phrase end · Beat" because "a one-beat fill is a different musical
event" (`NIGHT8_DECISIONS.md` §3), and it left `length` on `queue_fill_at` for later.
Night 10 brings it back. The fill has to stay as tight as a bar fill: the same 16-step
lanes, the same landing downbeat for Fill → Drop and Rise + Fill (ADR-021), and the
same late-press rule (ADR-020). ADR-024's hash reason still holds, because a saved
project hashes `track`.

## Decision
PHP writes four one-beat recipes, one per style (`Fills::beatStyles`). Each is a 16-step
bar that's silent before step 12. They ship as `beatFillStyles` beside `track` and
`fillStyles` (in `/api/tracks/{id}` and `public/library/*.json`), not in `track` and
not in the project format. The engine takes fill length 1 (`FILL_LENGTHS = [0, 1]`):
it plays only steps 12-15, from recipe positions 12-15, and ends on the downbeat a bar
fill would. `queue_fill_at` and `queue_fill_into` already had the argument. Rise +
Fill gets `queue_build_with_length`, and `queue_build_with` is that with 0. The host
loads the engine with the four styles and then the four beat fills, so a beat fill is
index `fillStyles.length + i`, which is 4-7 with all four. The engine doesn't know
which fills are beat fills; it plays whatever index and length it's sent.

Host: Fill length is an app preference, `bckgrnd-msc:fill-length`, with Bar as the
default. If a library has no `beatFillStyles` (exported before Night 10), a press plays
the bar and names it the bar. Beat stays stored but is aria-disabled, with the reason
shown. `resolveFillAt` picks the style with the same choice and cursor at either length,
so Random and Rotate don't depend on it. A queued fill keeps the length it was sent with,
like its style.

## Consequences
+ The `track` bytes don't change, so no saved project's hash moves, and there's no
  project version.
+ Length 0 is the old arithmetic, and project exports (`project-renderer.ts`) never
  queue a fill, so an export can't contain a beat fill.
+ The wasm got smaller: 253,068 → 245,748 bytes (608494d, which credits inlining).
- Each track now has three fill lists: `track.fills`, `fillStyles` and `beatFillStyles`.
  Only the host's offset arithmetic pairs a beat fill with its length. Index 0-3 at
  length 1 plays the bar slice this ADR rejects, and 4-7 at length 0 drops the drums for
  three beats. The engine accepts both.
- The engine now knows that a bar's last beat is steps 12-15, which assumes 16-step 4/4
  bars. That bends ADR-001 further, as ADR-008 and ADR-020 do.
- ADR-024's "Rust is unchanged" no longer holds for fills.

## Alternatives rejected
- Slicing positions 12-15 of the bar recipe: Chris's §3 rule. `FillsTest` checks that
  each beat fill differs from its own style's bar fill over steps 12-15.
- Putting the beat fills in `track.fills` or the project: same hash and version cost as
  ADR-024.
- A separate beat-fill slot or API in the engine: a second fill path, when the one
  pending/active fill and the existing `length` argument already cover it.

## Open questions
- Is length 0 bit-identical to Night 9? The commit and the protocol say so, but
  PARKING_LOT (11-25-2026) says the bypass hash check has to be rerun.
- The take contract (ADR-026) records a fill's style and step but has no length field.
- The MCP companion (vendored engine has only `queue_fill`) reads neither fill field.
- Whether the four recipes sound right is for Chris to judge by ear. Not claimed here.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the index
convention drifted. A library shipped with fewer than four `fillStyles`, or a fifth
style was added, and beat fills moved off 4-7. Or some host sent length 1 with a bar
index. Either way the wrong recipe played with nothing refusing it. That's ADR-021's
own warning about "a second fill length" coming true.
Early warning sign to watch for: a `fill started` with `b` = 12 whose index is below
`fillStyles.length`, or a library where `beatFillStyles` and `fillStyles` differ in
length or style order.
