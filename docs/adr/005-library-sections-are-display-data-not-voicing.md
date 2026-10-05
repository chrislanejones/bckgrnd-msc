# ADR-005: Library sections and styles are display data in one list, separate from `kind`
Date: 2026-10-05 (backfilled)   Status: draft

## Context
The Breaks section (63027ed) brought the library to 18 tracks and needed titles
like Garage and Liquid DnB. The engine's `kind` (house, deep, acid, lofi) picks
the voicing, and it does not line up with genre: Southside is a garage track on
`deep`, Pirate is garage on `house`, Rave Tape is breakbeat on `acid`.

## Decision
Every track's section and sub-genre are set once in `Library::GROUPS`, an
ordered list of `[id, section, style]` that also fixes display order. Building
the library throws if a track is missing from it or a listed id is undefined.
The UI renders one grid per section and titles each style above its first
track. `kind` stays the voicing selector and is never used for display.

## Consequences
+ New genres need no engine change: six tracks shipped on existing voicings.
+ Order and grouping live in one place, and a forgotten track fails loudly.
- Two classifications per track that can disagree by design; anyone reading
  "Lofi" in the UI has to know it is not `TrackKind::Lofi` in the engine
  (they coincide today, but nothing enforces it).
- Adding a track is two edits in `Library.php` (the definition and its
  `GROUPS` row).

## Alternatives rejected
- Derive the section from `kind`: garage and breaks tracks sit on house,
  deep and acid voicings, so the UI would file them under EDM.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: a feature
keyed behavior off the section name (lofi-only texture, per-genre mixing)
instead of `kind`, so the two drifted into meaning the same thing in some
places and not others.
Early warning sign to watch for: engine or worklet code reading `section` or
`style`, or PHP branching on them outside `Library`.
