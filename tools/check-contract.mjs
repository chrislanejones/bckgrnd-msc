/**
 * Run the UI's project reader against the shared contract fixtures.
 *
 * `tests/Unit/ContractTest.php` runs PHP's `Contract::migrate()` over
 * tests/fixtures/contract; this runs `migrateProject()` from frontend/lib/contract.ts
 * over the same files. Both must produce the same expected output, so the browser and
 * Laravel can never disagree about what a saved project means.
 *
 * Usage: node tools/check-contract.mjs
 */

import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests/fixtures/contract');

// Bundle the TypeScript module in memory and import it as a data: URL.
const bundled = await build({
  entryPoints: [join(root, 'frontend/lib/contract.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const library = JSON.parse(readFileSync(join(root, 'public/library/index.json'), 'utf8'));
const lookup = (id) => library.tracks.find((t) => t.id === id);

let failed = 0;
for (const file of readdirSync(fixtures).filter((f) => f.endsWith('.input.json')).sort()) {
  const name = file.replace('.input.json', '');
  const input = JSON.parse(readFileSync(join(fixtures, file), 'utf8'));
  const expected = JSON.parse(readFileSync(join(fixtures, `${name}.expected.json`), 'utf8'));
  let actual;
  try {
    actual = contract.migrateProject(input, lookup);
  } catch (error) {
    actual = { error: error.message };
  }
  // Compare as JSON, the way the files are compared on the PHP side.
  const ok = isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) {
    failed += 1;
    console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`);
  }
}

// The fresh project for every track must round-trip unchanged.
for (const summary of library.tracks) {
  const fresh = contract.projectFromTrack(summary);
  const again = contract.migrateProject(JSON.parse(JSON.stringify(fresh)), lookup);
  if (!contract.sameMusic(fresh, again)) {
    failed += 1;
    console.log(`FAIL  fresh project for ${summary.id} does not round-trip`);
  }
}

if (failed) {
  console.error(`\n${failed} contract check(s) failed.`);
  process.exit(1);
}
console.log('\nThe UI reads every contract fixture the same way PHP does.');
