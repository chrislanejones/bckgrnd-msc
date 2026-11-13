/**
 * One verification command per distribution (Night 6G, section 1).
 *
 *   pnpm run verify:web       # the Netlify build in dist/: no PHP at runtime, no Laravel
 *   pnpm run verify:desktop   # Laravel + the NativePHP-facing code paths
 *
 * Both start from shared gates (contracts, scenes, editing, types), then exercise
 * their own distribution. The web suite serves dist/ with a plain static server, so
 * an accidental API dependency fails the same way it would on Netlify. The desktop
 * suite runs PHPUnit and the browser checks against `php artisan serve`; the
 * installed-app check (`tools/verify-native.mjs`) runs only with VERIFY_NATIVE=1,
 * because it needs an installed app, X11 and xdotool.
 *
 * Build first: `pnpm run build:netlify` (web) or `pnpm run build` (desktop).
 */
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = process.argv[2];
if (!['web', 'desktop'].includes(target)) {
  console.error('usage: node tools/verify-suite.mjs web|desktop');
  process.exit(2);
}

const results = [];
function step(name, cmd, args, env = {}) {
  console.log(`\n=== ${name}`);
  // Chromium cannot open UTF-8 file paths under the C locale, and the project checks
  // deliberately use a non-ASCII temp path. Minimal images often leave LANG unset.
  const locale = process.env.LANG ? {} : { LANG: 'C.UTF-8' };
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...locale, ...env } });
  results.push([name, r.status === 0]);
  return r.status === 0;
}
async function withServer(cmd, args, url, fn) {
  const server = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn();
  } finally { server.kill(); }
}

step('contract', 'node', ['tools/check-contract.mjs']);
step('scenes', 'node', ['tools/check-scenes.mjs']);
step('editing', 'node', ['tools/check-editing.mjs']);
step('typecheck', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);

if (target === 'web') {
  step('dist audit', 'node', ['tools/check-dist.mjs']);
  const url = 'http://127.0.0.1:8090';
  await withServer('node', ['tools/serve-dist.mjs', '8090'], url, async () => {
    step('static browser: library, catalog, audio', 'node', ['tools/verify-static.mjs', url]);
    step('static browser: projects, save/reopen, export', 'node', ['tools/verify-projects.mjs', url]);
  });
} else {
  step('phpunit', 'php', ['vendor/bin/phpunit']);
  const url = 'http://127.0.0.1:8080';
  await withServer('php', ['artisan', 'serve', '--host=127.0.0.1', '--port=8080'], url, async () => {
    step('ui', 'node', ['tools/verify-ui.mjs', url]);
    step('editor', 'node', ['tools/verify-editor.mjs', url]);
    step('audio', 'node', ['tools/verify-audio.mjs', url]);
    step('projects', 'node', ['tools/verify-projects.mjs', url]);
  });
  if (process.env.VERIFY_NATIVE === '1') step('installed native app', 'node', ['tools/verify-native.mjs']);
  else console.log('\n(skipped installed native app: set VERIFY_NATIVE=1 on a machine with the app installed)');
}

console.log(`\n${target} verification:`);
for (const [name, ok] of results) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
