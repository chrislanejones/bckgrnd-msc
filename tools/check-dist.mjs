/**
 * Audit the static (Netlify) build in dist/, without a browser or a server.
 *
 * Night 6G, section 1: the web distribution must stand on its own. This checks that
 * dist/ holds everything a static host needs, nothing it must not serve, and that it
 * carries the same engine, worklet, contracts and shared renderer as the desktop
 * build when one is present in public/.
 *
 *   node tools/check-dist.mjs            # after `pnpm run build:netlify`
 *
 * Exit status is non-zero on any failure. Warnings (a dirty tree) do not fail it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const warn = (text) => console.log(`warn  ${text}`);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const walk = (dir) => {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) visit(p); else out.push(relative(dir, p).replaceAll('\\', '/'));
    }
  };
  if (existsSync(dir)) visit(dir);
  return out.sort();
};

if (!existsSync(dist)) {
  console.error('dist/ is missing. Run `pnpm run build:netlify` first.');
  process.exit(1);
}
const files = walk(dist);

// 1. Everything the page loads.
for (const f of [
  'index.html', 'build-manifest.json', 'favicon.svg',
  'build/assets/app.js', 'build/assets/app.css', 'build/engine-worklet.js',
  'wasm/bckgrnd_msc_engine_bg.wasm', 'wasm/bckgrnd_msc_engine.js',
  'contracts/parameters.json', 'shared/runtime.js',
]) check(`dist/${f} exists`, files.includes(f));
const tracks = files.filter((f) => /^library\/[^/]+\.json$/.test(f));
const catalog = files.filter((f) => f.startsWith('library/variations/'));
check('track library exported', tracks.length >= 18, `${tracks.length} files`);
check('variation catalog exported', catalog.length >= 18, `${catalog.length} files`);

// 2. Nothing a static host must not hand out.
const forbidden = files.filter((f) => /\.php$|(^|\/)\.env|^vendor\/|^nativephp\/|^storage\/|\.map$/.test(f));
check('no PHP, env, vendor, NativePHP, storage or source maps', forbidden.length === 0, forbidden.slice(0, 5).join(', '));

// 3. The shell and bundle are the static ones.
const manifest = JSON.parse(readFileSync(resolve(dist, 'build-manifest.json'), 'utf8'));
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const app = readFileSync(resolve(dist, 'build/assets/app.js'), 'utf8');
check('shell carries no desktop token', !html.includes('bckgrnd-native-token'));
check('shell cache-busts app.js/app.css with this build',
  html.includes(`app.js?v=${manifest.buildId}`) && html.includes(`app.css?v=${manifest.buildId}`));
check('bundle has the desktop store folded out', !app.includes('bckgrnd-native-token'),
  'isDesktop() must be constant-false when VITE_STATIC=1');
check('bundle is pinned to this build (worklet/wasm cache key)', app.includes(manifest.buildId));

// 4. The manifest describes what was actually shipped.
check('manifest format', manifest.format === 'bckgrnd-msc/build' && manifest.version === 1);
check('manifest contract versions', manifest.projectVersion === 3 && manifest.snapshotVersion === 1
  && manifest.renderer === 'project-renderer-1',
  `project v${manifest.projectVersion}, snapshot v${manifest.snapshotVersion}, ${manifest.renderer}`);
const tree = (name, sub) => {
  const bad = Object.entries(manifest[name]).filter(([f, h]) => !existsSync(resolve(dist, sub, f)) || sha(resolve(dist, sub, f)) !== h);
  check(`manifest ${name} hashes match dist/${sub}`, bad.length === 0, bad.slice(0, 3).map(([f]) => f).join(', '));
};
tree('engine', 'wasm'); tree('contracts', 'contracts'); tree('shared', 'shared'); tree('library', 'library');
check('manifest worklet hash matches dist', sha(resolve(dist, 'build/engine-worklet.js')) === manifest.worklet);
if (manifest.dirty) warn(`built from a dirty tree at ${manifest.appCommit.slice(0, 12)}: not release evidence`);

// 5. One engine, two distributions: the desktop build in public/ must agree.
const desktopPath = resolve(root, 'public/build-manifest.json');
if (!existsSync(desktopPath)) {
  warn('no public/build-manifest.json: desktop/Laravel build not present, cross-build check skipped');
} else {
  const desktop = JSON.parse(readFileSync(desktopPath, 'utf8'));
  const same = (k) => JSON.stringify(desktop[k]) === JSON.stringify(manifest[k]);
  for (const k of ['engine', 'worklet', 'contracts', 'shared', 'renderer', 'projectVersion', 'snapshotVersion', 'frontend']) {
    check(`desktop and web share ${k}`, same(k));
  }
  // The desktop serves variations from PHP, so only the track files must agree.
  const lib = (m) => Object.fromEntries(Object.entries(m.library).filter(([f]) => !f.startsWith('variations/')));
  check('desktop and web share the track library', JSON.stringify(lib(desktop)) === JSON.stringify(lib(manifest)));
}

console.log(`\nbuild ${manifest.buildId.slice(0, 12)} · app ${manifest.appCommit.slice(0, 12)}${manifest.dirty ? ' (dirty)' : ''}`
  + ` · wasm ${sha(resolve(dist, 'wasm/bckgrnd_msc_engine_bg.wasm')).slice(0, 12)}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
