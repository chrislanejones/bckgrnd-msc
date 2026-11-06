# Night 6 release checklist

Candidate evidence is in [NIGHT6_PROTOCOL.md](NIGHT6_PROTOCOL.md). A check is complete
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
- [ ] Freeze clean source commit, rebuild native/static/MCP, record final hashes.
- [ ] Recheck the final distributable after all packaging transformations.
- [ ] Execute saved-project validation/render/narration from this actual T3 client.
- [ ] Human listening on the installed Linux app, including solo/held effects.
- [ ] Physical sleep/resume and output-device changes.
- [ ] Verify the intended production deployment identity and cached/fresh clients.
- [ ] Record final rollback locations and source/artifact evidence in the handoff.

Unsigned Linux candidate only. `.deb` package-manager installation, Windows,
macOS and real iOS/Android devices are untested until separate evidence exists.
No automatic updater is enabled. No release may infer those platforms from WSL
signal measurements or responsive browser checks.
