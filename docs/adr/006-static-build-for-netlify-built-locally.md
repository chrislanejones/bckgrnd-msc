# ADR-006: The public site is a static build, built locally and uploaded to Netlify
Date: 2026-10-05 (backfilled)   Status: accepted (10-05-2026)

## Context
The app needed a public URL. The library and song form can be exported to JSON
ahead of time, so the web build does not need PHP. Netlify's build image has no
Rust or `wasm-pack`, so it cannot build the engine on push. The existing
`build:app:static` read `VITE_STATIC` from a `.env.static` that did not exist,
so the "static" bundle was the API-first one, calling `/api/tracks` on every
load and surviving on its JSON fallback (61c17e2).

## Decision
`pnpm run build:netlify` builds the engine, the app and the static export, then
assembles `dist/` with only `index.html`, the favicon, `build/`, `wasm/` and
`library/`. `VITE_STATIC=1` is set inline in the `build:app:static` script, not
in an env file. `netlify.toml` publishes `dist/`; the deploy is
`netlify deploy --dir dist --no-build --prod` from a local machine. Live at
https://bckgrnd-msc.netlify.app.

## Consequences
+ No PHP on the host, no server to run; `verify:static` checks the result
  against `dist/` served on its own, including that no API call is made.
+ Laravel's `public/index.php` never reaches a static host as a download.
- Saved presets need Laravel's `/api/presets` and are not available on the
  static site. Nothing in the UI uses them today.
- Deploys are manual and only as fresh as the last local build; there is no
  CI building what is on `main`.

## Alternatives rejected
- Build on Netlify on push: no Rust or `wasm-pack` in the build image.
- Keep `VITE_STATIC` in `.env.static`: it silently failed (Vite looked under
  `frontend/`), and env files are kept out of the repo.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the live
site drifted behind `main` because deploying was a separate manual step, and
a bug report was filed against code that had already been fixed.
Early warning sign to watch for: the deploy date on Netlify falling more than
a few commits behind `feat:`/`fix:` history on `main`.
