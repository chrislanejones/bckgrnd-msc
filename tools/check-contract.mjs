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

// The schema and both readers name the same version and the same scene keys.
{
  const schema = JSON.parse(readFileSync(join(root, 'contracts/project.schema.json'), 'utf8'));
  const php = execFileSync('php', ['-r', `require '${join(root, 'vendor/autoload.php')}'; echo App\\Support\\Project\\Contract::VERSION;`], { encoding: 'utf8' }).trim();
  const sceneKeys = schema.$defs.scene.required.join(',');
  const fresh = contract.projectFromTrack(library.tracks[0]);
  const ok = schema.properties.version.const === contract.PROJECT_VERSION && String(contract.PROJECT_VERSION) === php
    && sceneKeys === Object.keys(fresh.scenes.slots[0]).join(',');
  console.log(`${ok ? 'ok  ' : 'FAIL'}  schema, UI and PHP agree on project version ${contract.PROJECT_VERSION} and the scene keys (${sceneKeys})`);
  if (!ok) failed += 1;
}

// Saved snapshots (browser IndexedDB, native storage, project files) are read through
// readSnapshot. Every one written before version 4 holds a v3 project: it opens as v4
// with every scene's crash off, and the bytes it came from are left alone.
{
  const bundledSnapshot = await build({
    entryPoints: [join(root, 'frontend/lib/snapshot.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  const snap = await import(
    `data:text/javascript;base64,${Buffer.from(bundledSnapshot.outputFiles[0].text).toString('base64')}`
  );
  const source = async (id) => JSON.parse(readFileSync(join(root, `public/library/${id}.json`), 'utf8')).track;
  const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed += 1;
  };
  const refuses = async (raw, pattern) => {
    try { await snap.readSnapshot(raw, library.tracks, source, () => {}); return 'opened'; }
    catch (e) { return pattern.test(e.message) ? true : e.message; }
  };
  for (const name of ['edited', 'silent']) {
    const path = join(root, `tests/fixtures/release/${name}.bckgrnd.json`);
    const bytes = readFileSync(path, 'utf8');
    const raw = JSON.parse(bytes);
    let opened;
    try { opened = await snap.readSnapshot(raw, library.tracks, source); }
    catch (e) { opened = { error: e.message }; }
    const slots = opened.project?.scenes?.slots ?? [];
    check(`release fixture ${name} (v${raw.project.version}) opens as v${contract.PROJECT_VERSION}, every scene crash off`,
      raw.project.version === 3 && opened.project?.version === contract.PROJECT_VERSION && slots.length === 4 && slots.every((s) => s.crash === false),
      opened.error ?? '');
    check(`release fixture ${name}: same music, same id and revision, file untouched`,
      opened.id === raw.id && opened.revision === raw.revision && contract.sameMusic(opened.project, contract.migrateProject(raw.project, lookup))
        && isDeepStrictEqual(JSON.parse(JSON.stringify(opened.project.patterns)), raw.project.patterns)
        && readFileSync(path, 'utf8') === bytes && raw.project.version === 3);
    // Save → reopen with a crash on: the writer writes v4, and the reader gives it back.
    const withCrash = structuredClone(opened.project);
    withCrash.scenes.slots[3].crash = true;
    const saved = JSON.parse(JSON.stringify(await snap.snapshotOf(withCrash, await source(raw.source.trackId), raw.id, raw.revision + 1)));
    const reopened = await snap.readSnapshot(saved, library.tracks, source);
    check(`${name}: saved with Drop's crash on, reopens with it on and the others off`,
      saved.project.version === contract.PROJECT_VERSION && reopened.project.scenes.slots.map((s) => s.crash).join() === 'false,false,false,true');
    // Strict: a v3 snapshot carrying crash, a v4 one missing it, or a future version is refused.
    const v3Carrying = structuredClone(raw); v3Carrying.project.scenes.slots[0].crash = true;
    check(`${name}: a v3 snapshot carrying crash is refused`, await refuses(v3Carrying, /Scenes are malformed: slot full has keys \["crash"\]/) === true);
    const v4Missing = structuredClone(saved); delete v4Missing.project.scenes.slots[1].crash;
    check(`${name}: a v4 snapshot missing a scene's crash is refused`, await refuses(v4Missing, /lacks \["crash"\]/) === true);
    const future = structuredClone(saved); future.project.version = 5;
    check(`${name}: a version 5 project is refused by name`, await refuses(future, /Project version 5 is newer than this app understands \(4\)/) === true);
    const v2 = structuredClone(raw); v2.project.version = 2;
    check(`${name}: a snapshot can't hold a v2 project (none was ever written)`, await refuses(v2, /Unsupported musical project version/) === true);
    // A stored v3 revision and its v4 reading are the same saved revision, so opening
    // it isn't an edit and nothing writes over the user's copy until they save.
    check(`${name}: the stored v3 revision reads as the opened one`,
      snap.canonical(snap.asCurrentVersion(raw.project)) === snap.canonical(opened.project));
  }
  // Bare v1, v2 and v3 project files open as v4 with crash off too (the fixtures above
  // pin the whole document; this says it in one line).
  for (const name of ['v1-sparse', 'v2-captured', 'v3-patterns']) {
    const p = contract.migrateProject(JSON.parse(readFileSync(join(fixtures, `${name}.input.json`), 'utf8')), lookup);
    check(`${name} opens as v${p.version} with every scene's crash off`, p.version === contract.PROJECT_VERSION && p.scenes.slots.every((s) => s.crash === false));
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
