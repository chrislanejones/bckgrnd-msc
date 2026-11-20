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

// Timed builds (Night 7): kinds 41-47 drive the same request, through a building state.
const breq = { ...req, requestId: 20, build: { bars: 4 } };
const bq = s.foldSceneEvent(breq, { kind: s.EVENT.buildQueued, id: 20, a: 5, b: 64 });
check('a build queued carries its start bar', bq.status === 'queued' && bq.bar === 5 && s.isPending(bq));
check('scene kinds do not move a build', s.foldSceneEvent(bq, { kind: s.EVENT.sceneApplied, id: 20, a: 0, b: 0 }) === bq);
const bs = s.foldSceneEvent(bq, { kind: s.EVENT.buildStarted, id: 20, a: 64, b: 4 });
check('started is bar 1 of n and still pending', bs.status === 'building' && bs.build.bar === 1 && s.isPending(bs));
const bp = s.foldSceneEvent(bs, { kind: s.EVENT.buildProgress, id: 20, a: 3, b: 4 });
check('progress carries the bar now playing', bp.status === 'building' && bp.build.bar === 3 && bp.build.bars === 4);
check('a late queued cannot rewind a running build', s.foldSceneEvent(bp, { kind: s.EVENT.buildQueued, id: 20, a: 9, b: 0 }) === bp);
const ba = s.foldSceneEvent(bp, { kind: s.EVENT.buildApplied, id: 20, a: 128, b: 0 });
check('applied settles the build', ba.status === 'applied' && !s.isPending(ba));
check('nothing moves a build after applied', s.foldSceneEvent(ba, { kind: s.EVENT.buildCancelled, id: 20, a: 2, b: 0 }) === ba);
const bc = s.foldSceneEvent(bp, { kind: s.EVENT.buildCancelled, id: 20, a: 10, b: 0 });
check('cancelled settles with its reason', bc.status === 'cancelled' && bc.reason === 10 && !s.isPending(bc));
const br = s.foldSceneEvent(bq, { kind: s.EVENT.buildRejected, id: 20, a: 7, b: 0 });
check('rejected settles with its reason', br.status === 'rejected' && br.reason === 7);
check('build kinds count as launch events', [41, 42, 43, 44, 45, 46, 47].every(s.isLaunchEvent) && !s.isLaunchEvent(11) && !s.isLaunchEvent(31));
// Rise coverage (Night 8): every bar count, every way a rise can end, and nothing
// stale after it. The browser half is tools/verify-ui-rise.mjs.
for (const n of s.BUILD_BAR_CHOICES) {
  let r = { ...req, requestId: 30 + n, build: { bars: n } };
  const id = r.requestId;
  r = s.foldSceneEvent(r, { kind: s.EVENT.buildQueued, id, a: 3, b: 32 });
  r = s.foldSceneEvent(r, { kind: s.EVENT.buildStarted, id, a: 32, b: n });
  const seen = [r.build.bar];
  for (let bar = 2; bar <= n; bar += 1) {
    r = s.foldSceneEvent(r, { kind: s.EVENT.buildProgress, id, a: bar, b: n });
    seen.push(r.build.bar);
  }
  const counted = seen.join(',') === Array.from({ length: n }, (_, k) => k + 1).join(',');
  check(`a ${n}-bar build counts bar 1 to ${n} and stays pending`, counted && r.status === 'building' && r.build.bars === n && s.isPending(r), seen.join(','));
  const end = s.foldSceneEvent(r, { kind: s.EVENT.buildApplied, id, a: 32 + 16 * n, b: 0 });
  check(`a ${n}-bar build ends applied on bar ${n} of ${n}`, end.status === 'applied' && end.build.bar === n && !s.isPending(end));
}
const waiting = s.foldSceneEvent({ ...req, requestId: 40, build: { bars: 4 } }, { kind: s.EVENT.buildQueued, id: 40, a: 5, b: 64 });
const reannounced = s.foldSceneEvent(waiting, { kind: s.EVENT.buildQueued, id: 40, a: 4, b: 48 });
check('a loop change re-announcing a waiting build moves its bar', reannounced.status === 'queued' && reannounced.bar === 4, `bar ${reannounced.bar}`);
const running = s.foldSceneEvent(waiting, { kind: s.EVENT.buildStarted, id: 40, a: 64, b: 4 });
for (const [why, reason] of [['Stop', 2], ['a seek', 3], ['a track load', 4], ['Panic', 5], ['the user', 10]]) {
  const ended = s.foldSceneEvent(running, { kind: s.EVENT.buildCancelled, id: 40, a: reason, b: 0 });
  const late = s.foldSceneEvent(ended, { kind: s.EVENT.buildProgress, id: 40, a: 3, b: 4 });
  check(`a running build cancelled by ${why} settles with reason ${reason}, and later progress is ignored`,
    ended.status === 'cancelled' && ended.reason === reason && !s.isPending(ended) && late === ended);
}
const swapped = s.foldSceneEvent(running, { kind: s.EVENT.buildReplaced, id: 40, a: 41, b: 0 });
check('a running build replaced settles, and a late applied cannot revive it',
  swapped.status === 'replaced' && s.foldSceneEvent(swapped, { kind: s.EVENT.buildApplied, id: 40, a: 128, b: 1 }) === swapped);
check("another build's progress does not move this one", s.foldSceneEvent(running, { kind: s.EVENT.buildProgress, id: 41, a: 3, b: 4 }) === running);
check('the status words for a stopped, moved, reloaded and panicked rise',
  s.REASON[2] === 'playback stopped' && s.REASON[3] === 'the playhead moved' && s.REASON[4] === 'the track changed' && s.REASON[5] === 'panic');
check('a refused rise says to press Play, or not while scratching',
  s.BUILD_REFUSAL[7] === 'press Play first' && s.BUILD_REFUSAL[3] === 'not while the deck is scratched or braking');

// Fills and Fill into (Night 8): kinds 11-15, 51 and 52 fold into a fill request.
check('fill linked and unlinked are 51 and 52, not launch events',
  s.EVENT.fillLinked === 51 && s.EVENT.fillUnlinked === 52 && !s.isLaunchEvent(51) && !s.isLaunchEvent(52));
const fq = { requestId: 60, status: 'sending' };
const fill1 = s.foldFillEvent(fq, { kind: s.EVENT.fillQueued, id: 60, a: 4, b: 48 });
check('a phrase fill queued carries the bar it plays', fill1.status === 'queued' && fill1.bar === 4 && s.isFillPending(fill1));
const linked = s.foldFillEvent(fill1, { kind: s.EVENT.fillLinked, id: 60, a: 61, b: 64 });
check('fill linked names the scene and the landing step', linked.linkedTo === 61 && linked.landing === 64 && linked.status === 'queued');
const moved = s.foldFillEvent(linked, { kind: s.EVENT.fillQueued, id: 60, a: 1, b: 0 });
check('a loop change re-announcing a linked fill moves its bar and keeps the link', moved.bar === 1 && moved.linkedTo === 61);
const fplay = s.foldFillEvent(linked, { kind: s.EVENT.fillStarted, id: 60, a: 48, b: 0 });
check('started is playing and still linked', fplay.status === 'playing' && fplay.linkedTo === 61 && s.isFillPending(fplay));
check('a late queued cannot rewind a playing fill', s.foldFillEvent(fplay, { kind: s.EVENT.fillQueued, id: 60, a: 8, b: 112 }) === fplay);
const unlinked = s.foldFillEvent(fplay, { kind: s.EVENT.fillUnlinked, id: 60, a: 10, b: 0 });
check('unlinked drops the partner and keeps playing', unlinked.status === 'playing' && unlinked.linkedTo === undefined && unlinked.landing === undefined);
const fend = s.foldFillEvent(fplay, { kind: s.EVENT.fillEnded, id: 60, a: 64, b: 0 });
check('ended on its line settles it', fend.status === 'ended' && !s.isFillPending(fend) && fend.reason === undefined);
check('nothing moves a fill after it ended', s.foldFillEvent(fend, { kind: s.EVENT.fillLinked, id: 60, a: 9, b: 0 }) === fend);
const cut = s.foldFillEvent(fplay, { kind: s.EVENT.fillEnded, id: 60, a: -1, b: 2 });
check('cut short by Stop settles with the reason', cut.status === 'ended' && cut.reason === 2);
const frej = s.foldFillEvent(fq, { kind: s.EVENT.fillRejected, id: 60, a: 8, b: 2 });
check('a refused Fill into keeps the reason and the part', frej.status === 'rejected' && frej.reason === 8 && frej.part === 2);
const fcan = s.foldFillEvent(linked, { kind: s.EVENT.fillCancelled, id: 60, a: 10, b: 0 });
check('cancelled settles with its reason', fcan.status === 'cancelled' && fcan.reason === 10 && !s.isFillPending(fcan));
check("another fill's events do not move this one", s.foldFillEvent(linked, { kind: s.EVENT.fillStarted, id: 61, a: 0, b: 0 }) === linked);
// The Fill into's scene is a launch like any other: queued with the landing bar, then applied.
const into = s.foldSceneEvent({ ...req, requestId: 61 }, { kind: s.EVENT.sceneQueued, id: 61, a: 5, b: 64 });
check("a Fill into's scene queues with its landing bar", into.status === 'queued' && into.bar === 5);
check("a Fill into's scene refused settles with the reason", s.foldSceneEvent(into, { kind: s.EVENT.sceneRejected, id: 61, a: 8, b: 2 }).status === 'rejected');

const vec = s.sceneVector(applied);
const back = s.mixFromVector(vec);
check('mixFromVector inverts sceneVector', s.sameMix(s.copyMix(back), applied) && s.sceneVector(back).every((v, i) => v === vec[i]));

if (failed) {
  console.error(`\n${failed} scene check(s) failed.`);
  process.exit(1);
}
console.log('\nScene capture, vector layout and request handling hold.');
