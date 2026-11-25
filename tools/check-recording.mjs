/**
 * The performance recording (frontend/lib/recording.ts), checked without a browser.
 *
 * Pins the rules a take must keep (docs/PERFORMANCE_EVENTS.md): positions come from
 * engine steps, events keep the engine's order, only applied actions are kept, a
 * cancel or a replace never is, interruptions end the take (or not) as documented,
 * the cap holds, and every take validates against contracts/performance.json.
 *
 * Usage: node tools/check-recording.mjs
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ---- A JSON Schema subset validator: what contracts/performance.json uses. ---------
function resolveRef(ref) {
  return ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], schema);
}
function typeOk(t, v) {
  if (t === 'null') return v === null;
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}
function validate(node, v, path = '$') {
  if (node.$ref) return validate(resolveRef(node.$ref), v, path);
  const errors = [];
  if (node.oneOf) {
    const passing = node.oneOf.filter((n) => validate(n, v, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf`);
    return errors;
  }
  if ('const' in node && v !== node.const) errors.push(`${path}: not ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(v)) errors.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if (node.type && ![].concat(node.type).some((t) => typeOk(t, v))) errors.push(`${path}: not ${node.type}`);
  if (typeof v === 'number') {
    if (node.minimum !== undefined && v < node.minimum) errors.push(`${path}: below ${node.minimum}`);
    if (node.maximum !== undefined && v > node.maximum) errors.push(`${path}: above ${node.maximum}`);
  }
  if (Array.isArray(v)) {
    if (node.maxItems !== undefined && v.length > node.maxItems) errors.push(`${path}: over ${node.maxItems} items`);
    if (node.items) v.forEach((x, i) => errors.push(...validate(node.items, x, `${path}[${i}]`)));
  }
  if (typeOk('object', v)) {
    for (const k of node.required ?? []) if (!(k in v)) errors.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      if (node.properties?.[k]) errors.push(...validate(node.properties[k], x, `${path}.${k}`));
      else if (node.additionalProperties === false) errors.push(`${path}: unexpected ${k}`);
    }
  }
  return errors;
}
const valid = (doc) => validate(schema, doc);

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
function rig() {
  const s = new r.RecordingSession();
  const c = new r.RequestCatalog();
  let transport = -1;
  const feed = (kind, requestId, a = 0, b = 0) => {
    const input = r.fromEngine({ kind, requestId, a, b }, c, (slot) => names[slot] ?? slot, transport);
    if (input) s.record(input);
  };
  return { s, c, feed, at: (step) => { transport = step; } };
}
const E = { sq: 1, sa: 2, sc: 3, sr: 4, sj: 5, fq: 11, fs: 12, fe: 13, fc: 14, bq: 41, ba: 42, bc: 43, bs: 46, fu: 52, acc: 53 };

// A small performance: a scene on the next bar, a fill, a Rise with a fill, a cancel, a replace.
{
  const { s, c, feed, at } = rig();
  at(10);
  s.start('warehouse', 124, 10);
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
  check('the header: format, version, track, bpm, 16 steps a bar, start step',
    doc.format === 'bckgrnd-msc/performance' && doc.version === 1 && doc.track === 'warehouse' && doc.bpm === 124 && doc.stepsPerBar === 16 && doc.startedAtStep === 10 && doc.stoppedBy === 'user');
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
    s.record({ status: 'applied', kind: 'scene', requestId: i, step: i, payload: { slot: 'full', name: 'Full', timing: 'beat' } });
  }
  const doc = s.recording();
  check('the cap keeps the first N and stops the take, truncated', doc.events.length === 5 && s.state === 'stopped' && doc.stoppedBy === 'cap' && doc.truncated);
  check('the log is bounded too, newest kept', s.log.length === 8 && s.log.at(-1).n > 8);
  check('the default cap is 10,000 and the schema agrees', r.MAX_EVENTS === 10000 && schema.properties.events.maxItems === 10000);
  check('a capped take validates', valid(doc).length === 0, valid(doc).join('; '));
}

// The validator itself refuses what it should.
{
  const bad = { format: 'bckgrnd-msc/performance', version: 1, track: 't', bpm: 120, stepsPerBar: 16, startedAtStep: 0, stoppedBy: null, truncated: false,
    events: [{ seq: 1, kind: 'repeat', requestId: 1, step: 0, bar: 1, beat: 1, sixteenth: 1 }] };
  check('the schema refuses a reserved kind in v1', valid(bad).length > 0);
  check('the schema refuses a step past the song', valid({ ...bad, events: [{ seq: 1, kind: 'scene', requestId: 1, step: 256, bar: 17, beat: 1, sixteenth: 1, slot: 'full', name: 'Full', timing: 'bar', crash: false }] }).length > 0);
  check('the schema refuses a newer version', valid({ ...bad, version: 2, events: [] }).length > 0);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall recording checks passed');
process.exit(failed ? 1 : 0);
