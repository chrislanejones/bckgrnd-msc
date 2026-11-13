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
- [x] Execute saved-project validation/render/narration from this actual T3 client.
  11-07-2026, MCP 0.4.0-rc.1-d47ee15-deps: validate valid with no warnings, an 8 s
  render in 583 ms, narration mix at -17.7 LUFS.
- [ ] Human listening on the installed Linux app, including solo/held effects.
- [ ] Physical sleep/resume and output-device changes.
- [ ] Actual minimization: WSL ignored the test request; no pass is claimed.
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
- [ ] `verify:desktop` and Rust gates on the laptop with the RC toolchain; engine hash = RC1.

Section 2 — desktop (laptop)
- [ ] Installed rc.2: Save As, edit, Save; file updates, `.bak` appears, mode not 0600.
- [ ] Move the file, Save: warning names the missing file; quit asks; recovery available.
- [ ] Human listening: eight stems, solo/mute, Echo Throw, Filter Hold, scenes, fills, drops,
  start/stop clicks, stereo, kick/bass, exported WAV vs live.
- [ ] Sleep/resume, output-device change, headphones unplug/replug, minimize/restore,
  close while exporting; nothing stuck.
- [ ] `.deb` through the package manager: menu launch, identity/icon, storage, audio, export,
  remove + reinstall keeps projects.

Section 3 — release (laptop)
- [ ] Netlify preview from the rc.2 `dist/`, fresh and cached; promote only after Section 2.
- [ ] MCP through T3 against rc.2 projects; hashes match.
- [ ] rc.2 release record, hashes, deploy ID, Codeberg/GitHub sync, integration PR, rollback.
