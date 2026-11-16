# Night 6 release checklist

Candidate evidence is in [NIGHT6_PROTOCOL.md](NIGHT6_PROTOCOL.md) and the
[final artifact record](releases/2026-11-06-linux-rc1.json). A check is complete
only for the named artifact/environment. Historical passes and pushes are not
release evidence.

- [x] Protect baseline commits, branch/remotes, lockfiles and unrelated MCP files.
- [x] Preserve November 5 layout and expanded Cancel behavior.
- [x] Browser edit/save/reopen without autoplay/export; failed save, recovery,
  old import and excluded variation preview.
- [x] Static build has independent assets/persistence and no accidental API calls.
- [x] Unified project undo, coalesced velocity keys, resolved pattern visuals.
- [x] Targeted audio correctness tests and optimized engine build.
- [x] NativePHP v2 provider, compatible PHP/Node, identity, persistent adapter.
- [x] Installed Linux tar: native dialogs, file cancellation, failed close save,
  export keep-open/cancel-and-quit, persistent stopped reopen.
- [x] Installed app starts with checkout hidden and restricted network requests.
- [x] Browser/native/MCP edited and silent fixtures produce matching events/frames/WAV.
- [x] MCP packed clean installation: ten tools, contracts/assets, project rendering,
  narration, preset backup migration and missing dependency errors.
- [x] Freeze clean source commit, rebuild native/static/MCP, record final hashes.
- [x] Recheck the final distributable after all packaging transformations.
- [ ] Installed app, after a rebuild: Save As, edit, Save. The chosen file updates and a `.bak` appears. Then move the file, Save again, and read the warning.
  11-13-2026: Chris reports Save As and Save work, but the installed app is RC1 (11-06),
  built before the save fixes. Recheck on rc.2.
- [x] Execute saved-project validation/render/narration from this actual T3 client.
  11-07-2026, MCP 0.4.0-rc.1-d47ee15-deps: validate valid with no warnings, an 8 s
  render in 583 ms, narration mix at -17.7 LUFS.
- [x] Human listening on the installed Linux app, including solo/held effects.
  11-13-2026: Chris, hands-on, installed RC1: pass.
- [x] Physical sleep/resume and output-device changes.
  11-13-2026: Chris, hands-on, installed RC1: pass.
- [x] Actual minimization (WSL ignored the automated request).
  11-13-2026: Chris, hands-on, installed RC1: pass.
- [x] Verify the intended production deployment identity and cached/fresh clients.
- [x] Record final rollback locations and source/artifact evidence in the handoff.

Unsigned Linux candidate only. `.deb` package-manager installation, Windows,
macOS and real iOS/Android devices are untested until separate evidence exists.
No automatic updater is enabled. No release may infer those platforms from WSL
signal measurements or responsive browser checks.

## Night 6G — final acceptance (rc.2)

Cloud half done 11-13-2026; laptop runbook in
[sessions/2026-11-13-night6g.md](sessions/2026-11-13-night6g.md). Desktop runtime changed
(file permissions/symlink fix, UI), so the desktop is rebuilt as `0.6.0-rc.2`. The musical
bundle (engine, library, contracts, shared renderer) did not change.

Section 1 — architecture
- [x] Netlify build needs no Composer install, no NativePHP, PHP CLI at build time only
  (verified with no `vendor/`, PHP 8.3).
- [x] Static bundle cannot select the native store; zero `/api/native` calls even with a token.
- [x] `check:dist`: dist assets, manifest hashes, and desktop↔web parity of engine, worklet,
  contracts, shared renderer, project/snapshot versions and track library.
- [x] Separate `verify:web` (7/7 pass in cloud) and `verify:desktop` commands.
- [x] `verify:desktop` and Rust gates on the laptop with the RC toolchain; engine hash = RC1.
  11-13-2026: verify:desktop 9/9, Rust 259, PHPUnit 247; engine `6ed97035573c` = RC1.

Section 2 — desktop (laptop)
- [ ] Installed rc.2: Save As, edit, Save; file updates, `.bak` appears, mode not 0600.
  11-15-2026: `verify-native` on rc.2 passes Save As; the new project file is `-rw-r--r--`.
  `.bak` and the moved-file warning are still Chris's hands-on check.
  11-13-2026: Chris reported pass on the installed RC1; rc.2 not built yet, so not rc.2 evidence.
- [ ] Move the file, Save: warning names the missing file; quit asks; recovery available.
  11-13-2026: Chris reported pass on the installed RC1; rc.2 not built yet, so not rc.2 evidence.
- [ ] Human listening: eight stems, solo/mute, Echo Throw, Filter Hold, scenes, fills, drops,
  start/stop clicks, stereo, kick/bass, exported WAV vs live.
  11-13-2026: Chris reported pass on the installed RC1; rc.2 not built yet, so not rc.2 evidence.
- [ ] Sleep/resume, output-device change, headphones unplug/replug, minimize/restore,
  close while exporting; nothing stuck.
  11-13-2026: Chris reported pass on the installed RC1; rc.2 not built yet, so not rc.2 evidence.
- [ ] `.deb` through the package manager: menu launch, identity/icon, storage, audio, export,
  remove + reinstall keeps projects.
  11-13-2026: Chris reported pass on the installed RC1; rc.2 not built yet, so not rc.2 evidence.

Section 3 — release (laptop)
- [ ] Netlify preview from the rc.2 `dist/`, fresh and cached; promote only after Section 2.
  11-13-2026: preview `6af6c83ce8d6948f50e91aa2` (build `e479e3e1ae63`) passes 12/12 fresh.
  Cached reload runs after promotion.
- [x] MCP through T3 against rc.2 projects; hashes match.
  11-13-2026: all workflows pass; installed rc.2 ↔ browser ↔ MCP WAVs byte-identical. 55/57 vendored
  files identical; the 2 shared-renderer files differ only by ADR-018's unused callback.
- [ ] rc.2 release record, hashes, deploy ID, Codeberg/GitHub sync, integration PR, rollback.
  11-13-2026: record drafted with hashes and rollback; production deploy ID and sync follow promotion.

## Night 6I — rc.3 (11-15-2026)

rc.2's installed run found exported WAVs written 0600. rc.3 (`19c93c5`) fixes that and
nothing else at runtime; the musical bundle is unchanged (engine = RC1). Section 2 above
now applies to rc.3.

- [x] WAV export gets ordinary permissions; an existing file keeps its own; the store stays
  0600. PHPUnit 248 (new regression test).
- [x] `verify-native` closes the app after a pass or a failure, and asserts the Save As file
  and WAV permissions. Red on rc.2 (`600` vs `644`, exits in 13 s, no app left); green on
  rc.3 three runs in a row, no app left.
- [x] `verify:web` 7/7, `verify:desktop` 9/9, Rust 259, fmt and Clippy clean; engine
  `6ed97035573c` = RC1; web and desktop build `073a8e825fb4`.
- [x] Package audit: same 7,636 paths as rc.2; only the two fixed PHP files, the version,
  the build stamp and Composer's commit reference differ.
- [x] Installed rc.3 (tar) ↔ browser ↔ MCP: byte-identical WAVs (`verify-render-parity`).
- [x] Preview `6af9d459f084f3cad0d32243`: verify-static 12/12, verify-projects pass, fonts load.
- [x] MCP through T3: rc.3 Save As project validates (schema 3, no warnings) and renders.
- [ ] Chris: `.deb` via apt, `.bak` and moved-file warning, listening pass, remove + reinstall.
- [x] Promote the preview, reload the cached profile, record the production deploy ID.
  Production `6afa88d474abbd321c4f629a` (build `073a8e825fb4`) passes 13/13; the profile cached
  on `2ae6c399f35f` ran the rc.3 `app.js`. Rollback: publish `6af6b434aa3215de71a06c18`.
