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
import { execFileSync } from 'node:child_process';
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
  if (!contract.sameMusic(fresh, again) || !isDeepStrictEqual(fresh.scenes, again.scenes)) {
    failed += 1;
    console.log(`FAIL  fresh project for ${summary.id} does not round-trip`);
  }
}

// The factory patterns and source hashes: PHP's against the UI's, for every lane of
// every track (the UI builds them from the exported library JSON).
{
  const bundledPatterns = await build({
    entryPoints: [join(root, 'frontend/lib/patterns.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  const patterns = await import(
    `data:text/javascript;base64,${Buffer.from(bundledPatterns.outputFiles[0].text).toString('base64')}`
  );
  const reference = JSON.parse(execFileSync('php', [join(root, 'tools/patterns-reference.php')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  let mismatches = 0;
  for (const summary of library.tracks) {
    const { track } = JSON.parse(readFileSync(join(root, `public/library/${summary.id}.json`), 'utf8'));
    for (const lane of patterns.LANE_IDS) {
      const mine = patterns.factoryPattern(track, lane);
      const theirs = reference[summary.id][lane];
      if (!isDeepStrictEqual(JSON.parse(JSON.stringify(mine)), theirs.pattern)) {
        mismatches += 1;
        if (mismatches <= 3) console.log(`FAIL  factory ${summary.id} ${lane} differs between PHP and the UI`);
      }
      for (let part = 0; part < 4; part += 1) {
        const h = patterns.sourceHash(mine, part * 64, part * 64 + 63);
        if (h !== theirs.hashes[part]) {
          mismatches += 1;
          if (mismatches <= 3) console.log(`FAIL  hash ${summary.id} ${lane} part ${part}: ${h} vs ${theirs.hashes[part]}`);
        }
      }
    }
  }
  if (mismatches) failed += mismatches;
  else console.log(`ok    factory patterns and source hashes agree for ${library.tracks.length} tracks x ${patterns.LANE_IDS.length} lanes`);
}

if (failed) {
  console.error(`\n${failed} contract check(s) failed.`);
  process.exit(1);
}
console.log('\nThe UI reads every contract fixture the same way PHP does.');
