# ADR-010: Assets keep fixed names and are cache-busted with a `?v=` query
Date: 2026-10-05 (backfilled)   Status: draft

## Context
`vite.config.ts` emits fixed names (`assets/app.js`, `app.css`,
`engine-worklet.js`, the wasm) because the Blade shell and the NativePHP
package reference them directly. `artisan serve` and `php -S` send no cache
headers, so after a rebuild browsers kept the old `app.js`: new features were
on the server but not on screen until a hard refresh (9e9cde2).

## Decision
Keep the fixed names and add a cache key to every URL. The Blade shell appends
`?v=<filemtime of app.js>`; `build:static` stamps the static shell with a
per-build id; `engine.ts` loads the worklet and wasm with `?v=__BUILD_ID__`,
defined per `vite build` in `vite.config.ts`. Netlify serves everything with
`max-age=0, must-revalidate`.

## Consequences
+ A rebuild reaches the browser on a normal reload, on every host.
+ The Blade template and NativePHP stay independent of content hashes.
- Nothing is cached long-term: every load revalidates every asset (cheap
  with ETags, not free).
- Three separate stamping mechanisms (file date, static stamp, build id) that
  must all be kept in step; a new asset loaded by URL needs its own.

## Alternatives rejected
- Content-hashed file names: the Blade shell and the NativePHP package
  would need a manifest lookup for every asset.
- Long `Cache-Control` on fixed names: a stale app after every deploy.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: a new
asset (a second worklet, a font, a sample file) was added by URL without a
`?v=`, and the stale-asset bug came back in one place only.
Early warning sign to watch for: a fetch or `addModule` of a `/build/` or
`/wasm/` URL without `__BUILD_ID__` in it.
