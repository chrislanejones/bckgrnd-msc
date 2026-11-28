/**
 * The working arrangement (frontend/lib/arrangement.ts), checked without a browser.
 *
 * Pins docs/ARRANGEMENT.md: a take converts with its linked pairs folded (Fill into,
 * Rise + Fill, recaptured repeats), snapping follows each kind's own grid and the
 * snap, every conflict rule refuses the edit that would break it, duplicate finds a
 * free place, undo and redo walk a mix of edits (selection included), and save → open
 * round-trips while project files, other versions and garbage are refused.
 *
 * `--mutants` also runs every check against deliberately broken copies of the module
 * and fails unless each broken copy is caught, so the checks are known to bite.
 *
 * Usage: node tools/check-arrangement.mjs [--mutants]
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'frontend/lib/arrangement.ts');

/** Bundle arrangement.ts (or a broken copy of its source) and import it. */
async function load(source) {
  const bundled = await build({
    stdin: { contents: source, resolveDir: dirname(SOURCE), sourcefile: 'arrangement.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
}

const perfSchema = JSON.parse(readFileSync(join(root, 'contracts/performance.json'), 'utf8'));
const arrSchema = JSON.parse(readFileSync(join(root, 'contracts/arrangement.json'), 'utf8'));
const AT = '2026-11-26T21:07:00.000Z';
const NOW = new Date('2026-11-28T05:45:00.000Z');

// ---- A take with everything the conversion folds -----------------------------------
//
// The first event (a scene) sounds on song step 20 (bar 2, beat 2) at onset 0, so bar 1
// of the arrangement is the line 4 steps before it: at = onset + 4.
function takeWithEverything() {
  const pos = (step, onset) => ({ step: ((step % 256) + 256) % 256, bar: Math.floor((step % 256) / 16) + 1, beat: Math.floor((step % 16) / 4) + 1, sixteenth: (step % 4) + 1, onset, pass: 1 });
  let seq = 0;
  const ev = (o) => ({ seq: ++seq, ...o });
  return {
    format: 'bckgrnd-msc/performance', version: 2, track: 'warehouse', bpm: 124, stepsPerBar: 16, recordedAt: AT,
    startedAtStep: 16, stoppedBy: 'user', truncated: false,
    events: [
      ev({ kind: 'scene', requestId: 1, ...pos(20, 0), slot: 'sparse', name: 'Sparse', timing: 'now', crash: false, offGrid: true }),
      // A bar fill at bar 2 (at 16), cut short.
      ev({ kind: 'fill', requestId: 2, ...pos(32, 12), style: 'busy', length: 'bar', phraseBars: 0, link: 'none', outcome: 'cutShort', reason: 5 }),
      // A beat fill at bar 3 beat 4 (at 44).
      ev({ kind: 'fill', requestId: 3, ...pos(60, 40), style: 'simple', length: 'beat', phraseBars: 0, link: 'none', outcome: 'played', endStep: 64, endOnset: 44 }),
      // Fill into Drop: the fill at bar 5 (at 64), the landing at bar 6 (at 80).
      ev({ kind: 'fill', requestId: 5, ...pos(80, 60), style: 'classic', length: 'bar', phraseBars: 0, link: 'fillInto', partner: 6, outcome: 'played', endStep: 96, endOnset: 76 }),
      ev({ kind: 'fillInto', requestId: 6, ...pos(96, 76), slot: 'drop', name: 'Drop', fillRequestId: 5, length: 'bar', crash: true }),
      // A Rise + Fill to Build from bar 7 (at 96), 2 bars: its fill at bar 8, landing at bar 9 (at 128).
      ev({ kind: 'rise', requestId: 7, ...pos(112, 92), slot: 'build', name: 'Build', bars: 2, withFill: true, fillRequestId: 8, outcome: 'landed', endStep: 144, endOnset: 124, crash: false }),
      ev({ kind: 'fill', requestId: 8, ...pos(128, 108), style: 'busy', length: 'bar', phraseBars: 0, link: 'rise', partner: 7, outcome: 'played', endStep: 144, endOnset: 124 }),
      // A Rise canceled mid-rise at bar 10 (at 144): left out.
      ev({ kind: 'rise', requestId: 9, ...pos(160, 140), slot: 'drop', name: 'Drop', bars: 4, withFill: false, outcome: 'cancelled', reason: 10, crash: false }),
      // A repeat recaptured on one hold: 1/8 from bar 11 (at 160), 1/4 from at 168, ended at 176.
      ev({ kind: 'repeat', token: 4, ...pos(176, 156), division: 8, endedBy: 'recapture', endStep: 184, endOnset: 164 }),
      ev({ kind: 'repeat', token: 4, ...pos(184, 164), division: 4, endedBy: 'engine', endStep: 192, endOnset: 172, reason: 0 }),
    ],
  };
}

// ---- The checks ------------------------------------------------------------------------

async function runChecks(a, check) {
  const validateWith = (await import('./performance-schema.mjs')).performanceValidator;
  const arrValid = validateWith(arrSchema);
  const takeValid = validateWith(perfSchema);

  // Contract.
  check('contract: initial, stemSettings and fillLength are the take contract\'s, word for word',
    ['initial', 'stemSettings', 'fillLength'].every((k) => JSON.stringify(arrSchema.$defs[k]) === JSON.stringify(perfSchema.$defs[k])));
  check('contract: format and version', a.ARRANGEMENT_FORMAT === 'bckgrnd-msc/arrangement' && a.ARRANGEMENT_VERSION === 1
    && arrSchema.properties.format.const === a.ARRANGEMENT_FORMAT && arrSchema.properties.version.const === 1);

  // fromTake.
  const take = takeWithEverything();
  check('fixture: the take is a valid v2 take', takeValid(take).length === 0, takeValid(take).join('; '));
  const before = JSON.stringify(take);
  const { arrangement: arr, notes } = a.fromTake(take, { now: NOW });
  check('fromTake: the take is not changed', JSON.stringify(take) === before);
  const shape = arr.events.map((e) => `${e.kind}@${e.at}`).join(' ');
  check('fromTake: bar 1 is the first event\'s bar line; linked pairs fold; the canceled Rise is out',
    shape === 'scene@4 fill@16 fill@44 fill@64 rise@96 repeat@160', shape);
  const [scene, barFill, beatFill, into, rise, repeat] = arr.events;
  check('fromTake: the Now scene keeps its sixteenth', scene?.slot === 'sparse' && scene.at === 4);
  check('fromTake: a fill cut short keeps its start, whole, and says so',
    barFill?.style === 'busy' && barFill.length === 'bar' && notes.some((n) => /cut short in the take; it is kept whole/.test(n)), notes.join(' | '));
  check('fromTake: a beat fill sits on beat 4', beatFill?.length === 'beat' && beatFill.at % 16 === 12);
  check('fromTake: Fill into is one fill with into and its crash, landing on the next bar line',
    into?.into === 'drop' && into.crash === true && a.landingOf(into) === 80 && !arr.events.some((e) => e.kind === 'scene' && e.at === 80));
  check('fromTake: a Rise + Fill is one rise with its fill folded in',
    rise?.kind === 'rise' && rise.slot === 'build' && rise.bars === 2 && rise.withFill === true && a.landingOf(rise) === 128
      && !arr.events.some((e) => e.kind === 'fill' && e.at === 112));
  check('fromTake: a canceled Rise is left out, with a note', notes.some((n) => /Rise to Drop at bar 10\.1 was canceled mid-rise; left out/.test(n)), notes.join(' | '));
  check('fromTake: recaptures chain into one span, first division, noted',
    repeat?.division === 8 && repeat.at === 160 && repeat.length === 16 && notes.some((n) => /changed division while held \(1\/8 then 1\/4\)/.test(n)), JSON.stringify(repeat));
  check('fromTake: header: track, bpm, 16 steps, source, length, created', arr.track === 'warehouse' && arr.bpm === 124 && arr.stepsPerBar === 16
    && JSON.stringify(arr.source) === JSON.stringify({ track: 'warehouse', recordedAt: AT, events: 10 }) && arr.lengthBars === 16 && arr.createdAt === NOW.toISOString(),
    JSON.stringify({ source: arr.source, lengthBars: arr.lengthBars }));
  check('fromTake: ids are unique strings', new Set(arr.events.map((e) => e.id)).size === arr.events.length && arr.events.every((e) => typeof e.id === 'string'));
  check('fromTake: the result is valid, by the schema and with no conflicts', arrValid(arr).length === 0 && a.validate(arr).length === 0,
    [...arrValid(arr), ...a.validate(arr).map((c) => c.message)].join('; '));
  {
    // A cue moved the bar lines: a fill off its grid snaps, with a note.
    const t = takeWithEverything();
    t.events = [t.events[0], { ...t.events[2], onset: 41 }];
    const r = a.fromTake(t, { now: NOW });
    check('fromTake: an event off its grid snaps, and says so', r.arrangement.events[1].at === 44 && r.notes.some((n) => /off its grid/.test(n)), r.notes.join(' | '));
  }
  {
    const t = takeWithEverything();
    t.events = t.events.filter((e) => e.requestId !== 5);
    const r = a.fromTake(t, { now: NOW });
    check('fromTake: a landing without its fill becomes a scene', r.arrangement.events.some((e) => e.kind === 'scene' && e.slot === 'drop' && e.at === 80)
      && r.notes.some((n) => /has no fill in the take/.test(n)));
  }

  // Snapping.
  const g = (e, at, s) => a.snapAt(e, at, s);
  check('snap: a scene follows the snap: sixteenth, beat, bar',
    g({ kind: 'scene' }, 21, 'sixteenth') === 21 && g({ kind: 'scene' }, 21, 'beat') === 20 && g({ kind: 'scene' }, 21, 'bar') === 16);
  check('snap: a bar fill is always on a bar line', g({ kind: 'fill', length: 'bar' }, 21, 'sixteenth') === 16 && g({ kind: 'fill', length: 'bar' }, 25, 'beat') === 32);
  check('snap: a beat fill is always on beat 4', g({ kind: 'fill', length: 'beat' }, 21, 'sixteenth') === 28 && g({ kind: 'fill', length: 'beat' }, 3, 'bar') === 12);
  check('snap: a Rise is on a bar line', g({ kind: 'rise' }, 23, 'sixteenth') === 16 && g({ kind: 'rise' }, 25, 'sixteenth') === 32);
  check('snap: a repeat is on its division, or the snap when coarser',
    g({ kind: 'repeat', division: 16 }, 21, 'sixteenth') === 21 && g({ kind: 'repeat', division: 8 }, 21, 'sixteenth') === 22
      && g({ kind: 'repeat', division: 4 }, 21, 'sixteenth') === 20 && g({ kind: 'repeat', division: 16 }, 21, 'beat') === 20);
  check('snap: never before the start', g({ kind: 'scene' }, -9, 'sixteenth') === 0 && g({ kind: 'fill', length: 'beat' }, -40, 'bar') === 12);

  // The editor: each conflict rule refuses the edit.
  const editor = (doc, snap = 'sixteenth') => {
    const ed = new a.ArrangementEditor({ snap, defaults: () => ({ fillStyle: 'busy', fillLength: 'bar' }) });
    ed.load(structuredClone(doc));
    return ed;
  };
  const empty = a.emptyArrangement('warehouse', 124, { now: NOW });
  const refuses = (name, r, re) => check(name, r.ok === false && re.test(r.reason), r.ok ? 'accepted' : r.reason);
  {
    const ed = editor(empty);
    const s1 = ed.insert('scene', 16, { slot: 'sparse' });
    check('insert: a scene', s1.ok && ed.working.events.length === 1);
    refuses('conflict: two scene changes on one step', ed.insert('scene', 16, { slot: 'drop' }), /Two scene changes at bar 2\.1/);
    const f = ed.insert('fill', 0, { into: 'build' });
    refuses('conflict: a Fill into landing on a scene', f, /Two scene changes at bar 2\.1/);
    const r = ed.insert('fill', 32);
    check('insert: a fill takes the current style and length', r.ok && ed.working.events.find((e) => e.id === r.id)?.style === 'busy');
    refuses('conflict: overlapping fills', ed.insert('fill', 44, { length: 'beat' }), /overlap: one fill plays at a time/);
  }
  {
    const doc = structuredClone(empty);
    doc.events = [{ id: 'r', kind: 'rise', at: 32, slot: 'drop', bars: 4, withFill: true, crash: false }];
    const ed = editor(doc);
    refuses('conflict: a scene change inside a Rise', ed.insert('scene', 40, { slot: 'sparse' }), /falls inside the Rise to Drop/);
    refuses('conflict: a scene on a Rise landing', ed.insert('scene', 96, { slot: 'sparse' }), /Two scene changes at bar 7\.1/);
    refuses('conflict: a fill in a Rise + Fill\'s last bar', ed.insert('fill', 80), /the fill of the Rise to Drop/i);
    check('a fill before the Rise + Fill\'s last bar is fine', ed.insert('fill', 64).ok);
    const doc2 = structuredClone(doc);
    doc2.events.push({ id: 'r2', kind: 'rise', at: 128, slot: 'full', bars: 2, withFill: false, crash: false });
    const ed2 = editor(doc2);
    refuses('conflict: overlapping Rises are refused', ed2.move('r2', 80), /falls inside|overlap/);
    // Overlapping Rises always put a landing inside the other too; the overlap is named as well.
    const both = structuredClone(doc2);
    both.events[1].at = 80;
    check('conflict: overlapping Rises are named as overlapping',
      a.validate(both).some((c) => /The Rise to Drop at bar 3\.1 and the Rise to Full at bar 6\.1 overlap/.test(c.message)), a.validate(both).map((c) => c.message).join(' | '));
    refuses('conflict: a Rise landing past the end', ed2.move('r2', 224), /lands at bar 17\.1, past the end \(16 bars\)/);
    refuses('conflict: a Fill into landing past the end', ed2.insert('fill', 240, { into: 'drop' }), /lands at bar 17\.1, past the end/);
    const rep = structuredClone(empty);
    rep.events = [{ id: 'p1', kind: 'repeat', at: 0, division: 8, length: 8 }, { id: 'p2', kind: 'repeat', at: 16, division: 8, length: 4 }];
    const ed3 = editor(rep);
    refuses('conflict: overlapping repeats', ed3.move('p2', 6), /Repeat 1\/8 .* overlap/);
    check('a refused edit changes nothing and adds no undo step', JSON.stringify(ed3.working) === JSON.stringify(rep) && !ed3.canUndo);
  }

  // Edits, duplicate, history.
  {
    const ed = editor(arr, 'bar');
    const first = ed.working;
    const m = ed.move(scene.id, 21);
    check('move: snaps to the snap (bar) for a scene', m.ok && ed.working.events.find((e) => e.id === scene.id).at === 16, JSON.stringify(m));
    refuses('move: refused onto another scene change', ed.move(scene.id, 80), /Two scene changes at bar 6\.1/);
    ed.setSnap('beat');
    check('nudge: by the snap, then by a given snap', ed.nudge(scene.id, 1).ok && ed.working.events.find((e) => e.id === scene.id).at === 20
      && ed.nudge(scene.id, -1, 'sixteenth').ok && ed.working.events.find((e) => e.id === scene.id).at === 19);
    const d = ed.duplicate(beatFill.id);
    check('duplicate: the next free beat-4 after it', d.ok && ed.working.events.find((e) => e.id === d.id)?.at === 60 && ed.selected === d.id, JSON.stringify(d));
    const d2 = ed.duplicate(barFill.id);
    // Bars 3, 4 and 5 hold the beat fill, its copy and the Fill into: the copy goes to bar 6.
    check('duplicate: skips places that would conflict', d2.ok && ed.working.events.find((e) => e.id === d2.id)?.at === 80, JSON.stringify(d2));
    const u = ed.update(beatFill.id, { length: 'bar' });
    check('update: a beat fill made a bar fill snaps to its bar line, if free', u.ok === false && /overlap/.test(u.reason), JSON.stringify(u));
    check('update: Fill into to a plain fill drops the crash', ed.update(into.id, { into: null }).ok
      && !('into' in ed.working.events.find((e) => e.id === into.id)) && !('crash' in ed.working.events.find((e) => e.id === into.id)));
    refuses('update: a field the kind does not have', ed.update(scene.id, { bars: 4 }), /A scene has no bars/);
    refuses('update: a crash on a plain fill', ed.update(barFill.id, { crash: true }), /Only a Fill into has a crash/);
    const r = ed.remove(rise.id);
    check('remove: gone, selection moves on', r.ok && !ed.working.events.some((e) => e.id === rise.id));
    const steps = 7;
    let undone = 0;
    while (ed.undo()) undone += 1;
    check('undo: back through every edit to the start', undone === steps && JSON.stringify(ed.working) === JSON.stringify(first) && !ed.dirty, `${undone} undos`);
    ed.redo();
    ed.redo();
    ed.redo();
    check('redo: forward again, the selection with it', ed.working.events.find((e) => e.id === scene.id).at === 19 && ed.selected === scene.id && ed.dirty);
    check('a new edit clears redo', ed.insert('scene', 150, { slot: 'drop' }).ok && !ed.canRedo);
    const capped = new a.ArrangementEditor({ snap: 'sixteenth', limit: 5 });
    capped.load(structuredClone(empty));
    for (let i = 0; i < 9; i += 1) capped.insert('scene', i * 16, { slot: 'sparse' });
    let n = 0;
    while (capped.undo()) n += 1;
    check('undo is capped', n === 5 && a.HISTORY_LIMIT === 200, `${n}`);
    check('insert: the next scene slot after the one sounding', (() => {
      const e2 = editor(empty);
      e2.insert('scene', 16, { slot: 'build' });
      const r2 = e2.insert('scene', 32);
      return r2.ok && e2.working.events.find((e) => e.id === r2.id).slot === 'drop';
    })());
  }

  // Save → open.
  {
    const ed = editor(arr);
    ed.move(scene.id, 2);
    const file = a.exportArrangement(ed.working, NOW);
    const local = NOW;
    const p2 = (x) => String(x).padStart(2, '0');
    check('save: the filename', file.filename === `bckgrnd-arrangement-warehouse-${local.getFullYear()}-${p2(local.getMonth() + 1)}-${p2(local.getDate())}-${p2(local.getHours())}${p2(local.getMinutes())}.json`, file.filename);
    check('save: the file validates against contracts/arrangement.json', arrValid(JSON.parse(file.json)).length === 0, arrValid(JSON.parse(file.json)).join('; '));
    const back = a.openArrangementText(file.json);
    check('open: round trip, the same arrangement, no conflicts', back.ok && JSON.stringify(back.arrangement) === JSON.stringify(ed.working) && back.conflicts.length === 0);
    const fromFile = a.openArrangementText(JSON.stringify(take), { now: NOW });
    check('open: a take v2 file is converted', fromFile.ok && JSON.stringify(fromFile.arrangement) === JSON.stringify(arr) && fromFile.notes[0] === 'Made from a take file.');
    const doc = JSON.parse(file.json);
    const no = (name, text, re) => {
      const r = a.openArrangementText(text);
      check(name, r.ok === false && re.test(r.reason), r.ok ? 'opened' : r.reason);
    };
    no('open: refuses garbage', 'not json at all', /not JSON/);
    no('open: refuses a project file', JSON.stringify({ format: 'bckgrnd-msc/project', version: 4 }), /This is a project file/);
    no('open: refuses a newer version', JSON.stringify({ ...doc, version: 2 }), /version 2, newer than this app reads \(1\)/);
    no('open: refuses version 0', JSON.stringify({ ...doc, version: 0 }), /version 0; this app reads version 1/);
    no('open: refuses another format', JSON.stringify({ format: 'something/else' }), /Not an arrangement or a take/);
    no('open: refuses a schema miss, naming it', JSON.stringify({ ...doc, events: [{ ...doc.events[0], slot: 'chorus' }] }), /arrangement format \(events\[0\]/);
    no('open: refuses duplicate ids', JSON.stringify({ ...doc, events: [doc.events[0], { ...doc.events[1], id: doc.events[0].id }] }), /share the id/);
    no('open: refuses a take with no onsets', JSON.stringify({ ...take, events: [(({ onset: _o, ...e }) => e)(take.events[0])] }), /can't be arranged: Event 1 has no onset/);
    const clash = { ...doc, events: [...doc.events, { id: 'x', kind: 'scene', at: 80, slot: 'full', crash: false }] };
    const opened = a.openArrangementText(JSON.stringify(clash));
    check('open: a file with conflicts opens, listing them', opened.ok && opened.conflicts.length === 1 && /Two scene changes at bar 6\.1/.test(opened.conflicts[0].message)
      && opened.notes.some((n) => /1 conflict to fix/.test(n)), opened.ok ? opened.conflicts.map((c) => c.message).join('; ') : opened.reason);
    if (opened.ok) {
      const ed2 = editor(opened.arrangement);
      check('an edit elsewhere in a file with conflicts is allowed', ed2.nudge(scene.id, 1).ok);
      check('fixing the conflict is allowed', ed2.move('x', 81).ok && ed2.conflicts.length === 0);
    }
  }
}

// ---- Run ------------------------------------------------------------------------------

function runner(quiet) {
  const failures = [];
  const check = (name, ok, detail = '') => {
    if (!quiet) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };
  return { check, failures };
}

const source = readFileSync(SOURCE, 'utf8');
const main = runner(false);
await runChecks(await load(source), main.check);

/** Broken copies of the module: each must make at least one check fail. */
const MUTANTS = [
  ['the fill into landing is the same bar', 'return e.into ? (Math.floor(e.at / STEPS_PER_BAR) + 1) * STEPS_PER_BAR : null;', 'return e.into ? Math.floor(e.at / STEPS_PER_BAR) * STEPS_PER_BAR : null;'],
  ['a beat fill on the bar line', "offset: e.length === 'beat' ? 12 : 0", 'offset: 0'],
  ['the snap ignores the kind grid', 'step: Math.max(own.step, SNAP_STEPS[snap])', 'step: SNAP_STEPS[snap]'],
  ['no same-step scene rule', 'if (j > i) {', 'if (j > i && false) {'],
  ['no scene-inside-Rise rule', 'if (c.id === r.id || c.at < r.at || c.at >= landing) continue;', 'continue;'],
  ['no overlapping-Rises rule', "message: `The ${named(rises[i]!)} and the ${named(rises[j]!)} overlap.` });", 'message: \'\' }) && out.pop();'],
  ['the Rise + Fill last bar not a fill', 'if (e.kind === \'rise\' && e.withFill) return', 'if (e.kind === \'rise\' && false) return'],
  ['no overlapping-repeats rule', "message: `The ${named(repeats[i]!)} and the ${named(repeats[j]!)} overlap.` });", 'message: \'\' }) && out.pop();'],
  ['landing past the end allowed', 'if (landing !== null && landing >= end && e.at < end) {', 'if (landing !== null && landing > end + 999) {'],
  ['edits are never refused', 'if (fresh.length > 0) return', 'if (fresh.length < 0) return'],
  ['fromTake keeps a canceled Rise', "if (e.outcome === 'cancelled' || e.outcome === 'replaced') {", "if (e.outcome === 'nothing') {"],
  ['fromTake leaves the Rise fill separate', "if (e.link === 'rise') break; // part of its Rise", ''],
  ['fromTake ignores Fill into', 'if (into && isSlot(into.slot)) {', 'if (false) {'],
  ['recaptures not chained', "if (e.endedBy === 'recapture') openChain.set(e.token, current);", "if (false) openChain.set(e.token, current);"],
  ['bar 1 not the first bar line', 'const x = (onset: number) => onset + lead;', 'const x = (onset: number) => onset;'],
  ['duplicate does not skip conflicts', 'if (added(doc, next).length === 0) return this.commit(next, copyId, \'\');', 'return this.commit(next, copyId, \'\');'],
  ['undo forgets the selection', 'this.entry = this.past.pop()!;', 'this.entry = { ...this.past.pop()!, selected: null };'],
  ['the history is not capped', 'if (this.past.length > limit) this.past.splice(0, this.past.length - limit);', ''],
  ['newer versions open', 'if (d.version > ARRANGEMENT_VERSION) {', 'if (d.version > 99) {'],
  ['project files open as nothing in particular', "if (d.format === 'bckgrnd-msc/project') {", "if (d.format === 'nope') {"],
  ['schema misses open', 'if (errors.length > 0) {', 'if (errors.length > 99) {'],
  ['duplicate ids open', 'if (ids.has(e.id)) return', 'if (false) return'],
];

let failed = main.failures.length;
if (process.argv.includes('--mutants')) {
  console.log('\nmutants (each must be caught):');
  for (const [name, from, to] of MUTANTS) {
    if (!source.includes(from)) {
      console.log(`FAIL  mutant "${name}": its code is gone; update the mutant`);
      failed += 1;
      continue;
    }
    let caught;
    try {
      const m = runner(true);
      await runChecks(await load(source.replace(from, to)), m.check);
      caught = m.failures;
    } catch (e) {
      caught = [`threw: ${String(e.message).split('\n')[0]}`];
    }
    console.log(`${caught.length ? 'ok  ' : 'FAIL'}  mutant "${name}" ${caught.length ? `caught by: ${caught.slice(0, 2).join('; ')}` : 'NOT caught'}`);
    if (!caught.length) failed += 1;
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall arrangement checks passed');
process.exit(failed ? 1 : 0);
