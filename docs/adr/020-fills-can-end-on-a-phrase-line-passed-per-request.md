# ADR-020: Fills can end on a phrase line of 2, 4, 8 or 16 bars, passed with each request
Date: 2026-11-19   Status: draft

## Context
A fill starts on the next bar line (`FILL_GRID = 16`), so it lands wherever you
pressed, not where the music turns. Auto mix already works in 4-bar phrases, and the
song is four 4-bar parts (256 steps), but the engine has no idea of a phrase. Chris
asked for a choice of lengths (NIGHT8_DECISIONS §1–2, 11-19-2026).

## Decision
A fill request can say "end on the phrase line", with a phrase of 2, 4, 8 or 16 bars
(default 4) aligned to step 0. Any other length is refused. The length rides on each
request, so the engine keeps no phrase setting and every host (UI, MCP) states it.
A loop's wrap also counts as a phrase end. A press too late for this phrase is never
refused: it rolls to the next phrase end, and the UI shows where it will land ("Fill ·
Next phrase"). Next bar stays the default timing. Phrase length is an app preference,
like Rise's bars, not project data: it describes how you perform, not what the song
is, and keeping it out of the project avoids a format version for a setting.

## Consequences
+ Fills land where the music turns, at every tempo, and the deadline is counted in
  onsets as ADR-015 requires.
+ No project format change, and the MCP or any other host gets phrase fills by
  passing one number.
- This bends ADR-001 again, as ADR-008 did: the engine now computes where a phrase
  ends. All four lengths divide 256 steps, so this assumes the 16-bar form.
- A late press at 16 bars can wait up to 16 bars, about 55 s at 70 bpm, and a
  queued fill that long can read as a broken button.
- Two people sharing one project don't share a phrase setting. That's fine for a
  performance setting, but it has to move into the project if it ever becomes part of
  the song.

## Alternatives rejected
- A phrase setting stored in the engine: a hidden state every host would have to
  set and keep in step. Passing it per request keeps the engine stateless about it.
- Saving phrase length in the project: a format bump for a performance choice.
  Revisit if people want different setups per project (Chris, §1).

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: a track arrived
whose form isn't 4-bar parts on a 256-step song (a 12-bar section, a longer song, an
odd pickup), and phrase lines aligned to step 0 now fall in the middle of its musical
phrases. The engine computes them confidently and wrongly, which is exactly the
ADR-001 and ADR-008 pre-mortem. The fix would be PHP sending the phrase lines with the
arrangement.
Early warning sign to watch for: a track whose arrangement isn't 256 steps, or whose
section seams in `Arranger.php` aren't multiples of 64.
