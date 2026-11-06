import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Release builds require wasm-opt. A failed optimization fails the build.
execFileSync('wasm-opt', ['--version'], { stdio: 'inherit' });
execFileSync('wasm-pack', ['build', '--target', 'web', '--release', '--out-dir', '../public/wasm'], {
  cwd: fileURLToPath(new URL('../engine-core/', import.meta.url)), stdio: 'inherit',
});
