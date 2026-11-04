# ADR-017: PHP writes variations; the static build serves a catalog matched by source hash
Date: 2026-11-04   Status: draft

## Context
Variation is musical authorship, which ADR-001 gives to PHP. The static build
(ADR-006) has no PHP, yet should offer variations of the tracks it ships. A static
answer made for different notes than the user has would silently replace their phrase.

## Decision
`App\Support\Project\Variation` (generator `php-variation-1`) is the only generator,
behind `POST /api/variations`: seeded mulberry32, range-bound, lock- and
anchor-respecting, rhythm-only for melodic lanes (no harmony metadata exists). The
static build exports, per track, every editable lane × part × strength × seeds 1–3,
keyed by `sourceHash` of the source range; the browser uses an entry only when the
phrase on screen hashes the same, and otherwise reports "unavailable" with the reason.

## Consequences
+ One generator, deterministic everywhere; a kept variation records generator, seed, strength, range, source revision and hash.
+ The static build never substitutes: an edited phrase is honestly unavailable.
- About 3 MB of generated JSON per static build (fetched per track, only on Vary).
- The static build offers three seeds per part and no variation of edited phrases or around event locks.

## Alternatives rejected
- A TypeScript port of the generator: two implementations to keep identical, and music moving into the UI.
- Shipping PHP-in-WASM for the static build: heavy, and still a second runtime to test.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: the generator
changed often (harmony-aware melodic variation arrived) and catalog regeneration or
hash canonicalization drifted between PHP and TS, so static entries stopped
matching and everything read "unavailable".
Early warning sign to watch for: `verify:static` "the catalog varies the track as
written" failing, or `check:contract` hash parity failing after a generator change.
