# ADR-002: Laravel runs stateless: no sessions, no CSRF, no database
Date: 2026-10-02 (backfilled)   Status: accepted (10-05-2026)

## Context
There are no accounts and no login. The only thing the app saves is a preset
(a track plus fader, mute and solo state), and in the NativePHP desktop build
that belongs on the user's own disk. Laravel's default web stack would still
start a session store and check CSRF tokens for a session that never exists.

## Decision
`bootstrap/app.php` removes cookie encryption, sessions, shared session errors,
CSRF validation and session auth from the `web` middleware group. Presets are
JSON files written through `Storage::disk(config('bckgrnd.preset_disk'))`
(`BCKGRND_PRESET_DISK`, default `local`). No database is configured or used.
With nothing encrypted and no session, `APP_KEY` protects nothing.

## Consequences
+ No database to provision, migrate or back up; the same kernel works under
  `artisan serve`, NativePHP, and is skippable entirely for the static build.
+ A leaked `APP_KEY` (one was committed early on, since scrubbed) had no
  blast radius.
- Any future feature that needs a session, a signed cookie or a login
  re-adds this middleware and makes `APP_KEY` live again. That is a real
  security change, not a config tweak.
- Presets on local disk do not sync between machines, and the static build
  has no presets at all (ADR-006).

## Alternatives rejected
- Default Laravel web stack with a session store: a database dependency for
  nothing, per the comment in `bootstrap/app.php`.

## Pre-mortem
It is six months later and this was a mistake. Most likely reason: someone
added a feature that writes user data (sharing a mix, a hosted preset list)
and bolted sessions back on without revisiting this, so an old assumption
("the key protects nothing") stayed in docs while it stopped being true.
Early warning sign to watch for: `StartSession`, `Crypt::`, `encrypt(` or a
`DB_` setting appearing anywhere under `app/`, `config/` or `bootstrap/`.
