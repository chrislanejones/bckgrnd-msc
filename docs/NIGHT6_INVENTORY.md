# NativePHP release inventory — 2026-11-06

Linux x64 is the first target. Windows and macOS are **not tested**. The original
[Night 1 inventory](archive/NIGHT6_INVENTORY_NIGHT1.md) is historical evidence,
including its bare Electron/Xvfb probe; it is not installed-app certification.
Current results and remaining gates are in [NIGHT6_PROTOCOL.md](NIGHT6_PROTOCOL.md).

| Area | Current candidate |
|---|---|
| Framework | NativePHP Desktop 2.4.0; old Electron/Laravel packages removed |
| PHP | Manifest `^8.4.1`; system 8.4.26; actual packaged executable 8.4.27; no platform-check bypass |
| JS tools | Node ≥22 for app/desktop development; tested 24.21.0; pnpm 10.26.0, including generated Electron runtime |
| Runtime | Electron 40.10.6, sandboxed renderer, context isolation, web security, Node integration off |
| Bootstrap | `NativeAppServiceProvider`: window, menus, persistent directories, preserved legacy imports |
| Identity | `com.chrislanejones.bckgrndmsc`; product bckgrnd-msc; original favicon used for the app icon |
| Update policy | Automatic updater disabled; immutable manual installations retain prior versions |
| Storage | Laravel redirects `storage_path()` into application data; this machine resolves `/home/clj/.config/bckgrnd-msc/storage` |
| Projects | `storage/app/projects`, current/previous/recovery snapshots, locked atomic writes; same format as browser/MCP |
| Legacy identity | Existing known old-identity project/preset JSON is copied into `app/legacy-imports`; originals/copies never overwritten |
| Exports | Offline worker renders snapshot v1/project v3; chooser publishes WAV atomically; last export can be revealed |
| Closing | Renderer confirms save before PHP shuts down; failed save stays open; running export offers keep-open or cancel-and-quit |
| Artifacts | Unsigned Linux `.tar.xz` and `.deb`; tar installation exercised. `.deb` installation needs a separate package-manager test |

## Build and install

Use locked dependencies: `composer install`, `pnpm install --frozen-lockfile`, then
`composer native:install`. The installer preserves the reviewed Composer scripts.
`composer dev:desktop` invokes the documented `native:run --installer=pnpm`.
`php artisan native:build linux` builds optimized WASM, app, worklet and desktop.
Use `sh scripts/install-linux.sh /absolute/path/to/archive.tar.xz` for a per-user
installation and desktop launcher. It installs under an archive-hash directory,
so an update cannot rewrite a running executable. No developer tools are required
for ordinary installed playback or WAV export.

The focused, fail-closed `scripts/prepare-native.mjs` compatibility patch is pinned
to Desktop 2.4.0. It supports pnpm, a sandbox-compatible narrow preload, validated
main-frame close IPC, single-instance ownership, persistent bootstrap caches and
confirmed shutdown before server termination. Review it when updating NativePHP.
It replaces the upstream AppImage target: its generated launcher added
`--no-sandbox`. That diagnostic artifact is **not a supported distributable**.

The Linux test host is Debian 13 under WSL2/WSLg. Its minimal desktop lacked an XDG
file chooser portal. A temporary portal/GTK backend enabled native-dialog testing;
this is a host dependency, not a renderer security exception. Normal desktop
distributions should supply their desktop's chooser backend. No sandbox, context
isolation or web-security flag was disabled.

## Required packaged files

- `resources/build/php/php` and Laravel's production vendor dependencies.
- `resources/build/app/public/build/assets`: app/CSS and hashed export worker.
- `public/build/engine-worklet.js`, `public/wasm`, `public/library`, `public/shared`.
- `contracts/` and `public/build-manifest.json`: commit, renderer/schema versions,
  frontend/worklet/engine/library/contracts/shared content hashes.
- Native preload and product metadata/icon. The narrow file endpoint validates
  a native token and origin, accepts no arbitrary caller-provided file paths, and
  obtains output/input locations through native dialogs.

Build cleanup excludes development sources, nested environment files, project
data, logs, tests and maps while retaining all runtime assets. Inspect the final
archive and installed executable, not only `linux-unpacked` or the dev window.
The manifest mismatch error instructs reload/reinstall instead of silent playback.

## Verification boundaries

`tools/verify-native.mjs` drives the installed app through native X11 file/close
actions. Test-only variables: `NATIVE_BINARY`, `XDOTOOL`, optional `BWRAP` (hides
the checkout), optional `BROWSER_PROJECT`, and `NATIVE_DEBUG_PORT`. It needs
Playwright, a C compiler/X11 headers, xdotool and xclip on the test host; none ships
as an application requirement. CDP is enabled only by test launch arguments.

`NATIVE_CDP=... node tools/verify-render-parity.mjs` compares the actual packaged
export worker with browser and MCP. `verify-resume.mjs` checks simulated
interruption; `/probe.html` measures stereo, signal and meter agreement in the
installed origin. Actual speaker listening, physical sleep/resume and output-device
changes require separate human/device evidence. Narrow browser layouts do not
certify phone audio or accessibility. The release checklist keeps those gates visible.
