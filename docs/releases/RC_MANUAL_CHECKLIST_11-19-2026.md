# RC manual checklist (11-19-2026)

Everything still open on the Linux release candidate, as steps you can run top to bottom.
Source: [RELEASE_CHECKLIST.md](../RELEASE_CHECKLIST.md) (Night 6G Section 2–3, Night 6I),
[the rc.3 record](2026-11-15-linux-rc3.json) `remaining`, and the
[Night 6G laptop runbook](../sessions/2026-11-13-night6g.md).

## Where things stand

| Item | State |
|---|---|
| Installed candidate | **rc.3** (`19c93c5`, desktop `0.6.0-rc.3`), built 11-15-2026 |
| `main` now | **`fdfcdf8`**: Night 7 merged (37 commits since rc.3) |
| Night 7 runtime changes | Engine (`build.rs`, `lib.rs`, `scheduler.rs`), worklet (+182 lines), `Library.php` (hip-hop), `projects.ts`, `ProjectMenu.tsx` |
| Engine hash | rc.3 `6ed97035573c` (= RC1) → main **`2a36a47a81b4`** |
| `night6i/signoff` branch | **Does not exist yet** (no local or remote branch) |
| Rendered audio | Byte-identical, rc.3 bundle vs main bundle (see the MCP section below) |

**Rebuild needed: yes.** rc.3 has no Rise, no dense layout and the old engine, and the
project list and recovery message changed in `ProjectMenu.tsx` / `projects.ts`. Hands-on results
from rc.3 would not be evidence for a release cut from `main`. Build once from the commit you
mean to ship (after Night 8 stabilize merges), run this list on that build, and record it.
The version number (rc.4 or a new line) is your call.

Build command (from the session logs; no build time was recorded):

```bash
php artisan native:build linux x64
```

It builds the optimized WASM, app, worklet and desktop package (`NIGHT6_INVENTORY.md`).
Run it under the hangup guard. It is the heaviest job in the repo.

## 0. Before you start

| # | Step | Expected | Pass |
|---|---|---|---|
| 0.1 | `git -C ~/repo/bckgrnd-msc status --short && git -C ~/repo/bckgrnd-msc rev-parse --short HEAD` | Clean; the commit you mean to ship | [ ] |
| 0.2 | `ls ~/.config/bckgrnd-msc/storage/app/projects` and copy it to `~/.local/share/bckgrnd-msc/backups/projects-before-<version>-<MM-DD-YYYY>` | Copy exists | [ ] |
| 0.3 | Note the rc.3 rollback: `~/.local/share/bckgrnd-msc/releases/night6-rc3-19c93c5` | Folder exists | [ ] |

## 1. Automated suites on the release commit

| # | Step | Expected | Pass |
|---|---|---|---|
| 1.1 | `pnpm run build:netlify` | Exits 0; `dist/build-manifest.json` appCommit = HEAD | [ ] |
| 1.2 | `pnpm run verify:web` | All steps ok (last run on `fdfcdf8`, 11-18-2026: **pass**) | [ ] |
| 1.3 | `pnpm run build && pnpm run verify:desktop` | All steps ok, PHPUnit included (11-18-2026 on `fdfcdf8`: **pass**) | [ ] |
| 1.4 | `(cd engine-core && cargo fmt --check && cargo clippy --release --all-targets -- -D warnings && cargo test --release)` | Clean; all tests pass (283 at `fdfcdf8`) | [ ] |
| 1.5 | Record the engine SHA256 from `public/build-manifest.json` | Write it down; it will **not** equal RC1 any more, which is expected after Night 7 | [ ] |

## 2. Build and install

| # | Step | Expected | Pass |
|---|---|---|---|
| 2.1 | `php artisan native:build linux x64` | A `.deb` and a `.tar.xz`; note the paths it prints | [ ] |
| 2.2 | `sha256sum` both artifacts into the new release record | Hashes recorded | [ ] |
| 2.3 | `sudo apt install ./bckgrnd-msc_<version>_amd64.deb` (**never tested through apt yet**) | Installs with no dependency errors | [ ] |
| 2.4 | Launch from the application menu | Name **bckgrnd-msc**, correct icon, opens with no checkout | [ ] |
| 2.5 | Projects menu lists your existing projects | Same list as 0.2, newest first, dates `MM-DD-YYYY h:mm AM` | [ ] |
| 2.6 | Tar path: `sh scripts/install-linux.sh /abs/path/bckgrnd-msc-<version>.tar.xz` | Installs; old versions kept under `~/.local/share/bckgrnd-msc/versions/` | [ ] |
| 2.7 | `node tools/verify-native.mjs` against the installed app (X11, xdotool, xclip) | Passes, closes the app, file and WAV are `-rw-r--r--` | [ ] |

## 3. File handling: Save As, Save, `.bak`, moved file

| # | Step | Expected | Pass |
|---|---|---|---|
| 3.1 | Open a project → **Save As** → `~/Music/test.bckgrnd.json` | File written | [ ] |
| 3.2 | Change a knob → **Save** | Revision goes up; `~/Music/test.bckgrnd.json.bak` appears | [ ] |
| 3.3 | `ls -l ~/Music/test.bckgrnd.json*` | Not `0600` (`-rw-r--r--` under umask 022) | [ ] |
| 3.4 | `mv ~/Music/test.bckgrnd.json /tmp/` → edit → **Save** | "Saved … in the app. The project file was not updated: It's no longer at …. Use Save As to choose a new place." Not a plain "Saved" | [ ] |
| 3.5 | Try to quit | Confirm says the file couldn't be updated. Cancel | [ ] |
| 3.6 | **Save As** somewhere new, then quit | Quits with no prompt | [ ] |
| 3.7 | Projects → Recover | Recovery folder opens; the Recover button's tooltip gives the date | [ ] |

## 4. Persistence and package removal

| # | Step | Expected | Pass |
|---|---|---|---|
| 4.1 | Quit, relaunch | Last project reopens **stopped** (no autoplay) | [ ] |
| 4.2 | `sudo apt remove bckgrnd-msc` (**not** `purge`) | Removed; `~/.config/bckgrnd-msc/storage/app/projects` still there | [ ] |
| 4.3 | Reinstall with 2.3, launch | All projects still listed | [ ] |

## 5. Rise (new in Night 7, never run on an installed build)

| # | Step | Expected | Pass |
|---|---|---|---|
| 5.1 | Play a track. Switch on → **Rise**, pick **4** | Bars picker shows 2 · 4 · 8 | [ ] |
| 5.2 | Press **Drop** | Pad reads "Rise · Bar N", then "Rising · 1 of 4" … ; knobs visibly turn | [ ] |
| 5.3 | Let it land | "Active" exactly on a bar line; no click, no gap | [ ] |
| 5.4 | Rise again, press the rising pad at bar 2 | Mix glides back to where it started | [ ] |
| 5.5 | Rise, move one knob mid-rise | That knob stays where you put it; scene lands "Active · Modified" | [ ] |
| 5.6 | Rise, then Stop / seek / Panic / load another track (one each) | Rise cancels each time; nothing stuck | [ ] |
| 5.7 | Repeat 5.2 at **2** and **8** bars | Same, ending on a bar line | [ ] |
| 5.8 | Shift+4 with Rise on | Rises into Drop | [ ] |
| 5.9 | Slow track (≤ 80 bpm), 8 bars | Listen for **stepped** filter movement (open question from Night 7) | [ ] |

## 6. Listening and interruptions (headphones and speakers)

| # | Step | Expected | Pass |
|---|---|---|---|
| 6.1 | All eight stems; solo and mute each | No lingering echo after solo | [ ] |
| 6.2 | Echo Throw, Filter Hold | Release cleanly, nothing held | [ ] |
| 6.3 | Scenes, fills, drops; start/stop ten times | No clicks | [ ] |
| 6.4 | Stereo placement; kick/bass | Sounds right | [ ] |
| 6.5 | Cipher and Boulevard (100 / 105 bpm) | Hip-hop, not lo-fi | [ ] |
| 6.6 | Export a WAV; play it next to live | Same sound | [ ] |
| 6.7 | Sleep/resume; switch output device; unplug/replug headphones; minimize/restore; close while exporting | Nothing stuck; minimize really minimizes | [ ] |
| 6.8 | Panic | Silence, nothing held | [ ] |

## 7. MCP and web

| # | Step | Expected | Pass |
|---|---|---|---|
| 7.1 | Resync the MCP vendor from the release commit (see below) and pack | `vendor/SOURCE.json` commit = release commit | [ ] |
| 7.2 | `NATIVE_CDP=http://127.0.0.1:9224 node tools/verify-render-parity.mjs` | Browser ↔ installed ↔ MCP byte-identical | [ ] |
| 7.3 | MCP through T3: validate + render a Save As project from 3.1 | Valid, schema 3, renders | [ ] |
| 7.4 | `netlify deploy --dir dist` (preview), then `node tools/verify-static.mjs <preview URL>` | All checks pass, fresh and cached | [ ] |
| 7.5 | Only after 2–6 pass: `netlify deploy --dir dist --no-build --prod` | Deploy ID recorded | [ ] |

## 8. Record

| # | Step | Expected | Pass |
|---|---|---|---|
| 8.1 | New `docs/releases/<YYYY-MM-DD>-linux-<version>.json`, shaped like rc.3's | Hashes, engine, deploy ID, `humanChecks` filled in | [ ] |
| 8.2 | Tick `RELEASE_CHECKLIST.md`; keep the label "unsigned Linux release candidate" | Updated | [ ] |
| 8.3 | Push the record branch to GitHub and Codeberg; open the PR | PR open | [ ] |

## MCP audit, 11-19-2026

| Check | Result |
|---|---|
| MCP branch | `night6/linux-release-candidate` at **`f89830d`** (PR #1 merged) |
| Tracks | **20** (EDM 6 · Lofi 6 · Breaks 6 · Hip-hop 2) |
| Hip-hop section | Cipher (Boom Bap, **100**, energy 2), Boulevard (West Coast, **105**, energy 3) |
| Companion renders, 24 s | Cipher loop −2.3 / −18.3 dBFS RMS · evolving −3.4 / −19.5 · Boulevard loop −2.6 / −19.0 · evolving −3.7 / −20.3 |
| Vendor (59995c1) vs `main` (fdfcdf8) | **112 of 117** vendored files identical; differ: 4 engine files, `shared/types/…/scenes.d.ts` |
| Renders, rc vendor vs `main` engine | **Byte-identical**: 4 track renders + both release fixtures (`edited`, `silent`) |

Night 7's engine changes (timed builds, linked lanes) don't touch offline rendering, so the
MCP sounds the same either way. **A resync is still needed before an MCP rc.2 ships next to a
desktop built from `main`:** `verify-render-parity` asserts the engine hashes match across
browser, installed app and MCP, and they won't (`6ed97035573c` vs `2a36a47a81b4`). Resync
from the same commit as the desktop build, in step 7.1.
