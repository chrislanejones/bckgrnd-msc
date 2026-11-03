# ADR-012: One parameter registry and a versioned project format, shared by UI, PHP and MCP
Date: 2026-11-03   Status: draft

## Context
Three programs describe the same mix: the React UI (its own ranges and defaults),
Laravel presets (`PresetController`, no version) and the MCP companion (its own
`MixSettings`). ADR-001 already noted the JSON between the languages has no shared
types. Nights 4–6 add pattern edits, undo, export and the MCP reconnection, and each
would otherwise add a fourth private copy.

## Decision
`contracts/parameters.json` lists every engine parameter once (id, range, default,
unit, scope, worklet message). `contracts/project.schema.json` defines a saved
project, `format: "bckgrnd-msc/project"`, `version: 1`, holding only musical data.
Telemetry stays a separate type and is never saved. PHP (`Contract::migrate`) and TS
(`migrateProject`) read the same files and are tested against the same fixtures;
readers upgrade older documents and refuse newer or unknown ones.

## Consequences
+ A control's limits, a saved project's limits and the MCP's limits can't drift
  apart without a failing test.
+ Legacy presets and later versions have a defined migration path.
- Two implementations of the migration must be kept in step (the fixtures catch
  differences, but someone still writes both).
- Adding a parameter is now a contract change, not a one-line UI change.

## Alternatives rejected
- Generate TS and PHP types from a schema: more tooling than three small readers need.
- Let each program keep its own format and convert at the edges: that is the drift
  this is meant to stop.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the registry
became a list nobody read. A control was added with its range typed into the
component, the project didn't save it, and the fixtures never saw it.
Early warning sign to watch for: a `min=`/`max=` literal in `frontend/ui/` for a
parameter that isn't in `contracts/parameters.json`.
