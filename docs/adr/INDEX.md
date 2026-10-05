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
