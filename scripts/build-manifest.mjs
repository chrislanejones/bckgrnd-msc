import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashTree = (path) => {
  const entries = {};
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) visit(p); else entries[relative(path, p).replaceAll('\\', '/')] = sha(readFileSync(p));
    }
  }; visit(path); return entries;
};
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const manifest = {
  format: 'bckgrnd-msc/build', version: 1, appCommit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain', '--untracked-files=normal') !== '',
  renderer: 'project-renderer-1', projectVersion: 3, snapshotVersion: 1,
  frontend: hashTree(resolve(root, 'frontend')),
  engine: hashTree(resolve(root, 'public/wasm')), library: hashTree(resolve(root, 'public/library')),
  contracts: hashTree(resolve(root, 'contracts')), shared: hashTree(resolve(root, 'public/shared')),
  worklet: sha(readFileSync(resolve(root, 'public/build/engine-worklet.js'))),
};
manifest.buildId = sha(JSON.stringify(manifest));
writeFileSync(resolve(root, process.env.BCKGRND_MANIFEST_PATH ?? 'public/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Build ${manifest.buildId}, app ${manifest.appCommit}${manifest.dirty ? ' (working tree)' : ''}`);
