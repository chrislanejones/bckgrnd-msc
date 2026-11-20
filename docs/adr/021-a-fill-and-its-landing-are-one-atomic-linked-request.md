# ADR-021: A fill and the scene or Rise it leads into are one atomic linked request
Date: 2026-11-19   Status: draft

## Context
Fill → Drop and "Rise, finish with a fill" each pair two things the engine already
schedules on its own: a fill with a scene, or a fill with a timed build (ADR-019). Sent
as two requests, either half can be refused or canceled while the other stays queued,
and the scene would land a bar early, a bar late or with no fill. Chris: "Cancel can
never leave one half of it queued" (NIGHT8_DECISIONS §5–6).

## Decision
The engine takes the pair as **one** request. It validates every part (scene or build,
fill, staged lanes, transport) before changing anything, then queues both or neither.
A refusal names the part that failed. Both parts share one deadline counted on the
onset serial: the fill plays the last bar before the phrase line (ADR-020) or the
Rise's last bar, and the scene, or the Rise's landing scene, commits with its lanes on
the onset the fill ends. A cancel before the fill starts cancels both. Once the fill is
playing it plays out its bar (Night 3), and only the scene is canceled. A new scene or
Rise that replaces the scene unlinks the fill, which plays on as an ordinary fill. It
uses the existing single pending scene, build and fill slots, tied by id, with no new
slots. Lanes rely on the transactional staging from `2e29170`: they wait in their own
slot and are claimed only when the request is accepted.

## Consequences
+ One press, one outcome. No React-side timing (ADR-015), and the downbeat plays the
  new scene's drums with no gap.
+ Rise + Fill extends ADR-019's builds without a second scheduling path.
- The cancel and replace rules now have link cases: every row of ADR-015's and
  ADR-019's cancel tables needs a linked counterpart and a test.
- The link's lifetime is longer than one bar (up to a phrase, or a whole Rise), so
  an interrupt that misses the link leaves a stray half. That's the failure this
  ADR exists to prevent.
- The staging fix (`2e29170`, on main) becomes load-bearing. Any later change to
  lane staging has to keep its guarantee: a refused request never strips an accepted
  one's lanes.

## Alternatives rejected
- Two requests coordinated by the host: the host can't time an onset (ADR-015), and
  a refusal between the two leaves half queued.
- A fifth Switch on choice: Chris made Fill → Drop its own action beside Fill (§5).

Event numbers 51+ and reason 11 (`linked`) are protocol, not decision: they go in the
Night 8 protocol doc.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the link rules
multiplied. The replace rows (scene replaces, Rise replaces, Rise running when the
fill lands) each need a choice about who unlinks. A later feature (a stutter, a second
fill length, fill variations) added a third party to the link, and one path canceled
the scene but left the fill linked to nothing, or the reverse.
Early warning sign to watch for: a path that ends a scene, build or fill without going
through the unlink step, or a cancel-table row in the protocol with no linked-case
engine test.
