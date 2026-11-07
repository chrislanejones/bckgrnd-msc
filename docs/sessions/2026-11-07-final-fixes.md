# Final fixes after Night 6, 11-07-2026

Fixes on `night6/linux-release-candidate` after the release candidate was recorded. The
installed Linux app and the MCP release evidence predate them.

## What changed

| Area | Change |
|---|---|
| Top bar | No sideways scroll or cut track name from 1920 to 390 wide. Checked at 16 widths |
| Inspector | Toggle in the top bar between 900 and 1179 wide |
| Save status | Short word that holds its width: As written, Unsaved, Saved, Save failed |
| Projects | Fixes for lost recovery, a repeat save destroying the rollback copy, a stuck desktop close, keys firing behind the dialog, and deleting the open project |
| Library updates | A project opens with a warning instead of refusing ([ADR-018](../adr/018-library-updates-warn-and-save-as-links-the-file.md)) |
| Desktop Save As | Save keeps the chosen file current, with a `.bak` (same ADR) |

## Gates on the committed build

| Gate | Result |
|---|---|
| Typecheck and build | Pass |
| `verify:ui` | 267 pass |
| `verify:editor` | 73 pass |
| `verify:audio` | 29 pass |
| `verify:projects` | Pass |
| `check:contract`, `check:scenes`, `check:editing` | Pass |
| PHPUnit | 246 tests, 5842 assertions |

## Still open

- The desktop flow was tested against a simulated bridge, plus real file writes in
  PHPUnit. The native dialog hasn't been clicked in the installed app.
- Speaker listening, sleep and resume, output-device changes and real minimization are
  still Chris's. See [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md).
- ADR-018 is a draft until Chris accepts it.
- Smaller leftovers are in `PARKING_LOT.md`.
