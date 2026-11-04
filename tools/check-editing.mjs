/**
 * Pattern editing (frontend/lib/editing.ts), checked without a browser.
 *
 * Holds the rules the editor depends on and a screen cannot show: an undo restores
 * exactly, a painted row or a velocity drag is one revision, lowering a velocity
 * never deletes a hit, paste replaces, duplicate never wraps, notes never overlap
 * and chords stay chords, humanize is seeded, recomputed from its source and keeps
 * its hands off locks and accents.
 *
 * Usage: node tools/check-editing.mjs
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  stdin: {
    contents: "export * from './frontend/lib/editing.ts'; export * from './frontend/lib/patterns.ts';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const ed = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const track = JSON.parse(readFileSync(join(root, 'public/library/warehouse.json'), 'utf8')).track;

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}
const deep = (x) => JSON.parse(JSON.stringify(x));
const at = (p, step) => p.events.find((e) => e.step === step);

const hat = ed.factoryPattern(track, 'hat');
const bass = ed.factoryPattern(track, 'bass');

// ---- Undo is exact ---------------------------------------------------------------
{
  const working = { hat: ed.paintHits(hat, [129], 'add', 0.6) };
  const before = deep(working);
  const [from, to] = ed.barRange(8);
  const change = { hat: ed.clearRange(working.hat, from, to), kick: ed.clearRange(ed.factoryPattern(track, 'kick'), from, to) };
  const inverse = ed.inverseOf(working, change);
  const cleared = ed.applyChange(working, change);
  check('clear empties bar 9', !cleared.hat.events.some((e) => e.step >= from && e.step <= to));
  check('clear leaves the input untouched', isDeepStrictEqual(working, before));
  const undone = ed.applyChange(cleared, inverse);
  check('clear then undo restores the exact patterns', isDeepStrictEqual(undone, before), JSON.stringify(Object.keys(undone)));
  check('undo puts an untouched lane back to the factory (absent)', !('kick' in undone));
  const redone = ed.applyChange(undone, change);
  check('redo reapplies the same edit', isDeepStrictEqual(redone, cleared));
  check('an empty lane is silence, not missing', 'hat' in cleared && Array.isArray(cleared.hat.events));
}

// ---- Drums -------------------------------------------------------------------------
{
  const painted = ed.paintHits(hat, [129, 130, 131, 130], 'add', 0.6);
  check('one painted row is one revision', painted.revision === hat.revision + 1);
  check('a factory lane becomes an edited one', painted.id === 'p-hat' && hat.id === 'factory-hat');
  check('painting crosses a step once, adding only empty ones', painted.events.length - hat.events.length === [129, 130, 131].filter((s) => !at(hat, s)).length);
  const ids = new Set(painted.events.map((e) => e.id));
  check('event ids stay unique', ids.size === painted.events.length);
  const existing = hat.events.find((e) => e.step >= 128);
  const erased = ed.paintHits(hat, [existing.step], 'remove', 0.6);
  check('an erase gesture removes the hit', !at(erased, existing.step));

  const low = ed.setVelocities(hat, [existing.id], 'set', 0);
  check('lowering a velocity to nothing keeps the hit', at(low, existing.step)?.vel === ed.MIN_VELOCITY);
  const some = hat.events.filter((e) => e.step >= 128 && e.step < 144).map((e) => e.id);
  const scaled = ed.setVelocities(hat, some, 'scale', 0.5);
  const ratiosKept = some.every((id) => {
    const a = hat.events.find((e) => e.id === id).vel;
    const b = scaled.events.find((e) => e.id === id).vel;
    return Math.abs(b - Math.max(ed.MIN_VELOCITY, Math.round(a * 0.5 * 1000) / 1000)) < 1e-9;
  });
  check('adjust-together scales each selected hit', ratiosKept && scaled.revision === hat.revision + 1);
  const set = ed.setVelocities(hat, some, 'set', 0.42);
  check('set-together gives every selected hit one value', some.every((id) => set.events.find((e) => e.id === id).vel === 0.42));

  const clip = ed.copyRange(painted, ...ed.barRange(8), 'Closed hat · Bar 9');
  const pasted = ed.pasteClip(ed.factoryPattern(track, 'hat'), clip, 9 * 16);
  const bar10 = pasted.events.filter((e) => e.step >= 144 && e.step < 160).map((e) => [e.step - 144, e.vel]);
  const bar9 = painted.events.filter((e) => e.step >= 128 && e.step < 144).map((e) => [e.step - 128, e.vel]);
  check('paste replaces the destination bar exactly', isDeepStrictEqual(bar10, bar9));
  check('a drum clip will not paste into a note lane', ed.pasteClip(bass, clip, 0) === null);
  check('duplicate onto the next bar works', ed.duplicateBar(painted, 8, 9) !== null);
  check('duplicate never wraps past the last bar', ed.duplicateBar(painted, 15, 16) === null);
}

// ---- Notes -------------------------------------------------------------------------
{
  const empty = ed.clearRange(bass, 0, 255);
  const one = ed.addNote(empty, 128, 40, 4, 0.9);
  check('a note is added', one.events.length === 1);
  check('a note on top of another is refused', ed.addNote(one, 130, 43, 2, 0.9) === null);
  const id = one.events[0].id;
  check('a move into another note is refused', ed.editNote(ed.addNote(one, 136, 43, 2, 0.9), id, { step: 134 }) === null);
  const end = ed.addNote(empty, 254, 40, 8, 0.9);
  check('a note is clamped at the song end', end.events[0].len === 2);
  const crossing = ed.editNote(one, id, { step: 142, len: 4 });
  check('a note may cross into the next bar', crossing.events[0].step === 142 && ed.carriedInto(crossing, 9).length === 1);

  const chord = { ...empty, events: [{ id: 'bx1', step: 64, notes: [40, 44, 47], len: 4, vel: 0.8, accent: true }] };
  const up = ed.editNote(chord, 'bx1', { semitones: 2, step: 66 });
  check('a chord transposes and moves together', isDeepStrictEqual(up.events[0].notes, [42, 46, 49]) && up.events[0].step === 66);
  const lanes = ed.compileLanes([up]);
  check('the payload carries every chord pitch', lanes[4 + 5] === 42 && lanes[4 + 6] === 46 && lanes[4 + 7] === 49 && lanes[4 + 8] === -1);
  check('a source hash moves when its range changes', ed.sourceHash(chord, 64, 127) !== ed.sourceHash(up, 64, 127));
  check('a source hash ignores the outside', ed.sourceHash(chord, 128, 191) === ed.sourceHash(up, 128, 191));
}

// ---- Humanize ----------------------------------------------------------------------
{
  const settings = { amount: 0.8, preserveAccents: false, seed: 42, from: 0, to: 255 };
  const a = ed.humanize(hat, settings, ed.NO_LOCKS);
  const b = ed.humanize(hat, settings, ed.NO_LOCKS);
  check('the same seed gives the same humanize', isDeepStrictEqual(a, b));
  const c = ed.humanize(hat, { ...settings, seed: 43 }, ed.NO_LOCKS);
  check('another seed gives another', !isDeepStrictEqual(a.events, c.events));
  check('humanize touches velocity only', a.events.every((e, i) => e.id === hat.events[i].id && e.step === hat.events[i].step));
  check('every velocity stays in range', a.events.every((e) => e.vel >= ed.MIN_VELOCITY && e.vel <= 1));
  // The editor always humanizes the source (the working lane, untouched while a
  // candidate is previewed), never a previous candidate: stacking would drift.
  const stacked = ed.humanize(a, { ...settings, amount: 0.3 }, ed.NO_LOCKS);
  const fromSource = ed.humanize(hat, { ...settings, amount: 0.3 }, ed.NO_LOCKS);
  check('stacking would drift, which is why the source is used', !isDeepStrictEqual(stacked.events, fromSource.events));
  check('a candidate names the revision it was made from', fromSource.origin.sourceRevision === hat.revision);
  check('it records what made it', a.origin.kind === 'humanize' && a.origin.generator === ed.HUMANIZE_GENERATOR && a.origin.seed === 42 && a.origin.sourceRevision === hat.revision);
  const lockedId = hat.events[3].id;
  const locked = ed.humanize(hat, settings, { lanes: [], events: { hat: [lockedId] } });
  check('a locked hit keeps its velocity', locked.events[3].vel === hat.events[3].vel);
  const laneLocked = ed.humanize(hat, settings, { lanes: ['hat'], events: {} });
  check('a locked lane is unchanged', isDeepStrictEqual(laneLocked.events, hat.events));
  const accents = ed.humanize(ed.factoryPattern(track, 'kick'), { ...settings, preserveAccents: true }, ed.NO_LOCKS);
  const kick = ed.factoryPattern(track, 'kick');
  const accentKept = kick.events.filter((e) => ed.isAccent(kick, e)).every((e) => accents.events.find((x) => x.id === e.id).vel === e.vel);
  check('preserve accents keeps the accents', accentKept);
  const scoped = ed.humanize(hat, { ...settings, from: 128, to: 143 }, ed.NO_LOCKS);
  check('humanize stays inside its range', scoped.events.every((e, i) => (e.step >= 128 && e.step <= 143) || e.vel === hat.events[i].vel));
}

// ---- What changed, in words --------------------------------------------------------
{
  const painted = ed.paintHits(hat, [129, 131], 'add', 0.6);
  check('a change summary counts hits', ed.changeSummary(hat, painted) === '2 hits added', ed.changeSummary(hat, painted));
}

if (failed) {
  console.error(`\n${failed} editing check(s) failed`);
  process.exit(1);
}
console.log('\nall editing checks passed');
