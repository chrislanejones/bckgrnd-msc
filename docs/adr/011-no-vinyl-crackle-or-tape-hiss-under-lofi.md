# ADR-011: Lo-fi tracks carry no synthesized vinyl crackle or tape hiss
Date: 2026-10-05 (backfilled)   Status: accepted (10-05-2026)

## Context
The approved sound pass included a lo-fi texture: vinyl crackle and tape hiss
on the master for `TrackKind::Lofi`, outside the stems. It was built and
shipped (248b7b0, `texture.rs`): hiss about -43 dBFS RMS, crackle density
wandering 2 to 14 clicks a second. On every lo-fi track it read as rain.

## Decision
Remove it (42d6910). Thinning the crackle to 0.4-3 clicks a second and dropping
the hiss 5 dB did not fix it, so `texture.rs` and its wiring are gone, not
tuned further. `verify-audio` now asserts a lo-fi track with every stem cut is
silent, the same as the club tracks. Do not re-add a texture of this shape.

## Consequences
+ Cutting every stem is true silence on every track again, and the
  browser gate checks it.
+ wasm 202,867 to 200,213 bytes with echo time added in the same commit;
  lofi drops its +5-9% per-sample cost.
- Lo-fi tracks lose the medium cue the genre is named for; the lo-fi
  character now rests on swing, voicing and the darker hats alone.
- The subnormal-float finding from the crackle filters (150-250 ns per sample
  ringing down to silence) may apply to other filters and is still parked.

## Alternatives rejected
- Keep tuning density and level: the thinned version still read as rain.
- Tape wow on the music: the music is synthesized, so wow means modulating
  every voice's pitch; it was left out from the start rather than faked.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the
problem was the noise character (white-noise hiss, random bandpassed ticks),
not texture as an idea, and a sampled or band-shaped texture would have
worked. Removing it closed a door that only one bad implementation had tried.
Early warning sign to watch for: lo-fi tracks described as "too clean" next to
`old/` or other lofi.
