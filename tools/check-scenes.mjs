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
// The host's fill logic (frontend/lib/fills.ts), bundled on its own: it imports scenes.ts.
const fillsBundle = await build({
  entryPoints: [join(root, 'frontend/lib/fills.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const fl = await import(`data:text/javascript;base64,${Buffer.from(fillsBundle.outputFiles[0].text).toString('base64')}`);
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
// Rise + Fill: the fill links to the build, and goes with it when the build is replaced.
const rfill = s.foldFillEvent(s.foldFillEvent({ requestId: 70, status: 'sending' },
  { kind: s.EVENT.fillQueued, id: 70, a: 3, b: 32 }), { kind: s.EVENT.fillLinked, id: 70, a: 71, b: 48 });
check("a Rise's fill links to the build and its landing", rfill.linkedTo === 71 && rfill.landing === 48 && rfill.bar === 3);
const gone = s.foldFillEvent(rfill, { kind: s.EVENT.fillCancelled, id: 70, a: 11, b: 0 });
check("a replaced Rise's fill settles with reason 11, in words", gone.status === 'cancelled' && gone.reason === 11 && s.REASON[11] === 'its Rise was replaced');
// Crash accents (Night 8): 53 reports on the scene's id, and moves no request.
check('accent fired is 53 and not a launch event', s.EVENT.accentFired === 53 && !s.isLaunchEvent(53));
check('an accent fired leaves the scene request where it was',
  s.foldSceneEvent(queued, { kind: s.EVENT.accentFired, id: 7, a: 128, b: 1 }) === queued);
// The Fill into's scene is a launch like any other: queued with the landing bar, then applied.
const into = s.foldSceneEvent({ ...req, requestId: 61 }, { kind: s.EVENT.sceneQueued, id: 61, a: 5, b: 64 });
check("a Fill into's scene queues with its landing bar", into.status === 'queued' && into.bar === 5);
check("a Fill into's scene refused settles with the reason", s.foldSceneEvent(into, { kind: s.EVENT.sceneRejected, id: 61, a: 8, b: 2 }).status === 'rejected');

// ---- The host's fill folding (frontend/lib/fills.ts, Night 8) -------------------
check('fill events are 11-15, 51 and 52, and nothing else',
  [11, 12, 13, 14, 15, 51, 52].every(s.isFillEvent) && ![1, 5, 10, 16, 21, 41, 50, 53].some(s.isFillEvent));
check('Fill at sends 0 for Next bar, and the phrase length for Phrase end',
  fl.fillPhrase('bar', 8) === 0 && [2, 4, 8, 16].every((n) => fl.fillPhrase('phrase', n) === n)
  && JSON.stringify(fl.PHRASE_BAR_CHOICES) === '[2,4,8,16]' && fl.DEFAULT_PHRASE_BARS === 4 && fl.FILL_INDEX === 0);
// Late presses: the first step lies in a later phrase, or behind the playhead (a loop).
check('a next-bar fill never rolls over', !fl.rolledOver(250, 0, 0) && !fl.rolledOver(47, 48, 0));
check('4 bars: pressed in bar 1 or bar 3, it plays bar 4 of this phrase', !fl.rolledOver(0, 48, 4) && !fl.rolledOver(40, 48, 4) && !fl.rolledOver(47, 48, 4));
check('4 bars: pressed in bar 4 (or on its line), it rolls to the next phrase', fl.rolledOver(48, 112, 4) && fl.rolledOver(50, 112, 4) && fl.rolledOver(63, 112, 4));
check("4 bars: pressed in the song's last bar, it rolls round to bar 4", fl.rolledOver(250, 48, 4));
check('2, 8 and 16 bars: in time for this phrase, and late', !fl.rolledOver(0, 16, 2) && fl.rolledOver(20, 48, 2)
  && !fl.rolledOver(100, 112, 8) && fl.rolledOver(115, 240, 8) && !fl.rolledOver(200, 240, 16) && fl.rolledOver(241, 240, 16));
check("a 2-bar loop's last bar: ahead of it plays this pass, inside it the next",
  !fl.rolledOver(70, 80, 4) && fl.rolledOver(85, 80, 4) && fl.rolledOver(80, 80, 4));
check('stopped (no step) is never late', !fl.rolledOver(-1, 48, 4));

const job = (over = {}) => ({ requestId: 80, status: 'sending', kind: 'plain', phrase: 4, from: 10, ...over });
const ev = (kind, a = 0, b = 0, id = 80) => ({ kind, id, a, b });
// Next bar: exactly the Night 3 words.
const nb = fl.foldFillJob(job({ phrase: 0 }), ev(s.EVENT.fillQueued, 9, 128), 120);
check('Next bar: "Fill · Bar 9", "Fill queued for bar 9", and the Night 3 names',
  !nb.late && fl.fillButtonLabel(nb) === 'Fill · Bar 9' && fl.fillQueuedStatus(nb) === 'Fill queued for bar 9'
  && fl.fillButtonAria(nb, 'Fill', 0) === 'Cancel the queued Fill' && fl.fillButtonAria(null, 'Fill', 0) === 'Fill for one bar, from the next bar'
  && fl.fillButtonLabel(null) === 'Drum fill' && fl.fillButtonTitle('Fill', 0) === 'Fill: one bar, from the next bar',
  `${fl.fillButtonLabel(nb)} | ${fl.fillQueuedStatus(nb)}`);
const onTime = fl.foldFillJob(job(), ev(s.EVENT.fillQueued, 4, 48), 30);
check('Phrase end in time: "Fill · Bar 4", "the end of the phrase"',
  onTime.status === 'queued' && onTime.bar === 4 && !onTime.late && onTime.from === 10
  && fl.fillButtonLabel(onTime) === 'Fill · Bar 4' && fl.fillQueuedStatus(onTime) === 'Fill queued for bar 4, the end of the phrase'
  && fl.fillButtonAria(onTime, 'Fill', 4) === 'Cancel the queued Fill, at the end of bar 4', fl.fillQueuedStatus(onTime));
const late = fl.foldFillJob(job({ from: 52 }), ev(s.EVENT.fillQueued, 8, 112), 53);
check('Phrase end, late: "Fill · Next phrase", and the status names the bar',
  late.late && fl.fillButtonLabel(late) === 'Fill · Next phrase'
  && fl.fillQueuedStatus(late) === 'Fill queued for bar 8, the end of the next phrase'
  && fl.fillButtonAria(late, 'Fill', 4) === 'Cancel the queued Fill, at the end of the next phrase, bar 8', fl.fillButtonLabel(late));
const again = fl.foldFillJob(onTime, ev(s.EVENT.fillQueued, 2, 16), 12);
check('a re-announce (loop change) is measured from where the playhead is then', again.bar === 2 && again.from === 12 && !again.late);
const againLate = fl.foldFillJob(onTime, ev(s.EVENT.fillQueued, 2, 16), 22);
check('and a re-announce behind the playhead is the next pass', againLate.late === true);
check('an idle Phrase end Fill names the phrase', fl.fillButtonAria(null, 'Fill', 8) === 'Fill for one bar, ending on the next 8-bar phrase line'
  && fl.fillButtonTitle('Fill', 8) === 'Fill: one bar, ending on the 8-bar phrase line');
const playingPlain = fl.foldFillJob(onTime, ev(s.EVENT.fillStarted, 48), 48);
check('a playing fill reads "Fill playing"', fl.fillButtonLabel(playingPlain) === 'Fill playing' && fl.fillButtonAria(playingPlain, 'Fill', 4) === 'Fill is playing');
check('a settled fill reads "Drum fill" again',
  fl.fillButtonLabel(fl.foldFillJob(playingPlain, ev(s.EVENT.fillEnded, 64), 64)) === 'Drum fill');
check('the same object back for an event that changes nothing', fl.foldFillJob(onTime, ev(s.EVENT.fillStarted, 0, 0, 99), 0) === onTime);

// Fill → Drop: the fill half of a Fill into.
const intoQ = fl.foldFillJob(fl.foldFillJob(job({ kind: 'into', partner: 81, from: 70 }), ev(s.EVENT.fillQueued, 8, 112), 70), ev(s.EVENT.fillLinked, 81, 128), 70);
check('Fill → Drop queued: "Fill · Bar 8 → Drop", linked to its scene, and not the Fill button\'s',
  fl.fillIntoLabel(intoQ, 'Drop') === 'Fill · Bar 8 → Drop' && intoQ.linkedTo === 81 && intoQ.landing === 128
  && fl.fillButtonLabel(intoQ) === 'Drum fill' && fl.fillButtonJob(intoQ) === null && fl.fillIntoJob(intoQ) === intoQ,
  fl.fillIntoLabel(intoQ, 'Drop'));
check('Fill → Drop names: idle, queued, late, sending',
  fl.fillIntoAria(null, 'Drop', 4) === 'Fill into Drop at the end of the 4-bar phrase'
  && fl.fillIntoAria(null, 'Drop', 0) === 'Fill into Drop: a fill on the next bar, then Drop'
  && fl.fillIntoAria(intoQ, 'Drop', 4) === 'Fill into Drop at the end of bar 8. Press again to cancel.'
  && fl.fillIntoAria(job({ kind: 'into' }), 'Drop', 4) === 'Fill into Drop, being queued. Press again to cancel.'
  && fl.fillIntoLabel(job({ kind: 'into' }), 'Drop') === 'Fill → Drop…' && fl.fillIntoLabel(null, 'Peak') === 'Fill → Peak');
const intoLate = fl.foldFillJob(job({ kind: 'into', from: 60 }), ev(s.EVENT.fillQueued, 8, 112), 60);
check('Fill → Drop, late: "Fill · Next phrase → Drop"', fl.fillIntoLabel(intoLate, 'Drop') === 'Fill · Next phrase → Drop'
  && fl.fillIntoAria(intoLate, 'Drop', 4) === 'Fill into Drop at the end of the next phrase, bar 8. Press again to cancel.');
const intoP = fl.foldFillJob(intoQ, ev(s.EVENT.fillStarted, 112), 112);
check('Fill → Drop filling: "Filling → Drop", and the Fill button shows the fill playing',
  fl.fillIntoLabel(intoP, 'Drop') === 'Filling → Drop' && fl.fillButtonLabel(intoP) === 'Fill playing'
  && fl.fillIntoAria(intoP, 'Drop', 4) === 'Filling into Drop. Press again to cancel Drop; the fill plays out its bar.');
const intoU = fl.foldFillJob(intoQ, ev(s.EVENT.fillUnlinked, 10), 80);
check('unlinked (another scene launched), it is a plain fill with its bar: the Fill button shows it',
  intoU.kind === 'plain' && intoU.partner === undefined && intoU.linkedTo === undefined && intoU.status === 'queued'
  && fl.fillButtonLabel(intoU) === 'Fill · Bar 8' && fl.fillIntoLabel(intoU, 'Drop') === 'Fill → Drop');
// Rise + Fill: a replaced Rise's playing fill unlinks with 11 and plays on as a plain fill.
const riseP = fl.foldFillJob(fl.foldFillJob(job({ kind: 'rise', phrase: 0, partner: 90 }), ev(s.EVENT.fillQueued, 6, 80), 20), ev(s.EVENT.fillStarted, 80), 80);
check("a Rise's fill never reads as late, and plays as \"Fill playing\"", !riseP.late && fl.fillButtonLabel(riseP) === 'Fill playing' && fl.fillIntoJob(riseP) === null);
const riseU = fl.foldFillJob(riseP, ev(s.EVENT.fillUnlinked, 11), 82);
check("a replaced Rise's playing fill plays on, plain", riseU.kind === 'plain' && riseU.status === 'playing');

// The request a fill leads into is marked filling once it starts.
const intoReq = { ...req, requestId: 81, fillInto: { fillId: 80 } };
const marked = fl.markFilling(intoReq, 80);
check("a Fill into's scene is marked filling by its own fill only",
  marked.fillInto.filling === true && marked.status === intoReq.status && fl.markFilling(intoReq, 79) === intoReq && fl.markFilling(marked, 80) === marked);
const riseReq = { ...req, requestId: 90, status: 'building', build: { bars: 4, bar: 4, fill: { fillId: 80 } } };
const riseMarked = fl.markFilling(riseReq, 80);
check("a Rise is marked filling by its fill, keeping its bars", riseMarked.build.fill.filling === true && riseMarked.build.bar === 4 && riseMarked.build.bars === 4);
check('a build fold keeps the fill it waits on', s.foldSceneEvent(riseMarked, { kind: s.EVENT.buildApplied, id: 90, a: 128, b: 1 }).build.fill.filling === true);
check('a scene fold keeps the Fill into tie', s.foldSceneEvent(intoReq, { kind: s.EVENT.sceneQueued, id: 81, a: 9, b: 128 }).fillInto.fillId === 80);
check('pad lines: "Fill in · Bar 9", "Filling into Drop"', fl.fillInLine(9) === 'Fill in · Bar 9' && fl.fillInLine(undefined) === 'Fill in…' && fl.fillingLine('Drop') === 'Filling into Drop');

// Refusals, naming the part at fault (events 15, 5 and 45).
check('a plain fill refused says what to do', fl.fillRefusal(7) === 'press Play first' && fl.fillRefusal(8) === 'a fill is already queued or playing'
  && fl.fillRefusal(3) === 'not while the deck is scratched or braking' && fl.fillRefusal(6) === 'not during a mix' && fl.fillRefusal(1) === "this track's fill isn't available");
check('a Fill into refused names the part: scene, fill, lanes, or the whole request',
  fl.fillIntoRefusal(1, 1, 'Drop') === "Drop isn't a valid mix" && fl.fillIntoRefusal(8, 2, 'Drop') === 'a fill is already queued or playing'
  && fl.fillIntoRefusal(1, 2, 'Drop') === "this track's fill isn't available" && fl.fillIntoRefusal(1, 3, 'Drop') === "Drop's patterns were refused"
  && fl.fillIntoRefusal(7, 0, 'Drop') === 'press Play first' && fl.fillIntoRefusal(9, 0, 'Drop') === 'the track changed');
check('a Rise refused names the fill or the lanes, and keeps the Night 7 words otherwise',
  fl.buildRefusal(8, 5) === 'a fill is already waiting' && fl.buildRefusal(1, 5) === "this track's fill isn't available"
  && fl.buildRefusal(1, 4) === 'its patterns were refused' && fl.buildRefusal(7, 0) === 'press Play first'
  && fl.buildRefusal(3, 0) === 'not while the deck is scratched or braking' && fl.buildRefusal(1, 2) === 'not a valid mix');
check('a Fill into canceled: by the user, once filling, or by Stop (US spelling in new words)',
  fl.fillIntoCancelled('Drop', 10, false) === 'Fill → Drop canceled' && fl.fillIntoCancelled('Drop', 10, true) === 'Drop canceled; the fill plays out its bar'
  && fl.fillIntoCancelled('Drop', 2, false) === 'Fill → Drop canceled: playback stopped');
// Crash on launch (project version 4, ADR-022): off by default, set only explicitly,
// kept by a capture and a reset, and one revision step like a rename.
check('every factory scene has its crash off', scenes.slots.every((x) => x.crash === false));
const crashed = s.setSceneCrash(scenes, 'drop', true);
const crashDrop = crashed.slots.find((x) => x.slot === 'drop');
check('the toggle turns one slot on and moves its revision', crashDrop.crash === true && crashDrop.revision === factory('drop').revision + 1
  && crashed.slots.filter((x) => x.slot !== 'drop').every((x, i) => x === scenes.slots.filter((y) => y.slot !== 'drop')[i]));
check('setting it to what it is changes nothing', s.setSceneCrash(crashed, 'drop', true) === crashed);
check('the mix is untouched by the toggle', s.sameMix(crashDrop, factory('drop')) && JSON.stringify(crashDrop.patterns) === '{}');
const recaptured = s.captureScene(crashed, 'drop', working).slots.find((x) => x.slot === 'drop');
check('capturing over a scene keeps its crash', recaptured.crash === true && recaptured.params['fx.filter'] === working.params['fx.filter']);
check('a new capture into a slot without one stays off', s.captureScene(scenes, 'build', working).slots.find((x) => x.slot === 'build').crash === false);
check('reset to factory keeps the crash: it is the user’s, not the recipe’s', s.resetScene(crashed, 'drop', track).slots.find((x) => x.slot === 'drop').crash === true);
check('duplicate keeps the target slot’s own crash', s.duplicateScene(crashed, 'drop', 'full').slots.find((x) => x.slot === 'full').crash === false
  && s.duplicateScene(crashed, 'full', 'drop').slots.find((x) => x.slot === 'drop').crash === true);
check('turning it off again is explicit too', s.setSceneCrash(crashed, 'drop', false).slots.find((x) => x.slot === 'drop').crash === false);
// Event 53: the status says the crash when it was heard, merged or not, and stays quiet under a solo.
check('a played crash is said', s.accentStatus('Drop', 1) === 'Drop active, with a crash');
check('a merged crash is said the same way', s.accentStatus('Drop', 2) === 'Drop active, with a crash');
check('a crash silent under a solo says nothing', s.accentStatus('Drop', 0) === null);
check('accentFired is not a launch event, so it never settles a request', !s.isLaunchEvent(s.EVENT.accentFired));

const vec = s.sceneVector(applied);
const back = s.mixFromVector(vec);
check('mixFromVector inverts sceneVector', s.sameMix(s.copyMix(back), applied) && s.sceneVector(back).every((v, i) => v === vec[i]));

if (failed) {
  console.error(`\n${failed} scene check(s) failed.`);
  process.exit(1);
}
console.log('\nScene capture, vector layout and request handling hold.');
