import { build } from 'vite';
import { resolve } from 'node:path';
process.env.BCKGRND_MANIFEST_PATH = resolve(import.meta.dirname, '../dist/build-manifest.json');
await import('./build-shared.mjs');
await import('./build-manifest.mjs');
process.env.VITE_STATIC = '1';
await build({ mode: 'static', build: { outDir: resolve(import.meta.dirname, '../dist/build'), emptyOutDir: false } });
