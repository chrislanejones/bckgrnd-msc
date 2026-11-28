/**
 * The performance recording (frontend/lib/recording.ts), checked without a browser.
 *
 * Pins the rules a take must keep (docs/PERFORMANCE_EVENTS.md): positions come from
 * engine steps and onset serials, events keep the engine's order, only applied actions
 * are kept, a cancel or a replace never is, a Beat Repeat is kept from its engage to its
 * end (and one released before its grid line never is), interruptions end the take (or
 * not) as documented, the cap holds, and every take and every export validates against
 * contracts/performance.json (v2). The engine events here are synthetic and carry `s`,
 * the scheduler's onset serial (Night 11).
 *
 * Usage: node tools/check-recording.mjs
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performanceValidator } from './performance-schema.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  entryPoints: [join(root, 'frontend/lib/recording.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const r = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const schema = JSON.parse(readFileSync(join(root, 'contracts/performance.json'), 'utf8'));

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const valid = performanceValidator(schema);
const without = (o, key) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

// ---- Position math. --------------------------------------------------------------
const p = r.positionOf;
check('step 0 is bar 1, beat 1, sixteenth 1', JSON.stringify(p(0)) === JSON.stringify({ step: 0, bar: 1, beat: 1, sixteenth: 1 }));
check('step 16 is bar 2, beat 1', p(16).bar === 2 && p(16).beat === 1 && p(16).sixteenth === 1);
check('step 21 is bar 2, beat 2, sixteenth 2', p(21).bar === 2 && p(21).beat === 2 && p(21).sixteenth === 2);
check('step 255 is bar 16, beat 4, sixteenth 4', p(255).bar === 16 && p(255).beat === 4 && p(255).sixteenth === 4);
check('an on-grid step is not flagged', !('offGrid' in p(64)));
const now = p(-1, 37);
check('a Now apply (-1) sits on the transport step, flagged off grid', now.step === 37 && now.bar === 3 && now.offGrid === true, JSON.stringify(now));
const stopped = p(-1, -1);
check('an apply while stopped sits on step 0 (Play starts there), off grid', stopped.step === 0 && stopped.offGrid === true, JSON.stringify(stopped));
check('a step past the song folds into it (the telemetry step is a song step)', p(256 + 17).step === 17);

// ---- A fake engine and host: catalog, events, a session. -------------------------
const names = { full: 'Full', sparse: 'Sparse', build: 'Build', drop: 'Drop' };
const E = { sq: 1, sa: 2, sc: 3, sr: 4, sj: 5, fq: 11, fs: 12, fe: 13, fc: 14, bq: 41, ba: 42, bc: 43, bs: 46, fu: 52, acc: 53, rs: 61, re: 62 };
/** Kinds whose `a` is the step they happened on: their serial follows it, in one pass from serial 1000. */
const AT_STEP = new Set([E.sa, E.fs, E.fe, E.ba, E.bs, E.acc, E.rs, E.re]);
const AT = '2026-11-26T21:07:00.000Z';
function rig() {
  const s = new r.RecordingSession();
  const c = new r.RequestCatalog();
  let transport = -1;
  let serial = 1000;
  /** `s` defaults to 1000 + the step for a stepped event (one pass of the song), else the last serial. */
  const feed = (kind, requestId, a = 0, b = 0, sOn) => {
    if (sOn !== undefined) serial = sOn;
    else if (AT_STEP.has(kind) && a >= 0) serial = 1000 + a;
    const input = r.fromEngine({ kind, requestId, a, b, s: serial }, c, (slot) => names[slot] ?? slot, transport);
    if (input) s.record(input);
  };
  return { s, c, feed, at: (step) => { transport = step; } };
}

// A small performance: a scene on the next bar, a fill, a Rise with a fill, a cancel, a replace.
{
  const { s, c, feed, at } = rig();
  at(10);
  s.start('warehouse', 124, 10, AT);
  check('start: recording, nothing yet', s.state === 'recording' && s.count === 0);
  c.remember({ kind: 'scene', requestId: 1, target: 'sparse', timing: 'bar' });
  feed(E.sq, 1, 2, 16);
  check('a queued scene is not in the take', s.count === 0);
  feed(E.sa, 1, 16);
  feed(E.acc, 1, 16, 1);
  c.remember({ kind: 'fill', requestId: 2, style: 'busy', phrase: 0, link: 'none' });
  feed(E.fq, 2, 3, 32);
  feed(E.fs, 2, 32);
  feed(E.fe, 2, 48);
  // A queued scene canceled: logged, never kept.
  c.remember({ kind: 'scene', requestId: 3, target: 'build', timing: 'bar' });
  feed(E.sq, 3, 4, 48);
  feed(E.sc, 3, 10);
  // A scene replaced by a Rise: the scene never lands.
  c.remember({ kind: 'scene', requestId: 4, target: 'full', timing: 'bar' });
  feed(E.sq, 4, 4, 48);
  c.remember({ kind: 'rise', requestId: 5, target: 'drop', bars: 2, fillId: 6 });
  c.remember({ kind: 'fill', requestId: 6, style: 'snare', phrase: 0, link: 'rise', partner: 5 });
  feed(E.sr, 4, 5);
  feed(E.bq, 5, 4, 48);
  feed(E.bs, 5, 48, 2);
  feed(E.fs, 6, 64);
  feed(E.fe, 6, 80);
  feed(E.ba, 5, 80, 1);
  feed(E.acc, 5, 80, 1);
  // A rejected Fill into: never kept.
  c.remember({ kind: 'fillInto', requestId: 7, target: 'drop', fillId: 8 });
  feed(E.sj, 7, 6);
  // Applied with Now: off grid at the transport step.
  at(83);
  c.remember({ kind: 'scene', requestId: 9, target: 'full', timing: 'now' });
  feed(E.sa, 9, -1);
  // A Compare listen is not performance.
  c.remember({ kind: 'scene', requestId: 10, target: 'compareA', timing: 'bar' });
  feed(E.sa, 10, 96);
  s.stop();
  const doc = s.recording();
  const kinds = doc.events.map((e) => `${e.kind}@${e.step}`).join(' ');
  check('only applied actions are kept, in order', kinds === 'scene@16 fill@32 rise@48 fill@64 scene@83', kinds);
  check('seq counts 1, 2, 3... in order', doc.events.every((e, i) => e.seq === i + 1));
  check('the canceled scene is absent', !doc.events.some((e) => e.requestId === 3));
  check('the replaced scene is absent', !doc.events.some((e) => e.requestId === 4));
  check('the rejected Fill into is absent', !doc.events.some((e) => e.requestId === 7));
  check('a Compare listen is not recorded', !doc.events.some((e) => e.requestId === 10));
  const [scene, fill, rise, riseFill, nowScene] = doc.events;
  check('the scene names its slot, name, timing and the crash it fired',
    scene.slot === 'sparse' && scene.name === 'Sparse' && scene.timing === 'bar' && scene.crash === true && scene.bar === 2, JSON.stringify(scene));
  check('the fill has its style, phrase and where the drums came back',
    fill.style === 'busy' && fill.phraseBars === 0 && fill.outcome === 'played' && fill.endStep === 48 && fill.link === 'none', JSON.stringify(fill));
  check('the Rise has its bars, landing scene, fill link and landed',
    rise.bars === 2 && rise.slot === 'drop' && rise.withFill && rise.fillRequestId === 6 && rise.outcome === 'landed' && rise.endStep === 80 && rise.crash, JSON.stringify(rise));
  check("the Rise's fill links back to it", riseFill.link === 'rise' && riseFill.partner === 5);
  check('the Now scene is off grid at the transport step', nowScene.offGrid === true && nowScene.step === 83 && nowScene.timing === 'now');
  const statuses = s.log.filter((l) => l.kind !== 'session').map((l) => `${l.requestId}:${l.status}${l.recorded ? '+' : ''}`);
  check('the log tags queued, canceled, replaced and rejected', ['3:queued', '3:canceled', '4:replaced', '7:rejected'].every((x) => statuses.includes(x)), statuses.join(' '));
  check('the log marks only the kept events as recorded', s.log.filter((l) => l.recorded).length === doc.events.length);
  check('the take validates against contracts/performance.json', valid(doc).length === 0, valid(doc).join('; '));
  check('the header: format, version 2, track, bpm, 16 steps a bar, recordedAt, start step',
    doc.format === 'bckgrnd-msc/performance' && doc.version === 2 && doc.track === 'warehouse' && doc.bpm === 124 && doc.stepsPerBar === 16
      && doc.recordedAt === AT && doc.startedAtStep === 10 && doc.stoppedBy === 'user');
  check('onsets count from the first event, one pass, all pass 1',
    doc.events.map((e) => e.onset).join(' ') === '0 16 32 48 64' && doc.events.every((e) => e.pass === 1), doc.events.map((e) => `${e.onset}/${e.pass}`).join(' '));
  check('a fill and a Rise end with the onset they ended on', fill.endOnset === 32 && rise.endOnset === 64, `${fill.endOnset} ${rise.endOnset}`);
  check('a fill sent with no length played the bar', fill.length === 'bar' && riseFill.length === 'bar');
  check('recording() is a copy', (doc.events.pop(), s.count === 5));
}

// Fill → Drop: the fill and the scene it lands, linked both ways.
{
  const { s, c, feed, at } = rig();
  at(5);
  s.start('warehouse', 124, 5);
  c.remember({ kind: 'fillInto', requestId: 20, target: 'drop', fillId: 19 });
  c.remember({ kind: 'fill', requestId: 19, style: 'busy', phrase: 4, link: 'fillInto', partner: 20 });
  feed(E.fq, 19, 4, 48);
  feed(E.sq, 20, 5, 64);
  feed(E.fs, 19, 48);
  feed(E.fe, 19, 64);
  feed(E.sa, 20, 64);
  const doc = s.recording();
  check('fill into: the fill, then the scene it lands, on its end step',
    doc.events.map((e) => `${e.kind}@${e.step}`).join(' ') === 'fill@48 fillInto@64' && doc.events[1].fillRequestId === 19 && doc.events[0].partner === 20,
    JSON.stringify(doc.events));
  check('fill into: validates', valid(doc).length === 0, valid(doc).join('; '));
  check('fill into: a bar fill says so on both halves', doc.events[0].length === 'bar' && doc.events[1].length === 'bar');
}

// A Fill into canceled once its fill plays: the fill stays (it was heard), unlinked; no scene.
{
  const { s, c, feed } = rig();
  s.start('warehouse', 124, 0);
  c.remember({ kind: 'fillInto', requestId: 31, target: 'drop', fillId: 30 });
  c.remember({ kind: 'fill', requestId: 30, style: 'busy', phrase: 0, link: 'fillInto', partner: 31 });
  feed(E.fs, 30, 16);
  feed(E.sc, 31, 10);
  feed(E.fu, 30, 10);
  feed(E.fe, 30, 32);
  const doc = s.recording();
  check('fill into canceled while filling: the fill is kept, unlinked, and no scene',
    doc.events.length === 1 && doc.events[0].kind === 'fill' && doc.events[0].link === 'none' && !('partner' in doc.events[0]), JSON.stringify(doc.events));
}

// A Rise canceled before it starts is never kept; one canceled mid-rise keeps its start.
{
  const { s, c, feed } = rig();
  s.start('warehouse', 124, 0);
  c.remember({ kind: 'rise', requestId: 40, target: 'drop', bars: 4 });
  feed(E.bq, 40, 2, 16);
  feed(E.bc, 40, 10);
  check('a Rise canceled while queued is not kept', s.count === 0);
  c.remember({ kind: 'rise', requestId: 41, target: 'build', bars: 4 });
  feed(E.bs, 41, 32, 4);
  feed(E.bc, 41, 5);
  const doc = s.recording();
  check('a Rise canceled mid-rise keeps its start, marked cancelled with the reason',
    doc.events.length === 1 && doc.events[0].outcome === 'cancelled' && doc.events[0].reason === 5 && doc.events[0].step === 32, JSON.stringify(doc.events));
  check('a fill cut short says so', (() => {
    c.remember({ kind: 'fill', requestId: 42, style: null, phrase: 0, link: 'none' });
    feed(E.fs, 42, 48);
    feed(E.fe, 42, -1, 5);
    const f = s.recording().events.at(-1);
    return f.outcome === 'cutShort' && f.reason === 5 && !('endStep' in f);
  })());
  c.remember({ kind: 'rise', requestId: 43, target: 'drop', bars: 2 });
  feed(E.bs, 43, 64, 2);
  feed(E.ba, 43, 96, 0);
  check('a Rise that ran its bars landed, whether or not the engine committed a separate landing vector',
    s.recording().events.at(-1).outcome === 'landed' && s.recording().events.at(-1).endStep === 96);
  check('canceled and cut short still validate', valid(s.recording()).length === 0, valid(s.recording()).join('; '));
}

// Interruptions.
{
  const cases = [['stop', 'stop'], ['panic', 'panic'], ['track', 'track'], ['mix', 'mix']];
  for (const [what, by] of cases) {
    const { s } = rig();
    s.start('warehouse', 124, 0);
    s.interrupt(what);
    check(`interrupt ${what}: the take stops, stoppedBy ${by}`, s.state === 'stopped' && s.recording().stoppedBy === by);
  }
  for (const what of ['cue', 'seek']) {
    const { s } = rig();
    s.start('warehouse', 124, 0);
    s.interrupt(what);
    check(`interrupt ${what}: still recording, and the log says so`, s.state === 'recording' && s.log.at(-1).detail.startsWith(what));
  }
  const { s, c, feed } = rig();
  s.start('warehouse', 124, 0);
  c.remember({ kind: 'scene', requestId: 50, target: 'sparse', timing: 'bar' });
  feed(E.sq, 50, 2, 16);
  s.interrupt('panic');
  feed(E.sc, 50, 5);
  feed(E.sa, 50, 16);
  check('after a Panic, nothing more is kept, even a late applied', s.count === 0 && s.log.at(-1).detail === 'not recording');
  s.clear();
  check('clear: idle, no take, the log keeps the clear', s.state === 'idle' && s.recording() === null && s.count === 0 && s.log.at(-1).detail === 'clear');
  s.record({ status: 'applied', kind: 'scene', requestId: 51, step: 0, payload: { slot: 'full', name: 'Full', timing: 'bar' } });
  check('idle: an applied event is not kept', s.count === 0);
  check('events for unknown requests (patterns, gestures) are ignored', r.fromEngine({ kind: 31, requestId: 999, a: 0, b: 0 }, c, (x) => x, 0) === null);
}

// The cap.
{
  const s = new r.RecordingSession(5, 8);
  s.start('warehouse', 124, 0);
  for (let i = 1; i <= 7; i += 1) {
    s.record({ status: 'applied', kind: 'scene', requestId: i, step: i, serial: 1000 + i, payload: { slot: 'full', name: 'Full', timing: 'beat' } });
  }
  const doc = s.recording();
  check('the cap keeps the first N and stops the take, truncated', doc.events.length === 5 && s.state === 'stopped' && doc.stoppedBy === 'cap' && doc.truncated);
  check('the log is bounded too, newest kept', s.log.length === 8 && s.log.at(-1).n > 8);
  check('the default cap is 10,000 and the schema agrees', r.MAX_EVENTS === 10000 && schema.properties.events.maxItems === 10000);
  check('a capped take validates', valid(doc).length === 0, valid(doc).join('; '));
}

// The validator itself refuses what it should.
{
  const head = { format: 'bckgrnd-msc/performance', version: 2, track: 't', bpm: 120, stepsPerBar: 16, recordedAt: AT, startedAtStep: 0, stoppedBy: null, truncated: false };
  const scene = { seq: 1, kind: 'scene', requestId: 1, step: 0, bar: 1, beat: 1, sixteenth: 1, onset: 0, pass: 1, slot: 'full', name: 'Full', timing: 'bar', crash: false };
  check('the schema takes a good v2 document', valid({ ...head, events: [scene] }).length === 0, valid({ ...head, events: [scene] }).join('; '));
  for (const kind of r.RESERVED_KINDS) {
    check(`the schema refuses the reserved kind ${kind}`, valid({ ...head, events: [{ ...scene, kind }] }).length > 0);
  }
  check('repeat is no longer reserved', !r.RESERVED_KINDS.includes('repeat') && !schema.$defs.reservedKinds.enum.includes('repeat'));
  check('the schema refuses a step past the song', valid({ ...head, events: [{ ...scene, step: 256, bar: 17 }] }).length > 0);
  check('the schema refuses an event with no onset', valid({ ...head, events: [without(scene, 'onset')] }).length > 0);
  check('the schema refuses an event with no pass', valid({ ...head, events: [without(scene, 'pass')] }).length > 0);
  check('the schema refuses a v1 header', valid({ ...head, version: 1, events: [] }).length > 0);
  check('the schema refuses a newer version', valid({ ...head, version: 3, events: [] }).length > 0);
  check('the schema refuses a fill with no length', valid({ ...head, events: [{ seq: 1, kind: 'fill', requestId: 1, step: 0, bar: 1, beat: 1, sixteenth: 1, onset: 0, pass: 1,
    style: 'busy', phraseBars: 0, link: 'none', outcome: 'played' }] }).length > 0);
  check('the schema refuses a repeat of 1/32', valid({ ...head, events: [{ seq: 1, kind: 'repeat', token: 1, step: 0, bar: 1, beat: 1, sixteenth: 1, onset: 0, pass: 1,
    division: 32, endedBy: 'engine' }] }).length > 0);
}

// ---- v2: Beat Repeat, onsets across song wraps, fill length, export (Night 11). ----
//
// A repeat across the song's wrap: engaged at step 248 (serial 2248), released at step 8
// of the next pass (serial 2264). Then two scenes on step 0 in two passes. The engine
// event kinds 61 (repeat started: token, step, division) and 62 (repeat ended: token,
// step, reason) are Silas's Night 11 interface.
{
  const { s, c, feed, at } = rig();
  at(240);
  s.start('warehouse', 124, 240, AT);
  // A press released before the grid line: logged, never in the take.
  s.record({ status: 'pressed', kind: 'repeat', requestId: 70 });
  s.record({ status: 'released', kind: 'repeat', requestId: 70 });
  check('a repeat released before its grid line is not in the take', s.count === 0);
  check('and the log says why', /before its grid line/.test(s.log.at(-1).detail) && s.log.at(-1).status === 'released', s.log.at(-1).detail);
  c.remember({ kind: 'scene', requestId: 71, target: 'sparse', timing: 'bar' });
  feed(E.sa, 71, 240, 0, 2240);
  s.record({ status: 'pressed', kind: 'repeat', requestId: 72 });
  feed(E.rs, 72, 248, 16, 2248);
  feed(E.re, 72, 8, 0, 2264);
  c.remember({ kind: 'scene', requestId: 73, target: 'drop', timing: 'bar' });
  feed(E.sa, 73, 16, 0, 2272);
  // Two passes later, step 16 again: same song step, a later onset.
  c.remember({ kind: 'scene', requestId: 74, target: 'full', timing: 'bar' });
  feed(E.sa, 74, 16, 0, 2528);
  // A loop: bar 2 again 16 onsets later is a jump, so at least one more pass.
  c.remember({ kind: 'scene', requestId: 75, target: 'sparse', timing: 'bar' });
  feed(E.sa, 75, 16, 0, 2544);
  // A one-beat fill: on beat 4 of its bar.
  c.remember({ kind: 'fill', requestId: 76, style: 'busy', length: 'beat', phrase: 0, link: 'none' });
  feed(E.fs, 76, 28, 0, 2556);
  feed(E.fe, 76, 32, 0, 2560);
  // A Now scene: off grid, at the transport step, onset of its serial.
  at(37);
  c.remember({ kind: 'scene', requestId: 77, target: 'build', timing: 'now' });
  feed(E.sa, 77, -1, 0, 2565);
  s.stop();
  const doc = s.recording();
  const [s1, rep, s2, s3, s4, beat, now] = doc.events;
  check('the repeat is one event: start, division, end, ended by the engine',
    rep.kind === 'repeat' && rep.token === 72 && rep.step === 248 && rep.bar === 16 && rep.beat === 3 && rep.division === 16
      && rep.endedBy === 'engine' && rep.endStep === 8 && rep.reason === 0 && !('requestId' in rep), JSON.stringify(rep));
  check('across the wrap, onsets keep counting: start 8, end 24 (16 steps later)', rep.onset === 8 && rep.endOnset === 24, `${rep.onset} → ${rep.endOnset}`);
  check('the first event is onset 0, pass 1', s1.onset === 0 && s1.pass === 1);
  check('after the wrap, pass 2', s2.step === 16 && s2.onset === 32 && s2.pass === 2, JSON.stringify(s2));
  check('the same song step two passes on: a later onset and a later pass',
    s3.step === s2.step && s3.onset === s2.onset + 256 && s3.pass === 3 && s3.seq > s2.seq, `${s2.onset}/${s2.pass} then ${s3.onset}/${s3.pass}`);
  check('a loop back to the same step is a new pass, 16 onsets on', s4.step === 16 && s4.onset === s3.onset + 16 && s4.pass === 4, JSON.stringify(s4));
  const ordered = doc.events.every((e, i, all) => i === 0 || e.onset >= all[i - 1].onset);
  check('onsets never go back, in seq order', ordered, doc.events.map((e) => e.onset).join(' '));
  const keys = new Set(doc.events.map((e) => `${e.step}:${e.onset}`));
  check('events on one song step in different passes are distinct', keys.size === doc.events.length);
  check('a beat fill says beat, and sits on beat 4', beat.kind === 'fill' && beat.length === 'beat' && beat.beat === 4 && beat.bar === 2 && beat.endOnset === s4.onset + 16, JSON.stringify(beat));
  check('a Now scene: off grid at the transport step, the onset of its serial, the pass it falls in',
    now.offGrid === true && now.step === 37 && now.onset === 2565 - 2240 && now.pass === 4, JSON.stringify(now));
  check('the take with a repeat across the wrap validates', valid(doc).length === 0, valid(doc).join('; '));

  // The inspector's labels.
  const d = (e) => r.describeEvent(e);
  check('describe: a scene', d(s1).label === 'Scene Sparse' && d(s1).position === 'Bar 16.1 · pass 1', JSON.stringify(d(s1)));
  check('describe: a beat fill', d(beat).label === 'Busy beat' && d(beat).position === 'Bar 2.4 · pass 4', JSON.stringify(d(beat)));
  check('describe: the repeat', d(rep).label === 'Repeat 1/16' && d(rep).position === 'Bar 16.3 · pass 1' && d(rep).detail === 'held 16 steps', JSON.stringify(d(rep)));
  check('describe: the Now scene', d(now).position === 'Bar 3.2.2 · pass 4 · off grid' && d(now).detail === 'now', JSON.stringify(d(now)));
  check('describe: a bar fill is its style, no style is Fill',
    d({ ...beat, length: 'bar' }).label === 'Busy' && d({ ...beat, style: null }).label === 'Beat fill' && d({ ...beat, style: null, length: 'bar' }).label === 'Fill');

  // Export: its own document, and it validates.
  const out = s.exportTake();
  const local = new Date(AT);
  const p2 = (n) => String(n).padStart(2, '0');
  const want = `bckgrnd-take-warehouse-${local.getFullYear()}-${p2(local.getMonth() + 1)}-${p2(local.getDate())}-${p2(local.getHours())}${p2(local.getMinutes())}.json`;
  check('export: the filename names the track and when Record was pressed', out.filename === want, out.filename);
  check('export: the file is a pretty JSON document ending in a newline', out.json.endsWith('}\n') && out.json.includes('\n  "format"'));
  const back = JSON.parse(out.json);
  check('export: it validates against contracts/performance.json', valid(back).length === 0, valid(back).join('; '));
  check('export: it is the take, nothing more', JSON.stringify(back) === JSON.stringify(doc));
  check('export: parseTake reads it back', JSON.stringify(r.parseTake(out.json)) === JSON.stringify(doc));
  const refuses = (text, re) => { try { r.parseTake(text); return false; } catch (e) { return re.test(e.message); } };
  check('parseTake refuses another format', refuses(JSON.stringify({ ...back, format: 'bckgrnd-msc/project' }), /Not a performance take/));
  check('parseTake refuses a newer version', refuses(JSON.stringify({ ...back, version: 3 }), /newer/));
  check('parseTake refuses version 1 (no onsets)', refuses(JSON.stringify({ ...back, version: 1 }), /version 1 take/));
  check('parseTake refuses what is not JSON', refuses('{', /not JSON/));
  check('the filename keeps to safe characters', r.takeFilename('Deep House / Mix 2', AT).startsWith('bckgrnd-take-deep-house-mix-2-'), r.takeFilename('Deep House / Mix 2', AT));
}

// A Fill into with a beat fill: both halves say beat.
{
  const { s, c, feed } = rig();
  s.start('warehouse', 124, 0, AT);
  c.remember({ kind: 'fillInto', requestId: 81, target: 'drop', fillId: 80 });
  r.rememberFill(c, { requestId: 80, kind: 'into', phrase: 0, style: 'simple', length: 'beat', partner: 81 });
  feed(E.fs, 80, 28);
  feed(E.fe, 80, 32);
  feed(E.sa, 81, 32);
  const [f, into] = s.recording().events;
  check('fill into with a beat fill: the fill and its landing say beat', f.length === 'beat' && into.length === 'beat' && into.fillRequestId === 80, JSON.stringify([f, into]));
  check('describe: a Fill into names its scene and the beat fill', r.describeEvent(into).label === 'Fill into Drop' && r.describeEvent(into).detail === 'beat fill');
  check('fill into with a beat fill validates', valid(s.recording()).length === 0, valid(s.recording()).join('; '));
}

// A repeat still held when the take stops: closed at the stop, and says so.
{
  const { s, feed } = rig();
  s.start('warehouse', 124, 0, AT);
  feed(E.rs, 90, 64, 8, 1064);
  const live = s.exportTake();
  check('while recording, a held repeat exports as open, and stoppedBy is null',
    JSON.parse(live.json).events[0].endedBy === 'open' && JSON.parse(live.json).stoppedBy === null && !('endStep' in JSON.parse(live.json).events[0]));
  check('an open take validates too', valid(JSON.parse(live.json)).length === 0, valid(JSON.parse(live.json)).join('; '));
  s.stop('user', 72);
  const [held] = s.recording().events;
  check('take stopped while held: endedBy take, at the stop step, onset counted forward',
    held.endedBy === 'take' && held.endStep === 72 && held.onset === 0 && held.endOnset === 8 && !('reason' in held), JSON.stringify(held));
  feed(E.re, 90, 74, 1, 1074);
  check('the engine end after the stop is logged, not applied', s.recording().events[0].endedBy === 'take' && s.log.at(-1).detail === 'reason 1');
  check('the closed take validates', valid(s.recording()).length === 0, valid(s.recording()).join('; '));
  // A telemetry step that trails the engine (output latency) is no time at all, not a lap.
  const t = rig();
  t.s.start('warehouse', 124, 0, AT);
  t.feed(E.rs, 91, 64, 8, 1064);
  t.s.interrupt('panic', 63);
  const [p] = t.s.recording().events;
  check('a stop step just behind the repeat does not add a lap', p.endedBy === 'take' && p.endStep === 64 && p.endOnset === 0 && t.s.recording().stoppedBy === 'panic', JSON.stringify(p));
}

// The same hold capturing again (a division change): the first capture ends where the next starts.
{
  const { s, feed } = rig();
  s.start('warehouse', 124, 0, AT);
  feed(E.rs, 95, 32, 8, 1032);
  feed(E.rs, 95, 36, 4, 1036);
  feed(E.re, 95, 40, 0, 1040);
  const [a, b] = s.recording().events;
  check('a recapture: two repeats on one token, the first ended by the recapture',
    a.endedBy === 'recapture' && a.endStep === 36 && a.endOnset === 4 && a.division === 8 && b.division === 4 && b.endedBy === 'engine' && b.endOnset === 8 && b.token === a.token,
    JSON.stringify([a, b]));
  check('a recapture validates', valid(s.recording()).length === 0, valid(s.recording()).join('; '));
  check('describe: a recapture says so', r.describeEvent(a).detail === 'held 4 steps · recaptured', r.describeEvent(a).detail);
}

// An engine without serials (before Night 11's ring): steps as v1, no onsets, and the export does not validate.
{
  const s = new r.RecordingSession();
  const c = new r.RequestCatalog();
  s.start('warehouse', 124, 0, AT);
  c.remember({ kind: 'scene', requestId: 1, target: 'full', timing: 'bar' });
  const input = r.fromEngine({ kind: E.sa, requestId: 1, a: 16, b: 0 }, c, (x) => x, 0);
  s.record(input);
  const [e] = s.recording().events;
  check('no serial: the step is kept, no onset or pass is made up', e.step === 16 && !('onset' in e) && !('pass' in e) && !('serial' in input));
  check('no serial: such a take does not validate as v2', valid(s.recording()).length > 0);
  check('no serial: the session will not export it', s.exportTake() === null);
  check('describe: no pass without an onset', r.describeEvent(e).position === 'Bar 2.1');
}

// ---- Night 11B: the state at Record, and opening a take file. ------------------------
{
  const registry = JSON.parse(readFileSync(join(root, 'contracts/parameters.json'), 'utf8'));
  const params = Object.fromEntries(registry.parameters.map((q) => [q.id, q.kind === 'toggle' ? 0 : typeof q.min === 'number' ? q.min : 1]));
  params['transport.bpm'] = 124;
  params['transport.swing'] = 0.12;
  params['performance.loopBars'] = 4;
  const stems = Object.fromEntries(registry.stems.map((id, i) => [id, { volume: 0.5 + i / 20, send: 0.1, muted: id === 'pad', solo: false }]));
  const initial = {
    track: 'warehouse', bpm: 124, swing: 0.12,
    scene: { slot: 'sparse', modified: true },
    mix: { params, stems },
    fill: { style: 'random', length: 'beat' },
    repeatDivision: 16,
    loopBars: 4,
  };
  const schemaParams = Object.keys(schema.$defs.initial.properties.mix.properties.params.properties);
  check('initial: the schema names every contracts/parameters.json parameter, and only those',
    JSON.stringify(schemaParams) === JSON.stringify(registry.parameters.map((q) => q.id)), schemaParams.join(' '));
  check('initial: the schema names every stem and stem parameter',
    JSON.stringify(Object.keys(schema.$defs.initial.properties.mix.properties.stems.properties)) === JSON.stringify(registry.stems)
      && JSON.stringify(Object.keys(schema.$defs.stemSettings.properties)) === JSON.stringify(registry.stemParameters.map((q) => q.id)));
  check('initial: optional for a reader', !schema.required.includes('initial') && 'initial' in schema.properties);

  const { s, c, feed, at } = rig();
  at(0);
  s.start('warehouse', 124, 0, AT, initial);
  initial.bpm = 99; // the take keeps its own copy
  c.remember({ kind: 'scene', requestId: 1, target: 'drop', timing: 'bar' });
  feed(E.sa, 1, 16);
  r.rememberFill(c, { requestId: 2, kind: 'plain', phrase: 0, style: 'busy' });
  feed(E.fs, 2, 32);
  feed(E.fe, 2, 48);
  r.rememberFill(c, { requestId: 3, kind: 'plain', phrase: 0, style: 'simple', length: 'beat' });
  feed(E.fs, 3, 60);
  feed(E.fe, 3, 64);
  feed(E.rs, 9, 64, 8);
  feed(E.re, 9, 72, 0);
  s.stop();
  initial.bpm = 124;
  const doc = s.recording();
  check('initial: written into the take at Start, as given', JSON.stringify(doc.initial) === JSON.stringify(initial), JSON.stringify(doc.initial).slice(0, 120));
  check('initial: the take with its initial state validates', valid(doc).length === 0, valid(doc).join('; '));

  // Round trip: export, then open it again.
  const out = s.exportTake();
  const opened = r.openTakeText(out.json, valid);
  check('open: an export opens', opened.ok === true, opened.error);
  check('open: the same events and the same initial state',
    opened.ok && JSON.stringify(opened.take.events) === JSON.stringify(doc.events) && JSON.stringify(opened.take.initial) === JSON.stringify(doc.initial));
  check('open: the scene, the bar fill, the beat fill and the repeat',
    opened.ok && opened.take.events.map((e) => `${e.kind}${e.length ? `:${e.length}` : ''}`).join(' ') === 'scene fill:bar fill:beat repeat',
    opened.ok ? opened.take.events.map((e) => e.kind).join(' ') : '');
  check('open: a v2 file without initial still opens', r.openTakeText(JSON.stringify((({ initial: _i, ...rest }) => rest)(doc)), valid).ok === true);
  {
    // A parameter or stem added or removed later must not lock older takes out.
    const drift = JSON.parse(out.json);
    delete drift.initial.mix.params['fx.width'];
    drift.initial.mix.params['fx.future'] = 0.5;
    delete drift.initial.mix.stems.arp;
    drift.initial.mix.stems.choir = { volume: 0.5, send: 0, muted: false, solo: false, pan: 0 };
    check('open: a take with a parameter or stem added or removed since still opens', r.openTakeText(JSON.stringify(drift), valid).ok === true, r.openTakeText(JSON.stringify(drift), valid).error);
    check('initial: the recorder writes every parameter and stem',
      JSON.stringify(Object.keys(doc.initial.mix.params)) === JSON.stringify(registry.parameters.map((q) => q.id))
        && JSON.stringify(Object.keys(doc.initial.mix.stems)) === JSON.stringify(registry.stems));
  }

  const bad = (text) => r.openTakeText(text, valid);
  const v1 = bad(JSON.stringify({ ...doc, version: 1 }));
  check('open: refuses a v1 file, in plain English', !v1.ok && /version 1 take/.test(v1.error) && /version 2/.test(v1.error), v1.error);
  const v3 = bad(JSON.stringify({ ...doc, version: 3 }));
  check('open: refuses a newer version', !v3.ok && /newer/.test(v3.error), v3.error);
  const junk = bad('this is not a take');
  check('open: refuses garbage', !junk.ok && /not JSON/.test(junk.error), junk.error);
  const project = bad(JSON.stringify({ format: 'bckgrnd-msc/project', version: 4 }));
  check('open: refuses a project file', !project.ok && /Not a performance take/.test(project.error), project.error);
  const noOnset = bad(JSON.stringify({ ...doc, events: doc.events.map((e, i) => (i === 1 ? without(e, 'onset') : e)) }));
  check('open: refuses an event with no onset, naming it', !noOnset.ok && /Event 2 has no onset/.test(noOnset.error), noOnset.error);
  const unknown = bad(JSON.stringify({ ...doc, events: [{ ...doc.events[0], kind: 'scratch' }] }));
  check('open: refuses an unknown kind', !unknown.ok && /kind this app does not know \("scratch"\)/.test(unknown.error), unknown.error);
  const reserved = bad(JSON.stringify({ ...doc, events: [{ ...doc.events[0], kind: 'filter' }] }));
  check('open: a reserved kind says it is not recorded yet', !reserved.ok && /filter event/.test(reserved.error), reserved.error);
  const shape = bad(JSON.stringify({ ...doc, initial: { ...doc.initial, repeatDivision: 32 } }));
  check('open: anything else the schema refuses is named', !shape.ok && /take format \(initial\.repeatDivision/.test(shape.error), shape.error);

  check('openedLabel: the file name, or the track and when',
    r.openedLabel(doc, 'my-take.json') === 'my-take.json' && /^warehouse · \d{2}-\d{2}-\d{4} \d{2}:\d{2}$/.test(r.openedLabel(doc)), r.openedLabel(doc));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall recording checks passed');
process.exit(failed ? 1 : 0);
