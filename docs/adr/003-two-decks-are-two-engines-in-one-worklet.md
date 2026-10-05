# ADR-003: The two decks are two engines in one AudioWorklet, each with its own buffers
Date: 2026-10-03 (backfilled)   Status: accepted (10-05-2026)

## Context
Auto mix crossfades one track into the next, so two tracks render at once. The
first version rendered both decks into one buffer pair, and `Engine::process`
assigns rather than adds, so the idle deck's render overwrote the live one and
a mix played as a drop to silence (93909c7).

## Decision
`frontend/worklets/engine-processor.ts` owns two `Engine` instances, deck A and
deck B, renders both every block into separate buffer pairs, and sums them
after each engine's own output gain. One deck is live; the idle deck is
preloaded with Next and silent until a mix brings it in on the outgoing deck's
downbeat. The UI
tracks which deck is live (`liveDeck`) instead of assuming deck A.

## Consequences
+ Handovers have no gap: the incoming track is already loaded and starts on
  a shared downbeat, aligned to within one render quantum (under 3 ms).
+ One worklet, one message channel, one place that sees both clocks.
- Both engines run every block, so the audio thread pays for two decks even
  when only one is audible.
- Every message must name a deck, and anything aimed at "the" deck has to
  resolve the live one; that was the bug behind stale labels and a scratch
  release jumping the new track (0b8fedd).

## Alternatives rejected
- One buffer pair for both decks: what shipped first; it discarded the
  outgoing track for the whole crossfade.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: CPU. As the
engine grew (ladder, metal hats, transitions, percussion) the double render
pushed a slow phone over its block budget and it glitched only during mixes,
which is exactly when nobody is looking at a profiler.
Early warning sign to watch for: the single-engine bench (about 760 ns per
output sample today) passing 10,000 ns, which is half of the 20.8 us a sample
gets at 48 kHz once two decks double it.
