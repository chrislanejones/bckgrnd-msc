# Night 6 Linux candidate — 2026-11-06

**Built, installed, tested automatically, and web deployed. Not final Night 6
signoff:** this active T3 session has not discovered the newly configured MCP tools;
installed-app speaker listening and physical device interruptions remain open.

## Source and artifacts

The November 5 interface and expanded Cancel behavior were preserved. Baseline app
`296dc35102ec40252a01db37373c97fe39ae8041` was clean local `master` tracking
`codeberg/main`; MCP `e4b27a122b4e163190f520611878f83a08a313fd` was on
`feat/beat-map`. Unrelated MCP `.agents/`, `.playwright-mcp/`, `skills-lock.json`
remain untouched. No destructive reset, cleanup or history rewrite was used.

Both repositories use candidate branch `night6/linux-release-candidate`. This
work is not merged into `main`, and the MCP candidate is not registry-published.

| Item | Identity |
|---|---|
| Frozen app/runtime source | `4f5a5e3083521bdb2e0bf825c5de805a9f63e628` |
| Installer and verification source | `44e02c9f7b0c620b30a3d4e014820d2450adfb22` — no bundled engine/runtime change |
| MCP package source | `d47ee150cc193c3360617ffac223399c6aed3dd6` |
| Shared build | `885e516519d1db0725cd5adf0cd34e7cc1d7e46705cae64517f7f5c6d700605e` |
| Native candidate | `0.6.0-rc.1`, unsigned Linux x64 tar; `.deb` inspected but not installed |
| MCP candidate | `0.4.0-rc.1`, ten local stdio tools |
| Document support | Snapshot v1, musical project v3, `project-renderer-1` |
| Production | `https://bckgrnd-msc.netlify.app`, deploy `6aed8624a1f55f1aabaa7b8a` |

The [machine-readable release record](../releases/2026-11-06-linux-rc1.json) records
all archive, lockfile and content hashes, runtime versions and platform boundaries.
Documentation commits after the freeze do not change the recorded artifact source.
The durable local release folder is:

`~/.local/share/bckgrnd-msc/releases/night6-rc1-4f5a5e3/`

It contains native tar/deb, MCP tgz, static archive, `install-linux.sh`,
`build-manifest.json`, `release.json`, `SHA256SUMS`, raw evidence logs and acceptance
projects/WAVs. Verify with `sha256sum -c SHA256SUMS` from that folder. Install with
`sh install-linux.sh "$PWD/bckgrnd-msc-0.6.0-rc.1.tar.xz"`.
The installed application is `~/.local/bin/bckgrnd-msc` with a desktop launcher.
It stores work at `~/.config/bckgrnd-msc/storage/app/projects`.

## What now works

Night 5 saving/export was absent at baseline. The candidate adds versioned projects,
revision-aware status, atomic recoverable storage, legacy import, unified project
undo and immutable WAV export. Browser/static use IndexedDB; NativePHP uses the same
format in application data. A/B stays session-only. Projects own scenes/patterns;
transient gestures and unaccepted variations are excluded. Crossfade ownership is
explicit. Full → Drop → Cancel restores the original mix/pattern return point,
clears queued/active selections, preserves playback and survives saving/reopening.

NativePHP Desktop 2.4 replaces the obsolete packages. The real provider, menus,
identity, bundled PHP 8.4.27, narrow validated file/close interfaces and conservative
updater policy are in place. Sandbox/context isolation/web security stay enabled.
The immutable manual installer retains old versions. The WSL launcher uses the
supported Electron 40 GTK chooser fallback, tested after stopping both temporary
portal processes. No diagnostic no-sandbox launcher is shipped as supported.

Reproduced ADSR/kick-click/clap/brake/solo-return defects are fixed with regressions.
Resolved patterns drive visual activity; velocity keys coalesce; combined scene/fill
cancellation and unavailable held FX report correctly. Intentional tonal differences
and deferred creative scope are recorded in [the parking lot](../../PARKING_LOT.md).

## Fresh evidence

- PHP 245 tests / 5832 assertions; Rust 259 tests including integrations/doctest;
  Clippy, TypeScript, contracts/scenes/editing, UI/editor/audio and static gates pass.
- Laravel and static: edit drums/bass/effects, scene capture, save/reopen stopped,
  WAV, failed save, cancellation, old import, preview exclusion and recovery pass.
- Installed tar: browser-file import, drum/bass edits, two scene choices/Cancel,
  save, native dialog cancellation, failed-write close, export keep-open/cancel-quit,
  Save As and persistent stopped reopen pass. Paths include spaces/non-ASCII.
- Installed startup works with checkout hidden and a restricted PATH. With dev
  servers stopped, the packaged audio probe reports secure context, running
  AudioContext, worklet/WASM, 44.1 kHz stereo signal, meter agreement and no engine
  errors. Simulated resume/repeated start-stop pass; exports complete during playback.
- Browser/native/MCP edited and silent fixtures match events, mix, frames and WAVs.
  The final native project revision also matches the production and installed MCP
  exports: 1462857 stereo PCM16 frames at 48 kHz, SHA256
  `b381a1e8a94bc94111ef613de5da065b957ed685663c2cd3ee01c6f43a667a7e`.
- MCP: typecheck/lint, 63 tests, clean packed install, ten tools, old workflows,
  saved-project validation/render/narration, preset migration backups and dependency
  errors pass. Final installed stdio test uses another cwd and restricted PATH.
  Narration uses the local test fixture; missing ffmpeg/ffprobe does not disable music.
- Production: the previous deployment lacked even November 5 editing/saving. The
  new deploy was checked in its previously cached browser session and a fresh one.
  App/worklet/WASM use the same build ID; import/save/reopen stopped/play/export pass.
  This is deployment evidence independent of Git pushes.

## T3 connection and remaining gates

Only the `bckgrnd-msc` Codex entry was configured. It launches:

```text
/home/clj/.fnm/node-versions/v24.21.0/installation/bin/node
/home/clj/.local/share/bckgrnd-msc/MCP Companion/0.4.0-rc.1-d47ee15/node_modules/bckgrnd-msc-mcp/dist/index.js
```

Its environment explicitly names `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`.
A scoped `codex mcp get bckgrnd-msc` shows the configuration. Reconnect the T3/Codex
MCP session, then call validate, render and mix-under-voice with
`acceptance/native-saved.bckgrnd.json` from the release folder. The SDK acceptance
already passed that chain, but it is **not a real T3 tool call**.

Actual speaker listening, physical sleep/resume and output-device changes remain
unverified. WSL ignored the minimization request (WM_STATE stayed Normal), so that
check also remains open. Linux tar is an unsigned candidate; `.deb` installation,
Windows/macOS and all real iOS/Android audio/touch/accessibility checks are untested.
Responsive layout measurements do not certify phones. No final distribution-ready
or whole-Night-6 completion claim is made.

## Rollback

- Keep application data and exported project originals. Storage retains committed,
  previous and recovery records; legacy imports retain originals. Current validation
  rejects unsupported newer versions before mutating the open composition.
- Previous installed native version remains under
  `~/.local/share/bckgrnd-msc/versions/a6019f260bbf199e535aecbc26f69dfa520ad5af992a4fbd430c8c7e4152a008/`.
  Stop the app before relaunching an earlier executable. Back up project storage
  first; never downgrade a project document in place.
- `~/.local/share/bckgrnd-msc/rollback/` retains earlier native/package artifacts,
  the integrity-verified public MCP 0.3.1 tarball and baseline vendored engine.
  The rejected AppImage is historical evidence only: its launcher disables the
  sandbox, so do not run or distribute it as a fallback.
- Previous Netlify deploy `6aeb2a2cae85af350de2f7bc` remains available for rollback.
  Restore that complete deployment through Netlify rather than mixing individual
  app/worklet/WASM assets. The new static archive is retained locally too.
- A private mode-600 backup of the prior Codex configuration is in the rollback
  folder. Do not publish it; restore only the `bckgrnd-msc` entry if needed, preserving
  any unrelated changes made since this session.

The authoritative remaining checks are in [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md).
