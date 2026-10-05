# ADR-009: Percussion is extra voices on the hats stem; the app stays at eight stems
Date: 2026-10-05 (backfilled)   Status: accepted (10-05-2026)

## Context
The garage, breaks and lofi grooves wanted shaker, rimshot and congas. Eight
stems is baked in across the stack: `Stem::ALL: [Stem; 8]`, `Mix([f32; 8])`,
the mixer's `[Channel; 8]`, keys 1 to 8, the telemetry layout (`[0..7]` stem
levels), and the library JSON's `stems` list.

## Decision
Four hand-percussion voices (`PercVoice` in `drums.rs`: shaker, rim, conga hi,
conga lo) spawn on the hats stem, so its fader, cut, solo and meter control
them (ca0e693). `Track` gains an optional `perc` object of 64-step velocity
lanes; `#[serde(default)]` on the field and every lane, so JSON without it
loads. PHP counts percussion as hats activity. No 9th stem.

## Consequences
+ No change to the eight-stem contract, the keyboard map or the layout.
+ Old library JSON still loads; four-on-the-floor tracks carry `perc: {}`.
- Percussion cannot be cut separately from the hats; cutting "the top" takes
  both.
- The hats meter and waveform band now mix two instruments.
- +5,590 bytes of wasm, about +2-3% per sample on dense patterns.

## Alternatives rejected
- A 9th stem: every `[_; 8]` array, the 1-8 keys, telemetry offsets and the
  stem layout would change for one instrument family.
- Percussion as master-bus one-shots like the transitions: then no fader,
  cut or solo reaches it, which is wrong for a groove part.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: users
wanted to strip a groove back to just the shaker, or just the hats, and the
stem they reached for held both.
Early warning sign to watch for: a request for a separate percussion cut, or a
second instrument family proposed for "an existing stem".
