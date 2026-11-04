/**
 * The UI's scene logic (frontend/lib/scenes.ts), checked without a browser.
 *
 * Holds the rules that are easy to break quietly: the vector order the engine reads,
 * that capture and duplicate copy rather than share, that a revision moves on every
 * overwrite, and that a settled request can never be revived by a late event.
 *
 * Usage: node tools/check-scenes.mjs
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  entryPoints: [join(root, 'frontend/lib/scenes.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const s = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const contract = JSON.parse(readFileSync(join(root, 'contracts/scenes.json'), 'utf8'));
const library = JSON.parse(readFileSync(join(root, 'public/library/index.json'), 'utf8'));
const track = library.tracks.find((t) => t.id === 'warehouse');

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const factory = (slot) => {
  const scenes = s.factoryScenes(track);
  return slot ? scenes.slots.find((x) => x.slot === slot) : scenes;
};
const scenes = factory();

// Vector layout.
check('the vector is 44 values long', s.SCENE_VECTOR_LENGTH === 44, String(s.SCENE_VECTOR_LENGTH));
const sparse = factory('sparse');
const v = s.sceneVector(sparse);
check('stem i sits at 4i: kick muted in sparse', v[2] === 1 && v[0] === Math.fround(sparse.stems.kick.volume));
check('hats at index 8 play in sparse', v[8] === Math.fround(sparse.stems.hats.volume) && v[10] === 0);
contract.sceneVector.forEach((id, j) => {
  if (v[32 + j] !== Math.fround(sparse.params[id])) {
    check(`vector index ${32 + j} is ${id}`, false, `${v[32 + j]} vs ${sparse.params[id]}`);
  }
});
check('indices 32..43 follow sceneVector', contract.sceneVector.every((id, j) => v[32 + j] === Math.fround(sparse.params[id])));

// Capture copies, and moves the revision.
const working = s.copyMix(factory('full'));
working.params['fx.filter'] = 0.3;
working.stems.bass.muted = true;
const captured = s.captureScene(scenes, 'build', working);
const build_ = captured.slots.find((x) => x.slot === 'build');
check('capture writes the working mix into the slot', build_.params['fx.filter'] === 0.3 && build_.stems.bass.muted);
check('capture moves the revision on', build_.revision === factory('build').revision + 1, `${build_.revision}`);
check('capture keeps the name and recipe', build_.name === 'Build' && build_.factory === 'build');
working.params['fx.filter'] = 0.9;
check('a later knob move does not reach the captured scene', build_.params['fx.filter'] === 0.3);
check('capture leaves the other slots alone', captured.slots.filter((x) => x.slot !== 'build').every((x, i) => x === scenes.slots.filter((y) => y.slot !== 'build')[i]));

// Rename, duplicate, reset.
check('a blank name is refused', s.renameScene(scenes, 'full', '   ') === null);
check('a 41-character name is refused', s.renameScene(scenes, 'full', 'x'.repeat(41)) === null);
const renamed = s.renameScene(scenes, 'drop', '  Big drop ');
check('rename trims and bumps the revision', renamed.slots[3].name === 'Big drop' && renamed.slots[3].revision === scenes.slots[3].revision + 1);
const dup = s.duplicateScene(captured, 'build', 'drop');
const dupDrop = dup.slots.find((x) => x.slot === 'drop');
check('duplicate copies the mix and name into the target slot', dupDrop.params['fx.filter'] === 0.3 && dupDrop.name === 'Build' && dupDrop.slot === 'drop');
check('duplicate keeps the target slot recipe for Reset', dupDrop.factory === 'drop');
dupDrop.stems.kick.volume = 0.123;
check('duplicate does not share the stems object', dup.slots.find((x) => x.slot === 'build').stems.kick.volume !== 0.123);
const reset = s.resetScene(dup, 'drop', track);
const resetDrop = reset.slots.find((x) => x.slot === 'drop');
check('reset restores the factory recipe', s.sameMix(resetDrop, factory('drop')) && resetDrop.name === 'Drop');
check('reset still moves the revision on', resetDrop.revision === dupDrop.revision + 1);

// Modified detection.
const applied = s.copyMix(factory('full'));
const edited = s.copyMix(applied);
check('an unchanged mix is not modified', s.sameMix(applied, edited));
edited.stems.lead.volume += 0.01;
check('a fader move is a modification', !s.sameMix(applied, edited));

// Requests.
const req = { requestId: 7, target: 'drop', revision: 1, generation: 1, timing: 'bar', status: 'sending', mix: applied };
const queued = s.foldSceneEvent(req, { kind: s.EVENT.sceneQueued, id: 7, a: 9, b: 128 });
check('queued carries the predicted bar', queued.status === 'queued' && queued.bar === 9);
check('another request id is ignored', s.foldSceneEvent(queued, { kind: s.EVENT.sceneApplied, id: 8, a: 0, b: 0 }) === queued);
const done = s.foldSceneEvent(queued, { kind: s.EVENT.sceneApplied, id: 7, a: 128, b: 0 });
check('applied settles the request', done.status === 'applied' && !s.isPending(done));
check('a late cancel cannot undo an applied request', s.foldSceneEvent(done, { kind: s.EVENT.sceneCancelled, id: 7, a: 10, b: 0 }).status === 'applied');
const replaced = s.foldSceneEvent(queued, { kind: s.EVENT.sceneReplaced, id: 7, a: 8, b: 0 });
check('replaced settles the request', replaced.status === 'replaced' && !s.isPending(replaced));
check('the flat event list splits into fours', s.readEvents([1, 7, 9, 128, 2, 7, 128, 0]).length === 2);

if (failed) {
  console.error(`\n${failed} scene check(s) failed.`);
  process.exit(1);
}
console.log('\nScene capture, vector layout and request handling hold.');
