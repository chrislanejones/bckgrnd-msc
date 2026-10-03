/**
 * Bundle the AudioWorklet processor.
 *
 * The worklet runs on the audio rendering thread, where there is no DOM and no
 * `fetch`. Two consequences shape this build:
 *
 * 1. It is bundled as a self-contained IIFE rather than an ES module, so loading
 *    it is one `audioWorklet.addModule()` call with no import resolution at runtime.
 * 2. The wasm-bindgen glue is bundled in, but the `.wasm` binary is **not** — the
 *    worklet fetches it from the main thread, which does have `fetch`. The bytes
 *    arrive by `postMessage` and are handed to `initSync()`.
 *
 * Vite handles the app bundle; this file exists because the worklet's output format
 * and its "no fetch" constraint are different enough from a normal browser bundle
 * that sharing a config would only obscure them.
 */
import { build, context } from 'esbuild';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(root, 'public/build/engine-worklet.js');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(root, 'frontend/worklets/engine-processor.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'safari16', 'firefox115'],
  sourcemap: process.env.NODE_ENV !== 'production',
  minify: process.env.NODE_ENV === 'production',
  logLevel: 'info',
  // The wasm-bindgen glue references `import.meta.url` in its async-init path,
  // which we never call. Define it away so the IIFE build does not warn.
  define: { 'import.meta.url': '""' },
  // Prepended outside the IIFE so it runs before any bundled code. Without this the
  // module throws at evaluation time on `new TextEncoder()`, and the worklet fails
  // to register with a misleading "node name not defined" error.
  banner: {
    js: readFileSync(resolve(root, 'frontend/worklets/worklet-globals.js'), 'utf8'),
  },
};

mkdirSync(dirname(outfile), { recursive: true });

// Mirror the `@wasm` alias from vite.config.ts, so both bundles resolve the
// wasm-bindgen glue to the same place.
options.alias = {
  '@wasm': resolve(root, 'public/wasm/floor_engine.js'),
};

/**
 * Fail the build if the worklet calls an engine method that is not exported.
 *
 * This exists because of a bug worth not repeating. The processor called
 * `engine.play()`, but `play` was a plain Rust method rather than one annotated for
 * `wasm_bindgen`, so it was never present on the JS object — and because the missing
 * method only surfaced inside the worklet, where the page cannot see the error, the
 * symptom was silence rather than a stack trace. Checking the generated `.d.ts`
 * turns a silent runtime failure into a build failure.
 */
function assertEngineApiComplete() {
  const dtsPath = resolve(root, 'public/wasm/floor_engine.d.ts');
  if (!existsSync(dtsPath)) {
    console.warn(
      '[worklet] skipping API check: public/wasm/floor_engine.d.ts not found. ' +
        'Run `wasm-pack build --target web --release --out-dir ../public/wasm` first.',
    );
    return;
  }

  const dts = readFileSync(dtsPath, 'utf8');
  const processor = readFileSync(
    resolve(root, 'frontend/worklets/engine-processor.ts'),
    'utf8',
  );

  // Every `engine.<method>(` call site in the processor.
  const called = [...processor.matchAll(/\bengine\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(
    (m) => m[1],
  );
  const missing = [...new Set(called)].filter(
    (name) => !new RegExp(`^\\s*${name}\\s*[(:]`, 'm').test(dts),
  );

  if (missing.length) {
    console.error(
      `[worklet] the processor calls engine methods that are not exported to JS: ${missing.join(', ')}\n` +
        '          Annotate them with #[cfg_attr(target_arch = "wasm32", wasm_bindgen)] in engine-core/src/lib.rs.',
    );
    process.exit(1);
  }
  console.log(`[worklet] engine API check passed (${new Set(called).size} methods)`);
}

assertEngineApiComplete();

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[worklet] watching for changes');
} else {
  await build(options);
  console.log(`[worklet] built ${outfile}`);
}