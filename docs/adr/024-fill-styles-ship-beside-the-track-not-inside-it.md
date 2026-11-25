# ADR-024: Fill styles ship beside the track, not inside it
Date: 2026-11-24   Status: draft

## Context
Night 9 gives every track four fills: Classic (the existing fill), Simple, Busy and
Syncopated. Their obvious home is `track.fills`, but a saved project names its source
track by a SHA-256 of the track JSON (`frontend/lib/snapshot.ts`). Four fills there would
mark every saved project "track changed" (ADR-018) at once, break the release fixtures in
`check:contract`, and the MCP companion refuses any project whose source hash doesn't
match.

## Decision
PHP generates the four (`Fills::styles()` in `app/Support/Music/Fills.php`, fixed order,
each tagged with a `style` key) and exports them as a new `fillStyles` field beside
`track` in `/api/tracks/{id}` and `public/library/*.json`. `track.fills` stays exactly
main's single fill. The host loads the engine with `fills` = the four styles
(`withFillStyles`) and picks the index by `style` key (`fillIndex`), falling back to 0,
Classic. When it falls back (a library without `fillStyles`, or without that style) the
fill is named Classic too: the host names the style that plays, not the one preferred.
Rust is unchanged and owns the scheduling. Fill Style is an app preference (localStorage
`bckgrnd-msc:fill-style`, default `classic`), not project format, like phrase length
(ADR-020). It is per viewer: the same project performed on another machine uses that
machine's choice. A queued fill keeps the style it was sent with.

Random and Rotate (Night 9 follow-up) are two more values of the same preference, and
are resolved by the host, not the engine or PHP: when Fill, Fill → Drop or Rise + Fill
is queued, `resolveFill` (`frontend/lib/fills.ts`) picks one concrete style among those
the track has and sends its index, so the engine still only ever plays an index. Rotate
goes Classic, Simple, Busy, Syncopated; Random is a seeded mulberry32 draw that never
repeats the last style played. Their place is kept in memory for the session (never
stored, never in a project) and moves on only when a fill starts playing, so the style
shown before a press is the one that plays. Classic stays the default.

## Consequences
+ No saved project, fixture or MCP project changes hash, and nothing reads as "track
  changed".
+ No engine change, no wasm change, no project version.
- Two fill lists per track: `track.fills` (hashed, what a project names) and
  `fillStyles` (what the engine plays). Only a test (`FillsTest`, Classic byte for byte
  against `tests/fixtures/fills/classic.json`) keeps index 0 of each the same.
- A host that loads only `track` gets Classic alone. The MCP companion doesn't read
  `fillStyles` today.
- A project doesn't record its style: what plays depends on each viewer's preference.
- Random and Rotate live only in the host: an MCP render or another client can't
  reproduce a performance's sequence of fills (no render plays fills today).

## Alternatives rejected
- The four inside `track.fills`: every saved project's source hash changes at once.
- A project-format field: performance preferences are app preferences (Chris's rule),
  and it would cost another version bump (ADR-023).
- Generating the styles in Rust or TS: PHP owns musical generation (ADR-001).

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the two lists
drifted. A later change to fills went into `fillStyles` only, or `track.fills` only, and
the Classic the engine plays stopped being the fill a project's hash vouches for. Or
people wanted a style per scene or per project, and it had to move into the format
anyway, with the hash problem this ADR dodged now waiting on the second field.
Early warning sign to watch for: `fillStyles[0]` and `track.fills[0]` differing in any
library file beyond the `style` key, or a request for "this project uses the Busy fill".
