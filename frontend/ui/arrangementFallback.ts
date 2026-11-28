/**
 * A stand-in for `inst.arrangement` (Night 12) until the model branch (night12/model,
 * frontend/lib/arrangement.ts) merges: the same API, the contract's placement rules
 * (contracts/arrangement.json: a bar fill on a bar line, a beat fill on beat 4, a Rise
 * on a bar line), undo and redo, Save and Open. Used only when the host has no
 * `inst.arrangement`; delete this file at the merge. Never edits the take.
 */

import { useCallback, useMemo, useState } from 'react';
import type { PerformanceRecording } from '../lib/recording';
import { SNAP_STEPS, spanOf, type Arrangement, type ArrangementApi, type ArrangementEvent, type EditResult, type Snap } from './arrangementApi';

const BAR = 16;
const no = (reason: string): EditResult => ({ ok: false, reason });

/** Why an event can't sit where it is, or null. */
function misplaced(e: ArrangementEvent): string | null {
  if (e.at < 0) return 'Before bar 1';
  if (e.kind === 'fill' && e.length === 'bar' && e.at % BAR !== 0) return 'A bar fill starts on a bar line';
  if (e.kind === 'fill' && e.length === 'beat' && e.at % BAR !== 12) return 'A beat fill starts on beat 4';
  if (e.kind === 'rise' && e.at % BAR !== 0) return 'A Rise starts on a bar line';
  return null;
}

function conflictsOf(events: ArrangementEvent[]): { ids: string[]; message: string }[] {
  const out: { ids: string[]; message: string }[] = [];
  const scenes = new Map<number, string[]>();
  for (const e of events) if (e.kind === 'scene' || e.kind === 'rise') scenes.set(e.at, [...(scenes.get(e.at) ?? []), e.id]);
  for (const [at, ids] of scenes) if (ids.length > 1) out.push({ ids, message: `Two scene changes at bar ${Math.floor(at / BAR) + 1}` });
  return out;
}

function fromTakeEvents(take: PerformanceRecording): { events: ArrangementEvent[]; lengthBars: number; notes: string[] } {
  const evs = take.events;
  const onset = (e: { onset?: number }) => e.onset ?? 0;
  const first = evs.reduce((a, b) => (onset(b) < onset(a) ? b : a), evs[0]!);
  const lead = (first.step % BAR) - onset(first);
  const intoOf = new Map<number, string>();
  for (const e of evs) if (e.kind === 'fillInto') intoOf.set(e.fillRequestId, e.slot);
  const events: ArrangementEvent[] = [];
  let n = 0;
  let end = 0;
  const id = () => `e${++n}`;
  for (const e of evs) {
    const at = Math.max(0, onset(e) + lead);
    const endOnset = (e as { endOnset?: number }).endOnset;
    switch (e.kind) {
      case 'scene':
        events.push({ id: id(), kind: 'scene', at, slot: e.slot, crash: e.crash });
        break;
      case 'fill': {
        const into = intoOf.get(e.requestId);
        events.push({ id: id(), kind: 'fill', at, style: e.style, length: e.length, ...(into ? { into } : {}) });
        break;
      }
      case 'rise':
        events.push({ id: id(), kind: 'rise', at, slot: e.slot, bars: e.bars, withFill: e.withFill, crash: e.crash });
        break;
      case 'repeat':
        events.push({ id: id(), kind: 'repeat', at, division: e.division, length: Math.max(1, (endOnset ?? onset(e) + 4) - onset(e)) });
        break;
      default:
        break;
    }
    const last = events[events.length - 1];
    if (last) end = Math.max(end, last.at + spanOf(last) + 1);
  }
  const folded = evs.filter((e) => e.kind === 'fillInto').length;
  return {
    events,
    lengthBars: Math.max(1, Math.ceil(end / BAR)),
    notes: [`${events.length} events from the take`, ...(folded ? [`${folded} Fill into folded into its fill`] : [])],
  };
}

type Doc = { a: Arrangement; past: Arrangement[]; future: Arrangement[]; dirty: boolean; notes: string[] };

export function useArrangementFallback(read: () => PerformanceRecording | null): ArrangementApi {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [snap, setSnap] = useState<Snap>('beat');

  const commit = useCallback((next: Arrangement): EditResult => {
    for (const e of next.events) {
      const why = misplaced(e);
      if (why) return no(why);
    }
    const end = Math.max(0, ...next.events.map((e) => e.at + spanOf(e) + 1));
    const a = { ...next, lengthBars: Math.max(next.lengthBars, Math.ceil(end / BAR)) };
    setDoc((d) => (d ? { ...d, a, past: [...d.past, d.a].slice(-100), future: [], dirty: true } : d));
    return { ok: true };
  }, []);

  const edit = useCallback(
    (fn: (events: ArrangementEvent[]) => ArrangementEvent[] | string, id?: string): EditResult => {
      if (!doc) return no('No arrangement: arrange a take first');
      const out = fn(doc.a.events.map((e) => ({ ...e })));
      if (typeof out === 'string') return no(out);
      const r = commit({ ...doc.a, events: out });
      return r.ok && id ? { ok: true, id } : r;
    },
    [doc, commit],
  );

  const nextId = useCallback(() => {
    const used = new Set(doc?.a.events.map((e) => e.id));
    let i = (doc?.a.events.length ?? 0) + 1;
    while (used.has(`e${i}`)) i += 1;
    return `e${i}`;
  }, [doc]);

  return useMemo<ArrangementApi>(
    () => ({
      working: doc?.a ?? null,
      dirty: doc?.dirty ?? false,
      conflicts: doc ? conflictsOf(doc.a.events) : [],
      notes: doc?.notes ?? [],
      canUndo: Boolean(doc?.past.length),
      canRedo: Boolean(doc?.future.length),
      snap,
      setSnap,
      fromTake: () => {
        const take = read();
        if (!take || take.events.length === 0) return no('No take to arrange');
        const { events, lengthBars, notes } = fromTakeEvents(take);
        setDoc({
          a: { track: take.track, bpm: take.bpm, lengthBars, source: { track: take.track, recordedAt: (take as { recordedAt?: string }).recordedAt ?? '', events: take.events.length }, events },
          past: [],
          future: [],
          dirty: false,
          notes,
        });
        return { ok: true };
      },
      startEmpty: () => {
        setDoc({ a: { track: '', bpm: 120, lengthBars: 8, source: null, events: [] }, past: [], future: [], dirty: false, notes: [] });
        return { ok: true };
      },
      move: (id, at) => edit((es) => {
        const e = es.find((x) => x.id === id);
        if (!e) return 'No such event';
        e.at = at;
        return es;
      }, id),
      nudge: (id, dir, by) => edit((es) => {
        const e = es.find((x) => x.id === id);
        if (!e) return 'No such event';
        e.at += dir * SNAP_STEPS[by ?? snap];
        return es;
      }, id),
      remove: (id) => edit((es) => (es.some((e) => e.id === id) ? es.filter((e) => e.id !== id) : 'No such event')),
      duplicate: (id) => {
        const nid = nextId();
        return edit((es) => {
          const e = es.find((x) => x.id === id);
          if (!e) return 'No such event';
          return [...es, { ...e, id: nid, at: e.at + Math.max(BAR, spanOf(e)) }];
        }, nid);
      },
      insert: (kind, at, props) => {
        const nid = nextId();
        const bar = Math.floor(at / BAR) * BAR;
        const e: ArrangementEvent = kind === 'scene'
          ? { id: nid, kind: 'scene', at, slot: 'full', crash: false, ...(props ?? {}) } as ArrangementEvent
          : { id: nid, kind: 'fill', at: bar, style: 'classic', length: 'bar', ...(props ?? {}) } as ArrangementEvent;
        return edit((es) => [...es, e], nid);
      },
      update: (id, props) => edit((es) => {
        const e = es.find((x) => x.id === id);
        if (!e) return 'No such event';
        Object.assign(e, props);
        if (e.kind === 'fill' && e.into === null) delete e.into;
        return es;
      }, id),
      undo: () => {
        if (!doc?.past.length) return no('Nothing to undo');
        setDoc({ ...doc, a: doc.past[doc.past.length - 1]!, past: doc.past.slice(0, -1), future: [doc.a, ...doc.future], dirty: true });
        return { ok: true };
      },
      redo: () => {
        if (!doc?.future.length) return no('Nothing to redo');
        setDoc({ ...doc, a: doc.future[0]!, past: [...doc.past, doc.a], future: doc.future.slice(1), dirty: true });
        return { ok: true };
      },
      save: () => {
        if (!doc) return no('No arrangement to save');
        const json = `${JSON.stringify({ format: 'bckgrnd-msc/arrangement', version: 1, stepsPerBar: 16, ...doc.a }, null, 2)}\n`;
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `bckgrnd-arrangement-${(doc.a.track || 'empty').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setDoc({ ...doc, dirty: false });
        return { ok: true };
      },
      open: (text) => {
        let d: Partial<Arrangement> & { format?: string };
        try {
          d = JSON.parse(text);
        } catch {
          return no('Not an arrangement file: not JSON');
        }
        if (d.format !== 'bckgrnd-msc/arrangement' || !Array.isArray(d.events)) return no('Not an arrangement file');
        setDoc({ a: { track: d.track ?? '', bpm: d.bpm ?? 120, lengthBars: d.lengthBars ?? 1, source: d.source ?? null, events: d.events }, past: [], future: [], dirty: false, notes: [] });
        return { ok: true };
      },
      close: () => setDoc(null),
    }),
    [doc, snap, read, edit, nextId],
  );
}
