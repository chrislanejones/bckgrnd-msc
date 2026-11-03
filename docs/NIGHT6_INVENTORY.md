# Night 6 inventory: NativePHP, assets, MCP, and an early audio probe

Taken on Night 1 (11-03-2026) so that packaging night isn't the first time these
assumptions get tested. Each item says what was checked and how, and what is still
unknown.

## Summary

| Area | State | Blocks Night 6? |
|---|---|---|
| NativePHP packages | `nativephp/electron` 1.3.0 and `nativephp/laravel` 1.3.1, both **abandoned** in favor of `nativephp/desktop`. | Yes: migrate first. |
| NativePHP provider | `config/nativephp.php` names `App\Providers\NativeAppServiceProvider`, which **does not exist**. Nothing opens a window. | Yes |
| App identity | `app_id` is still `dev.floor.stemmachine`. The description is NativePHP's placeholder. | Yes, before the first signed build |
| PHP version | `composer.lock` needs PHP ≥ 8.4.1 (symfony 8.x), but `composer.json` says `^8.3`. `nativephp/php-bin` ships 8.3, 8.4 and 8.5. | Yes: pick 8.4 and say so in `composer.json` |
| Engine build | `wasm-pack` downloads `wasm-opt` (binaryen) at build time. Without it the wasm is 238 KB instead of ~201 KB. | No, but the release build must be optimized |
| Asset paths | Absolute from the origin root: `/build/…`, `/wasm/…`, `/library/…`. NativePHP serves the app at the root of a `127.0.0.1` origin, so they resolve. | No |
| Runtime directories | `storage/framework/views` is gitignored. A fresh checkout returned 500 on `/` until it existed. Now created by `start.sh`. NativePHP sets its own storage path, so check it once packaged. | Check |
| Presets disk | `config/bckgrnd.php` says the bundle points `BCKGRND_PRESET_DISK` at app data. No code does that yet (it would live in the missing provider). | Yes, for Night 5's projects |
| Audio in an Electron shell | **Probe passes** in Electron 32.3.3 (Chrome 128) on a `127.0.0.1` origin, with no user gesture. See below. | No |
| MCP engine | In sync: vendored from `bd79af5`, and nothing in `engine-core/`, `app/Support/Music/` or `public/library/` has changed since. | No |
| MCP presets | A different shape (render settings for mixing under a voice). The mapping to project v1 is in `contracts/README.md`. | Night 6 work |

## NativePHP

**Installed** (from `composer.lock`): `nativephp/electron` 1.3.0, `nativephp/laravel`
1.3.1, `nativephp/php-bin` 1.2.0. Composer marks the first two abandoned with
`nativephp/desktop` as the replacement. The NativePHP Electron app they bring
(`vendor/nativephp/electron/resources/js/package.json`) pins `electron ^32.2.7`.

**`config/nativephp.php`:**

- `provider` → `App\Providers\NativeAppServiceProvider`: missing. NativePHP calls this
  to open the window (`Window::open()`), so `php artisan native:serve` has nothing to
  show. It is also where `BCKGRND_PRESET_DISK` should be pointed at app data.
- `app_id` → `dev.floor.stemmachine`, from when the app was called FLOOR.
- `description` and `website` are NativePHP's placeholders.
- `updater.enabled` defaults to true with the `spaces` provider and no credentials.
  Turn it off until there is somewhere to publish.
- `prebuild` runs `pnpm run build:engine` and `pnpm run build`, so the packaging
  machine needs Rust, `wasm-pack`, and network access for `wasm-opt`.
- `cleanup_exclude_files` lists `build`. Confirm on Night 6 that this means a root
  `build/` and not `public/build/`. Excluding the latter would ship an app with no
  frontend.

**Stale note:** PARKING_LOT says `.env` and `.env.static` are still in
`floor-desktop/`. That directory no longer exists. The static build no longer needs
`.env.static` either, because `build:app:static` sets `VITE_STATIC=1` itself, and
`verify:static` passes without it.

## Assets the shell must serve

| Path | Built by | Notes |
|---|---|---|
| `/build/assets/app.js`, `app.css` | `pnpm run build` | Fixed names. The Blade shell cache-busts with the file's mtime (ADR-010). |
| `/build/engine-worklet.js` | `pnpm run build:worklet` | Loaded by `audioWorklet.addModule`, with `?v=` from `__BUILD_ID__`. |
| `/wasm/bckgrnd_msc_engine_bg.wasm` | `pnpm run build:engine` | Fetched on the main thread and handed to the worklet as bytes. |
| `/library/*.json` | `tools/export-library.php` | The static fallback. The API is preferred when Laravel runs. |
| `/probe.html`, `/probe.js` | committed | The audio probe below. Ships with the app on purpose. |
| `contracts/parameters.json` | committed | Read by PHP at runtime (`App\Support\Project\Contract`), and bundled into the JS at build time. |

## Early audio probe

`public/probe.html` boots the real worklet and wasm, plays Warehouse for 1.5 s, and
reports what the shell gave it and what came out. Open `/probe.html` and press Run,
or add `?auto=1` where audio may start without a gesture. The verdict is in the page
title (`probe: pass` / `probe: fail`) and in `window.__PROBE_RESULT__`.

| Shell | Origin | Result |
|---|---|---|
| Chromium (Playwright build 1243), headless | `http://127.0.0.1:8080` (Laravel) | pass: peak 0.78, stereo, telemetry ~27 Hz |
| Chromium, headless | `http://127.0.0.1:8090` (static) | pass |
| **Electron 32.3.3 / Chrome 128**, Linux under Xvfb, no sandbox | `http://127.0.0.1:8080` | **pass** with no user gesture: secure context, worklet, sound, stereo, 40 telemetry frames in 1.5 s, master meter agrees with the output |
| The app itself in Electron 32.3.3 | `http://127.0.0.1:8080/` | Renders: three-column layout, 8 stems, 18 tracks, no console errors |

What the probe can't tell yet:

- **The real NativePHP shell.** The Electron run was a bare `BrowserWindow` on the same
  kind of origin NativePHP uses, not `php artisan native:serve`, which can't open a
  window until the provider exists.
- **A packaged build** (`native:build`). Run the probe inside one on Night 6.
- **A speaker.** The analyser taps the signal before the output device. Xvfb has no
  audio device ("audio outputs listed: 0"). Someone has to listen to the probe on a
  real machine. It plays at a quarter of full level unless `?mute` is set.
- **macOS and Windows**, and **phones**. The mobile questions stay separate (see the
  PARKING_LOT section on the NativePHP mobile app).

## MCP companion (`bckgrnd-msc-mcp`)

- **How it syncs:** `scripts/sync-engine.mjs` copies `public/wasm/*` and
  `public/library/*.json` from a built checkout into `vendor/`, and stamps
  `vendor/SOURCE.json` with the commit and a dirty flag. It never builds Rust.
- **Pinned at:** `bd79af5` (the 10-21 package update). `git log bd79af5..HEAD --
  engine-core app/Support/Music public/library` is empty, so the MCP plays the same
  engine and tracks as `main` today.
- **The engine API it calls:** `initSync`, `new Engine(sampleRate)`,
  `load_track_wasm`, `set_muted_index`, `set_volume_index`, `play`, `process`, `free`.
  Night 1 changed none of these. The telemetry frame grew from 12 to 15 values, but
  that frame belongs to the worklet, which the MCP doesn't use.
- **Its presets:** `MixSettings` (track, music level, loudness, ducking, cut stems,
  fades, mastering), saved in `~/.config/bckgrnd-msc/presets`. Only `track` and `cut`
  are musical data. Night 6: have `sync-engine.mjs` copy `contracts/` too, read and
  write the musical part as a project v1, and test the round trip in both repos.
- **Its wasm** is the optimized build (200,907 bytes). Keep releasing from an
  optimized engine build.

## Night 6 order of work (proposed)

1. Move to `nativephp/desktop`. Add `NativeAppServiceProvider` (window, preset disk).
   Fix `app_id` and the description. Turn off the updater.
2. Settle PHP 8.4 for the bundle and in `composer.json`.
3. `native:serve`, then the probe and the UI checks inside it.
4. `native:build` for one desktop platform, then the probe inside the package, and
   someone listens.
5. Resync the MCP and adopt the project contract there.
6. Mobile compatibility check, reported separately.
