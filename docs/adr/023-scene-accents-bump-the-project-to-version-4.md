# ADR-023: The scene accent bumps the project format to version 4
Date: 2026-11-19   Status: draft

## Context
ADR-022 saves a crash accent per scene. In v3, scene objects are
`additionalProperties: false`, a malformed scene refuses the whole document, and the
snapshot reader refuses any unknown field (canonical round-trip). Some readers in the
field won't know the new field: the MCP companion (vendored contracts, pinned at
`projectVersion: 3`), older desktop builds, and a stale browser tab reading the same
IndexedDB. ADR-014 kept `scenes` out of v1 for the same reason.

## Decision
Bump the project to `version: 4`. In v4 every scene states its crash accent explicitly
as a required boolean `crash`, because ADR-014 keeps scenes complete on disk with nothing
filled from defaults. The v3 → v4 migration writes `crash: false` on every scene, so nothing plays
differently. Readers refuse v5 and above, as ADR-012 says. Every stored v3 snapshot
(IndexedDB, native storage, MCP project files) has to keep opening. Today the snapshot
reader requires `project.version` to equal the current version, so it needs a
migrate-on-read path or a new snapshot version. That choice belongs to the
implementation.

## Consequences
+ An old reader that meets a v4 file says "newer than this app understands" instead
  of "malformed scene" or "unsupported fields". That's the contract ADR-012 set.
+ One version still means one shape: every v4 reader agrees on every v4 file.
- Both migrations (PHP and TS) and the fixtures move again, and the strictest reader,
  the snapshot reader, gains a migration path.
- **Cross-repo:** the MCP companion refuses *every* project the new app saves, crash
  or not, until it vendors the v4 contracts and a new npm version ships (Chris's
  step). The two have to release together.
- The field is named `crash`, not `accent`: `accent` already means a boolean on pattern note events.

## Alternatives rejected
- An optional `accent` within v3, where absent means none: cheaper, with no migration,
  and an old MCP still opens every project that doesn't use a crash. It lost because
  an old v3 reader meeting a crash scene refuses the document as malformed, so v3
  would mean two shapes. It would also fill a default into a scene, which ADR-014
  rules out.
- Keeping the accent outside the project (a per-slot app preference): it wouldn't
  travel with the file, and Chris asked for it in the versioned format.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the bump cost more
than the field. The MCP release lagged the app, and MCP users couldn't open anything
saved after the update, all over a toggle most people never set. Or every small scene
option since then has been another version and another link in the migration chain.
Early warning sign to watch for: the app shipping v4 while `vendor/SOURCE.json` in
bckgrnd-msc-mcp still says `"projectVersion": 3`, or a second per-scene option
requested before v4 ships. In that case, design a scene options object into v4 now.
