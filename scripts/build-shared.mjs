import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, 'public/shared'), { recursive: true });
await build({ entryPoints: [resolve(root, 'frontend/lib/shared.ts')], outfile: resolve(root, 'public/shared/runtime.js'), bundle: true, format: 'esm', platform: 'neutral', target: 'es2022' });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.shared.json'], { cwd: root, stdio: 'inherit' });
function extensions(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) extensions(path);
    else if (entry.name.endsWith('.d.ts')) writeFileSync(path, readFileSync(path, 'utf8').replace(/from '((?:\.\.?\/)[^']+)'/g, (_s, p) => `from '${p.endsWith('.js') ? p : p + '.js'}'`));
  }
}
extensions(resolve(root, 'public/shared/types'));
writeFileSync(resolve(root, 'public/shared/runtime.d.ts'), "export * from './types/frontend/lib/shared.js';\n");
