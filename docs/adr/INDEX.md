# Architecture Decision Records

Why the load-bearing, hard-to-reverse decisions in bckgrnd-msc were made the
way they were. One decision per file, one screen each. Copy
[000-template.md](000-template.md) to start a new one.

New ADRs land as **draft** and are flipped to **accepted** by Chris. Numbers
are sequential and permanent: a superseded ADR keeps its number and gains a
`superseded by NNN` status. It is never renumbered or deleted.

ADRs 001-011 were backfilled on 10-05-2026 from the code, the commit bodies,
HANDOFF.md and PARKING_LOT.md. Each one keeps the date the decision was made
and is marked `(backfilled)`.

| # | Decision | Status | Date |
|---|---|---|---|
| [001](001-php-owns-the-music-rust-owns-the-dsp-react-only-renders.md) | PHP owns the music, Rust/WASM owns all DSP in an AudioWorklet, React only draws and sends intent | accepted | 2026-10-02 (backfilled) |
| [002](002-laravel-runs-stateless.md) | Laravel runs stateless: no sessions, no CSRF, no database; presets are JSON on disk, so `APP_KEY` protects nothing | accepted | 2026-10-02 (backfilled) |
| [003](003-two-decks-are-two-engines-in-one-worklet.md) | The two decks are two engines in one worklet, each rendering into its own buffers | accepted | 2026-10-03 (backfilled) |
| [004](004-ladder-filter-for-acid-bass-and-lead-only.md) | A ZDF four-pole ladder filter, for the acid bass and lead only | accepted | 2026-10-05 (backfilled) |
| [005](005-library-sections-are-display-data-not-voicing.md) | Section and style live in `Library::GROUPS` as display data, separate from the engine's `kind` | accepted | 2026-10-05 (backfilled) |
| [006](006-static-build-for-netlify-built-locally.md) | The public site is a static `dist/` built locally and uploaded to Netlify; no presets there | accepted | 2026-10-05 (backfilled) |
| [007](007-scratch-replays-the-capture-ring.md) | A scratch replays the engine's recent output from a frozen 4 s capture ring, with the transport held | accepted | 2026-10-05 (backfilled) |
| [008](008-transition-sounds-sit-outside-the-stems.md) | Riser, crash and downsweep sum into the master outside the stems and fire only on a natural crossing | accepted | 2026-10-05 (backfilled) |
| [009](009-percussion-rides-the-hats-stem.md) | Shaker, rim and congas are voices on the hats stem; the app stays at eight stems | accepted | 2026-10-05 (backfilled) |
| [010](010-fixed-asset-names-with-query-cache-busting.md) | Assets keep fixed names and are cache-busted with `?v=` (file date, build stamp, `__BUILD_ID__`) | accepted | 2026-10-05 (backfilled) |
| [011](011-no-vinyl-crackle-or-tape-hiss-under-lofi.md) | No synthesized vinyl crackle or tape hiss under lo-fi: built, read as rain, removed | accepted | 2026-10-05 (backfilled) |
| [012](012-one-parameter-registry-and-a-versioned-project-format.md) | One parameter registry and a versioned project format, shared by UI, PHP and MCP; telemetry is never saved | draft | 2026-11-03 |
| [013](013-parameter-smoothing-lives-in-the-engine.md) | Parameter smoothing lives in the engine, per parameter, with control-rate filter/EQ and a snap on silence | draft | 2026-11-03 |
| [014](014-scenes-are-complete-snapshots-in-project-version-2.md) | Scenes are four complete snapshots in project version 2; the active scene is never saved | draft | 2026-11-04 |
| [015](015-the-engine-schedules-musical-changes-gestures-are-overrides.md) | The engine commits scenes at an onset from musical intent; held effects are tokened overrides on the base | draft | 2026-11-04 |
| [016](016-pattern-edits-are-whole-lane-revisions-applied-at-a-boundary.md) | Pattern edits are whole-lane revisions (project v3), swapped in by the engine at a bar boundary; undo is one entry per gesture | draft | 2026-11-04 |
| [017](017-php-writes-variations-static-build-uses-a-hash-matched-catalog.md) | PHP writes variations; the static build serves a catalog matched by source hash and never substitutes | draft | 2026-11-04 |
| [018](018-library-updates-warn-and-save-as-links-the-file.md) | A library update warns instead of locking a project out (no-callback readers still refuse); desktop Save As ties a project to its file | accepted | 2026-11-07 |
| [019](019-timed-builds-are-engine-requests-over-2-4-or-8-bars.md) | A timed build is one engine request that moves the base over 2, 4 or 8 bars from the next bar line, lands exactly with its linked lanes, and restores the starting base on cancel; the UI calls it Rise | draft | 2026-11-17 |
| [020](020-fills-can-end-on-a-phrase-line-passed-per-request.md) | A fill can end on a phrase line of 2, 4, 8 or 16 bars from step 0, passed with each request; the loop wrap counts and a late press rolls to the next phrase; phrase length is an app preference, not project data | draft | 2026-11-19 |
| [021](021-a-fill-and-its-landing-are-one-atomic-linked-request.md) | A fill and the scene or Rise it leads into are one atomic request with a shared deadline: both queued or neither, and a cancel never leaves half | draft | 2026-11-19 |
| [022](022-a-scene-may-carry-an-explicit-crash-accent.md) | A scene may carry a crash accent, off by default and never automatic, fired when it commits during playback (amends ADR-008) | draft | 2026-11-19 |
| [023](023-scene-accents-bump-the-project-to-version-4.md) | The scene accent bumps the project to version 4 with a v3 → v4 migration, not an optional v3 field | draft | 2026-11-19 |
| [024](024-fill-styles-ship-beside-the-track-not-inside-it.md) | Four fill styles ship as `fillStyles` beside the track, not in `track.fills` (a project's hashed source); the host picks one by style key, and Fill Style is an app preference | draft | 2026-11-24 |
| [025](025-beat-repeat-is-gesture-kind-3-looping-the-pre-master-feed.md) | Beat Repeat is held-gesture kind 3: it loops the five-channel pre-master feed from the next grid line, releases at once, and its division is an app preference, not project data | draft | 2026-11-25 |
| [026](026-a-performance-take-is-its-own-v1-contract-of-applied-events-at-song-steps.md) | A performance take is its own versioned contract (`bckgrnd-msc/performance` v1), held in memory and outside the project format: only applied scenes, fills and Rises, at engine song steps; elapsed position and replay are deferred. **Amended 2026-11-26 (v2, draft):** every event has an engine `onset` from the take's first event, Beat Repeat is one `repeat` event, fills record the length that played, a take exports as its own file, and v2 readers refuse v1 | draft | 2026-11-25 |
| [027](027-one-beat-fills-are-dedicated-recipes-beside-the-track-played-as-fill-length-1.md) | One-beat fills are four dedicated PHP recipes shipped as `beatFillStyles` beside the track, played as engine fill length 1 (steps 12-15) at index 4-7; Bar stays the default and a library without them plays the bar; Fill length is an app preference | draft | 2026-11-26 |

Night 8's new event numbers (51 and up) and reason 11 (`linked`) are protocol, not
decisions. They belong in a Night 8 protocol doc, alongside `docs/NIGHT7_PROTOCOL.md`,
not in an ADR.

Night 9 amended three drafts instead of adding ADRs for bug fixes: ADR-015 (the host
keeps one record per request id), ADR-019 (a Rise keeps its own record and is followed
in exact values) and ADR-016 (tone notes no longer allocate on the audio path).

Night 11's events drawer (`frontend/ui/EventsDrawer.tsx`) is the first fixed sheet over
the page, but it doesn't get an ADR. It's UI only: it reads the take and changes no data
shape, storage or boundary. Its one stored value is an open/closed app preference
(`bckgrnd-msc:events-open`). If a second overlay copies it, that's the time to write one.
