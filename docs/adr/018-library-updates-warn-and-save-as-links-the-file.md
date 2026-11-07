# ADR-018: A library update warns instead of locking a project out; desktop Save As ties a project to its file
Date: 2026-11-07   Status: draft

## Context
`readSnapshot` threw on any source hash difference, so every saved project refused to
open after any library data update. Separately, desktop Save As wrote the chosen file
once; later Saves updated only internal storage while saying "Saved", leaving that
file stale.

## Decision
**Library updates.** `readSnapshot` takes an optional `onSourceChanged`. The app passes
it: the project opens stopped with a warning (opening the Projects dialog if shut,
since the desktop File menu opens projects with it shut) and shows Unsaved at a bumped
revision. Saving records the current hash and clears the warning; the prior copy stays
in `previous`. Callers with no callback (the MCP's validate and render) still refuse: a
render must reproduce the saved sound, and nobody is there to see a warning. A
`source.trackId` that differs from `project.trackId` is refused for everyone, since
that's a malformed file, not an update.

**Linked files.** `ProjectFiles` persists id → path in `.file-links.json` under the
projects root (dotted so the `*.json` glob in `records()` skips it; IDs can't contain a
dot). Native action `update-file` rewrites the linked file, keeping a `.bak`, after the
store write. The path stays server-side, so the web view can't ask for a write to an
arbitrary path. A missing file fails with "use Save As" and is never recreated. A failed
file write leaves the app copy saved, says so in the notice, retries on the next Save
without a new store revision, and asks before quitting. Deleting a project forgets the
link and leaves the file alone.

## Consequences
+ A library update can't lock anyone out of their own work.
+ After Save As, "Saved" covers the chosen file too, or the notice says it didn't.
- A project may sound different from when it was saved. Accepted in exchange for never
  being locked out.
- The link follows the project ID, not the file opened. Opening a linked file, or a copy
  of one, through Import creates no link, but the ID's existing link still applies, so
  Save rewrites the linked file (with a `.bak`) and never the copy.
- The retry flag lives in memory. After a restart or opening another project, a stale
  file catches up only at the next real change.
- Proof is partial: PHP tests exercise real file writes, the app flow ran against a
  simulated desktop bridge, and the native file dialog hasn't been clicked in the
  installed app.

## Alternatives rejected
- Import/Open also links the file: Import promises the original is left unchanged.
  Noted in PARKING_LOT.md because the desktop File menu labels that action "Open".

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the warning stopped
meaning anything. Nothing yet proves the web and desktop builds hash a track the same
way, so a project moved between them warns with no library change. People learn to Save
through it, and that Save replaces the hash that was the only evidence the sound had
drifted, after which an MCP render accepts the project as faithful.
Early warning sign to watch for: a source warning on a project whose track data has no
commit since the project's `savedAt`.
