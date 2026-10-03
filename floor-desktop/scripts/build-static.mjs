/**
 * Produce the static build.
 *
 * Generates everything a PHP-free deployment needs:
 *
 *   public/library/*.json  — the track library, exported from the PHP source so the
 *                            static and Laravel shapes cannot disagree
 *   public/index.html      — the shell, copied from frontend/static.html
 *
 * The wasm engine and the Vite bundle are separate steps; this only covers what the
 * library and the document shell need.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libraryDir = resolve(root, 'public/library');

function run(command, args, label) {
  process.stdout.write(`[static] ${label}\n`);
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

// 1. Export the library from PHP. This is the same `App\Support\Music\Library` the API
//    serves, so the two shapes are guaranteed to describe the same instrument.
if (!existsSync(resolve(root, 'vendor/autoload.php'))) {
  console.error(
    '[static] vendor/ is missing — run `composer install` before the static build.',
  );
  process.exit(1);
}
run('php', ['tools/export-library.php', 'public/library'], 'exporting the track library');

// 1b. Rebuild the app with VITE_STATIC=1, so the bundle reads the exported JSON
//     directly instead of firing an /api request that a static host cannot answer.
//     Done here rather than relying on a runtime probe: a probe would 404 on every
//     page load.
run('pnpm', ['run', 'build:app:static'], 'building the app in static mode');

// 2. Copy the shell. `public/index.html` is only reached when there is no Laravel
//    route in front of it; with `php artisan serve` the route wins.
mkdirSync(resolve(root, 'public'), { recursive: true });
copyFileSync(resolve(root, 'frontend/static.html'), resolve(root, 'public/index.html'));
console.log('[static] wrote public/index.html');

// 3. Sanity check: the engine and the frontend bundle must already exist, or the
//    result is a shell that renders nothing.
const missing = [];
for (const asset of [
  'public/wasm/floor_engine_bg.wasm',
  'public/build/assets/app.js',
  'public/build/engine-worklet.js',
]) {
  if (!existsSync(resolve(root, asset))) missing.push(asset);
}
if (missing.length) {
  console.error(
    `[static] missing build output: ${missing.join(', ')}\n` +
      '         run `pnpm run build:engine && pnpm run build` first.',
  );
  process.exit(1);
}

console.log('[static] ready — serve public/ with any static file server');