/**
 * The take validator for the tools: frontend/lib/take-schema.ts, the same copy the app's
 * `openTake` uses, bundled here so the checks and the browser hold a take to one
 * contract (contracts/performance.json).
 *
 *   const valid = performanceValidator(schema); valid(doc) // [] when it validates
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  entryPoints: [join(root, 'frontend/lib/take-schema.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const lib = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

/** contracts/performance.json, parsed. */
export function performanceSchema() {
  return JSON.parse(readFileSync(join(root, 'contracts/performance.json'), 'utf8'));
}

/** A function from a document to its list of errors (empty: it validates). */
export function performanceValidator(schema = performanceSchema()) {
  return lib.schemaValidator(schema);
}
