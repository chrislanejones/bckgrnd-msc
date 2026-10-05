# ADR-004: A four-pole ladder filter, for the acid bass and lead only
Date: 2026-10-05 (backfilled)   Status: accepted (10-05-2026)

## Context
The acid 303 line ran through the same resonant biquad as every other voice.
A biquad under audio-rate cutoff sweeps and high Q does not squelch like the
hardware and can misbehave at the extremes. Every other stem sounded right on
the biquad and was matched against `old/`.

## Decision
Add `dsp::Ladder`: a zero-delay-feedback (TPT) four-pole ladder with the global
feedback solved implicitly per sample and `tanh` on the resolved input (725c3fb).
A voicing opts in with `ladder: true`; only the acid bass and lead do, and a
wide voicing always gets the biquad (`tone.rs`: `v.ladder && !v.wide`). Q maps
onto ladder feedback, so the voicing values keep their meaning.

## Consequences
+ Stable under max resonance and fast sweeps by construction; levels land
  within 0.1 dB of the biquad versions, so the mix balance did not move.
+ Scoped to one sound: nothing else changes timbre.
- The acid track costs about 9% more per sample (531-547 to 587-597 ns).
- Two filter types per voice now, and a `ladder` flag someone has to know
  about before "fixing" an acid voicing by changing Q.

## Alternatives rejected
- Keep the biquad and raise Q: no squelch, and the hardware's passband loss
  and self-oscillation are not there to tune.
- Ladder on every bass: house and deep basses and their saw layer were
  already matched to the reference; changing them was out of scope.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the ladder
was copied onto other voicings for "warmth" without the level matching that
came with the acid version, and the stem balance drifted track by track.
Early warning sign to watch for: `ladder: true` on any voicing other than the
acid bass and lead, or `only_the_acid_bass_and_lead_use_the_ladder` edited.
