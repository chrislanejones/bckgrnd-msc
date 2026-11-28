/**
 * The working arrangement (Night 12, docs/ARRANGEMENT.md, contracts/arrangement.json).
 *
 * An arrangement is a new document made from a performance take, or started empty. It
 * is never the take (which stays exactly as recorded) and never part of a project.
 * Positions are `at`, steps from the arrangement's start (bar 1 beat 1 is 0), and never
 * wrap. Linked pairs are folded into one event, so an orphan can't exist: a Fill into
 * is a `fill` with `into`, a Rise + Fill is a `rise` with `withFill`, and a Beat Repeat
 * (start and end, and any recaptures) is one `repeat` span.
 *
 * Pure: no React, no engine, no audio. `ArrangementEditor` holds immutable snapshots
 * with undo and redo; every edit that would add a conflict is refused, so the working
 * arrangement never gets worse. The host (`inst.arrangement`) wraps one editor.
 *
 * ## For the editor UI
 *
 * | Name | What it is |
 * |---|---|
 * | `inst.arrangement.working` | The `Arrangement`, or null. Read only: a new object after every change |
 * | `.dirty`, `.conflicts`, `.notes`, `.canUndo`, `.canRedo`, `.snap`, `.selected` | Reactive state |
 * | `.setSnap(s)`, `.select(id)` | The snap preference (`bckgrnd-msc:arrangement-snap`), the selection |
 * | `.fromTake()`, `.startEmpty()`, `.open(text, filename?)`, `.close()` | Make, open or close one |
 * | `.move(id, at)`, `.nudge(id, dir, by?)`, `.remove(id)`, `.duplicate(id)`, `.insert(kind, at, props?)`, `.update(id, props)` | Edits: `Result` |
 * | `.undo()`, `.redo()` | History, 200 steps, selection included |
 * | `.save()`, `.exportArrangement()` | Download, or `{ filename, json }` |
 *
 * Helpers for drawing: `spanOf(e)` (the steps an event occupies), `landingOf(e)` (where
 * its scene lands), `sceneChanges(a)`, `describeArrangementEvent(e)`, `placeLabel(at)`.
 */

import arrangementSchema from '../../contracts/arrangement.json';
import { openTakeText, type InitialState, type PerformanceEvent, type PerformanceRecording, type TakeExport } from './recording';
import { schemaValidator, validateTake } from './take-schema';

export const ARRANGEMENT_FORMAT = 'bckgrnd-msc/arrangement';
export const ARRANGEMENT_VERSION = 1;
export const STEPS_PER_BAR = 16;
/** Undo keeps this many steps. */
export const HISTORY_LIMIT = 200;
/** An empty arrangement's length. */
export const DEFAULT_BARS = 16;
export const MAX_BARS = 1024;
/** Bars a take's arrangement gets past the take's own end, so there is room to add. */
export const HEADROOM_BARS = 4;

export const SCENE_SLOTS = ['full', 'sparse', 'build', 'drop'] as const;
export type SceneSlot = (typeof SCENE_SLOTS)[number];
export type FillLength = 'bar' | 'beat';
export type RiseBars = 2 | 4 | 8;
export type RepeatDivision = 4 | 8 | 16;

export type Snap = 'bar' | 'beat' | 'sixteenth';
export const SNAPS: readonly Snap[] = ['bar', 'beat', 'sixteenth'];
export const SNAP_STEPS: Record<Snap, number> = { bar: 16, beat: 4, sixteenth: 1 };
export const DEFAULT_SNAP: Snap = 'bar';
export const SNAP_PREF = 'bckgrnd-msc:arrangement-snap';

// ---- The document -------------------------------------------------------------------

type Base = {
  /** Stable within the arrangement, and unique. */
  id: string;
  /** Steps from the arrangement's start: bar 1 beat 1 is 0. Never wraps. */
  at: number;
};

/** A scene change at `at`, on any sixteenth. */
export type SceneEvent = Base & { kind: 'scene'; slot: SceneSlot; crash: boolean };

/**
 * A fill from `at`: a bar line for a bar fill (16 steps), beat 4 of its bar (bar line +
 * 12) for a beat fill (4 steps). With `into` it is a Fill into: the scene lands on the
 * next bar line, with `crash` its accent.
 */
export type FillEvent = Base & { kind: 'fill'; style: string | null; length: FillLength; into?: SceneSlot; crash?: boolean };

/** A Rise from a bar line, landing `slot` at `at + bars * 16`. With Fill, its fill plays the last bar. */
export type RiseEvent = Base & { kind: 'rise'; slot: SceneSlot; bars: RiseBars; withFill: boolean; crash: boolean };

/** A Beat Repeat held from `at` (on its division's grid) for `length` steps. */
export type RepeatEvent = Base & { kind: 'repeat'; division: RepeatDivision; length: number };

export type ArrangementEvent = SceneEvent | FillEvent | RiseEvent | RepeatEvent;
export type ArrangementKind = ArrangementEvent['kind'];

/** The take an arrangement came from. */
export type ArrangementSource = { track: string; recordedAt: string; events: number };

export type Arrangement = {
  format: typeof ARRANGEMENT_FORMAT;
  version: typeof ARRANGEMENT_VERSION;
  track: string;
  bpm: number;
  stepsPerBar: typeof STEPS_PER_BAR;
  /** Every event and landing sits before `lengthBars * 16`. */
  lengthBars: number;
  /** The take it came from, or null for one started empty. */
  source: ArrangementSource | null;
  /** The state at Record, copied from the take when it had one. */
  initial?: InitialState;
  /** ISO 8601 UTC. A label; never a position. */
  createdAt: string;
  /** Sorted by `at`. */
  events: ArrangementEvent[];
};

export type Conflict = { ids: string[]; message: string };
export type Result = { ok: true; id?: string } | { ok: false; reason: string };

// ---- Geometry -------------------------------------------------------------------------

const KIND_ORDER: Record<ArrangementKind, number> = { rise: 0, fill: 1, scene: 2, repeat: 3 };

/** The finest place an event of this kind can start: every `step` steps, from `offset`. */
export function kindGrid(e: Pick<ArrangementEvent, 'kind'> & { length?: unknown; division?: unknown }): { step: number; offset: number } {
  switch (e.kind) {
    case 'scene':
      return { step: 1, offset: 0 };
    case 'fill':
      return { step: STEPS_PER_BAR, offset: e.length === 'beat' ? 12 : 0 };
    case 'rise':
      return { step: STEPS_PER_BAR, offset: 0 };
    case 'repeat':
      return { step: STEPS_PER_BAR / (e.division as RepeatDivision), offset: 0 };
  }
}

/** The grid an event moves on: the coarser of the snap and its own. */
export function effectiveGrid(e: Pick<ArrangementEvent, 'kind'> & { length?: unknown; division?: unknown }, snap: Snap): { step: number; offset: number } {
  const own = kindGrid(e);
  return { step: Math.max(own.step, SNAP_STEPS[snap]), offset: own.offset };
}

/** `at` moved to the nearest place on the event's effective grid, never before its first. */
export function snapAt(e: Pick<ArrangementEvent, 'kind'> & { length?: unknown; division?: unknown }, at: number, snap: Snap): number {
  const g = effectiveGrid(e, snap);
  return Math.max(g.offset, Math.round((at - g.offset) / g.step) * g.step + g.offset);
}

/** Whether `at` is on the event's own grid. */
export function onGrid(e: ArrangementEvent): boolean {
  const g = kindGrid(e);
  return Number.isInteger(e.at) && e.at >= g.offset && (e.at - g.offset) % g.step === 0;
}

const fillSteps = (length: FillLength) => (length === 'beat' ? 4 : STEPS_PER_BAR);

/** The steps an event occupies, `[start, end)`. A scene change occupies its one step. */
export function spanOf(e: ArrangementEvent): [number, number] {
  switch (e.kind) {
    case 'scene':
      return [e.at, e.at + 1];
    case 'fill':
      return [e.at, e.at + fillSteps(e.length)];
    case 'rise':
      return [e.at, e.at + e.bars * STEPS_PER_BAR];
    case 'repeat':
      return [e.at, e.at + e.length];
  }
}

/** Where an event changes the scene: a scene's `at`, a Fill into's next bar line, a Rise's landing. Null otherwise. */
export function landingOf(e: ArrangementEvent): number | null {
  if (e.kind === 'scene') return e.at;
  if (e.kind === 'fill') return e.into ? (Math.floor(e.at / STEPS_PER_BAR) + 1) * STEPS_PER_BAR : null;
  if (e.kind === 'rise') return e.at + e.bars * STEPS_PER_BAR;
  return null;
}

/** The fill part of an event: a fill's own span, or a Rise + Fill's last bar. */
function fillSpanOf(e: ArrangementEvent): [number, number] | null {
  if (e.kind === 'fill') return spanOf(e);
  if (e.kind === 'rise' && e.withFill) return [e.at + (e.bars - 1) * STEPS_PER_BAR, e.at + e.bars * STEPS_PER_BAR];
  return null;
}

/** The last step an event needs, exclusive: its span, or one past its landing. */
function needs(e: ArrangementEvent): number {
  const landing = landingOf(e);
  return Math.max(spanOf(e)[1], landing === null ? 0 : landing + 1);
}

export type SceneChange = { at: number; id: string; slot: SceneSlot; via: ArrangementKind };

/** Every scene change, in time: scenes, Fill into landings and Rise landings. */
export function sceneChanges(a: Arrangement): SceneChange[] {
  const out: SceneChange[] = [];
  for (const e of a.events) {
    const at = landingOf(e);
    if (at === null) continue;
    const slot = e.kind === 'fill' ? e.into! : (e as SceneEvent | RiseEvent).slot;
    out.push({ at, id: e.id, slot, via: e.kind });
  }
  return out.sort((x, y) => x.at - y.at);
}

// ---- Words ---------------------------------------------------------------------------

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "bar 5.1", or "bar 5.4.3" off a beat. */
export function placeLabel(at: number): string {
  const inBar = ((at % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  const bar = Math.floor(at / STEPS_PER_BAR) + 1;
  const beat = Math.floor(inBar / 4) + 1;
  const six = (inBar % 4) + 1;
  return `bar ${bar}.${beat}${six > 1 ? `.${six}` : ''}`;
}

/** What an event is, in words: "Scene Sparse", "Busy beat fill", "Fill into Drop", "Rise to Drop", "Repeat 1/8". */
export function eventName(e: ArrangementEvent): string {
  switch (e.kind) {
    case 'scene':
      return `Scene ${cap(e.slot)}`;
    case 'fill': {
      const what = `${e.style ? `${cap(e.style)} ` : ''}${e.length === 'beat' ? 'beat ' : ''}fill`;
      return e.into ? `${cap(what)} into ${cap(e.into)}` : cap(what);
    }
    case 'rise':
      return `Rise to ${cap(e.slot)}`;
    case 'repeat':
      return `Repeat 1/${e.division}`;
  }
}

/** For a list or a timeline: `{ label, position, detail }`. */
export function describeArrangementEvent(e: ArrangementEvent): { label: string; position: string; detail: string } {
  const detail =
    e.kind === 'scene' ? (e.crash ? 'crash' : '')
      : e.kind === 'fill' ? (e.into ? `lands ${placeLabel(landingOf(e)!)}${e.crash ? ' · crash' : ''}` : '')
        : e.kind === 'rise' ? [`${e.bars} bars`, e.withFill && 'with fill', `lands ${placeLabel(landingOf(e)!)}`, e.crash && 'crash'].filter(Boolean).join(' · ')
          : `${e.length} step${e.length === 1 ? '' : 's'}`;
  return { label: eventName(e), position: cap(placeLabel(e.at)), detail };
}

const named = (e: ArrangementEvent) => `${eventName(e)} at ${placeLabel(e.at)}`;
const changeName = (a: Arrangement, c: SceneChange) => {
  const e = a.events.find((x) => x.id === c.id)!;
  return c.via === 'scene' ? eventName(e) : c.via === 'fill' ? `the ${eventName(e)} landing` : `the ${eventName(e)} landing`;
};
const overlaps = (x: [number, number], y: [number, number]) => x[0] < y[1] && y[0] < x[1];

// ---- Validation -----------------------------------------------------------------------

/**
 * Every conflict, in plain English. An empty list is a valid arrangement. The editor
 * refuses an edit that adds one; an opened file keeps its conflicts, listed.
 */
export function validate(a: Arrangement): Conflict[] {
  const out: Conflict[] = [];
  const end = a.lengthBars * STEPS_PER_BAR;
  const bars = `${a.lengthBars} bar${a.lengthBars === 1 ? '' : 's'}`;
  const seen = new Map<string, number>();
  for (const e of a.events) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
  for (const [id, n] of seen) if (n > 1) out.push({ ids: [id], message: `${n} events share the id ${id}.` });

  // Each event on its grid, inside the arrangement.
  for (const e of a.events) {
    if (!onGrid(e)) {
      const why = e.kind === 'fill' ? (e.length === 'beat' ? 'a beat fill starts on beat 4 of a bar' : 'a bar fill starts on a bar line')
        : e.kind === 'rise' ? 'a Rise starts on a bar line'
          : e.kind === 'repeat' ? `a 1/${e.division} repeat starts on a 1/${e.division} line`
            : 'it must be on a sixteenth';
      out.push({ ids: [e.id], message: `${named(e)} is off its grid: ${why}.` });
    }
    if (e.at >= end) out.push({ ids: [e.id], message: `${named(e)} is past the end (${bars}).` });
    else if (e.kind !== 'scene' && spanOf(e)[1] > end) out.push({ ids: [e.id], message: `${named(e)} runs past the end (${bars}).` });
    const landing = e.kind === 'scene' ? null : landingOf(e);
    if (landing !== null && landing >= end && e.at < end) {
      out.push({ ids: [e.id], message: `${named(e)} lands at ${placeLabel(landing)}, past the end (${bars}).` });
    }
  }

  // Two scene changes on one step.
  const changes = sceneChanges(a);
  for (let i = 0; i < changes.length; i += 1) {
    let j = i;
    while (j + 1 < changes.length && changes[j + 1]!.at === changes[i]!.at) j += 1;
    if (j > i) {
      const group = changes.slice(i, j + 1);
      out.push({ ids: group.map((c) => c.id), message: `Two scene changes at ${placeLabel(changes[i]!.at)}: ${group.map((c) => changeName(a, c)).join(' and ')}.` });
    }
    i = j;
  }

  const rises = a.events.filter((e): e is RiseEvent => e.kind === 'rise');
  // A scene change inside a Rise, between its start and its landing.
  for (const r of rises) {
    const landing = landingOf(r)!;
    for (const c of changes) {
      if (c.id === r.id || c.at < r.at || c.at >= landing) continue;
      out.push({ ids: [c.id, r.id], message: `${cap(changeName(a, c))} at ${placeLabel(c.at)} falls inside the ${named(r)}, which lands at ${placeLabel(landing)}.` });
    }
  }
  // Overlapping Rises.
  for (let i = 0; i < rises.length; i += 1) {
    for (let j = i + 1; j < rises.length; j += 1) {
      if (overlaps(spanOf(rises[i]!), spanOf(rises[j]!))) {
        out.push({ ids: [rises[i]!.id, rises[j]!.id], message: `The ${named(rises[i]!)} and the ${named(rises[j]!)} overlap.` });
      }
    }
  }
  // Overlapping fills, a Rise + Fill's last bar included.
  const fills = a.events.flatMap((e) => {
    const span = fillSpanOf(e);
    return span ? [{ e, span }] : [];
  });
  for (let i = 0; i < fills.length; i += 1) {
    for (let j = i + 1; j < fills.length; j += 1) {
      if (!overlaps(fills[i]!.span, fills[j]!.span)) continue;
      const word = (f: { e: ArrangementEvent }) => (f.e.kind === 'rise' ? `the fill of the ${named(f.e)}` : `the ${named(f.e)}`);
      out.push({ ids: [fills[i]!.e.id, fills[j]!.e.id], message: `${cap(word(fills[i]!))} and ${word(fills[j]!)} overlap: one fill plays at a time.` });
    }
  }
  // Overlapping repeats.
  const repeats = a.events.filter((e): e is RepeatEvent => e.kind === 'repeat');
  for (let i = 0; i < repeats.length; i += 1) {
    for (let j = i + 1; j < repeats.length; j += 1) {
      if (overlaps(spanOf(repeats[i]!), spanOf(repeats[j]!))) {
        out.push({ ids: [repeats[i]!.id, repeats[j]!.id], message: `The ${named(repeats[i]!)} and the ${named(repeats[j]!)} overlap.` });
      }
    }
  }
  return out;
}

const conflictKey = (c: Conflict) => `${[...c.ids].sort().join(',')}|${c.message}`;

/** The conflicts `next` has that `before` did not: what an edit would add. */
function added(before: Arrangement, next: Arrangement): Conflict[] {
  const had = new Set(validate(before).map(conflictKey));
  return validate(next).filter((c) => !had.has(conflictKey(c)));
}

// ---- Making one -----------------------------------------------------------------------

const sortEvents = (events: ArrangementEvent[]) =>
  [...events].sort((x, y) => x.at - y.at || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

/** An empty arrangement for a track. */
export function emptyArrangement(track: string, bpm: number, opts: { lengthBars?: number; initial?: InitialState; now?: Date } = {}): Arrangement {
  return {
    format: ARRANGEMENT_FORMAT,
    version: ARRANGEMENT_VERSION,
    track,
    bpm,
    stepsPerBar: STEPS_PER_BAR,
    lengthBars: opts.lengthBars ?? DEFAULT_BARS,
    source: null,
    ...(opts.initial ? { initial: structuredClone(opts.initial) } : {}),
    createdAt: (opts.now ?? new Date()).toISOString(),
    events: [],
  };
}

const onsetOf = (e: PerformanceEvent) => (e as { onset?: number }).onset ?? 0;
const isSlot = (s: unknown): s is SceneSlot => typeof s === 'string' && (SCENE_SLOTS as readonly string[]).includes(s);
const asBars = (n: number): RiseBars => (n === 2 || n === 4 || n === 8 ? n : n < 3 ? 2 : n < 6 ? 4 : 8);
const asDivision = (n: number): RepeatDivision => (n === 4 || n === 16 ? n : 8);

/** An event before it has an id (Omit, one kind at a time). */
type Unplaced = ArrangementEvent extends infer E ? (E extends ArrangementEvent ? Omit<E, 'id'> : never) : never;

export type Converted = { arrangement: Arrangement; notes: string[] };

/**
 * A take as an arrangement, keeping what was heard. Bar 1 is the bar line of the first
 * event's song bar, as the timeline draws it: `at = onset + (first.step % 16) - first.onset`.
 *
 * - A scene, a fill and a Rise keep their start; a fill cut short is kept whole.
 * - A Fill into (its fill and its landing) becomes one fill with `into`. A landing
 *   without its fill becomes a scene.
 * - A Rise's own fill folds into the Rise (`withFill`).
 * - A Rise canceled or replaced mid-rise is left out: the take has no step for where it
 *   was cut. It is named in the notes.
 * - A repeat recaptured on the same hold is one span from its first start to its last end.
 * - Anything off its grid (a cue or seek moved the bar lines) snaps to the nearest place.
 *
 * `notes` says what changed, in plain English, for the UI to show.
 */
export function fromTake(take: PerformanceRecording, opts: { now?: Date } = {}): Converted {
  const notes: string[] = [];
  const events = [...take.events].sort((x, y) => x.seq - y.seq);
  const base = emptyArrangement(take.track, take.initial?.bpm ?? take.bpm, { initial: take.initial, now: opts.now });
  base.source = { track: take.track, recordedAt: take.recordedAt, events: take.events.length };
  if (events.length === 0) {
    notes.push('The take has no events: the arrangement starts empty.');
    return { arrangement: base, notes };
  }
  const first = events.reduce((x, y) => (onsetOf(y) < onsetOf(x) ? y : x));
  const lead = (((first.step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR) - onsetOf(first);
  const x = (onset: number) => onset + lead;
  let takeEnd = 0;
  for (const e of events) {
    const endOnset = (e as { endOnset?: number }).endOnset;
    takeEnd = Math.max(takeEnd, x(onsetOf(e)) + 1, endOnset !== undefined ? x(endOnset) : 0);
  }

  const out: Unplaced[] = [];
  const intoByFill = new Map<number, Extract<PerformanceEvent, { kind: 'fillInto' }>>();
  for (const e of events) if (e.kind === 'fillInto') intoByFill.set(e.fillRequestId, e);
  const fillIds = new Set(events.filter((e) => e.kind === 'fill').map((e) => (e as { requestId: number }).requestId));
  const bar = (at: number) => placeLabel(at);

  // Repeats: chain recaptures on one token into one span.
  const chains: Extract<PerformanceEvent, { kind: 'repeat' }>[][] = [];
  const openChain = new Map<number, Extract<PerformanceEvent, { kind: 'repeat' }>[]>();
  for (const e of events) {
    if (e.kind !== 'repeat') continue;
    const chain = openChain.get(e.token);
    if (chain) chain.push(e);
    else chains.push([e]);
    const current = chain ?? chains.at(-1)!;
    if (e.endedBy === 'recapture') openChain.set(e.token, current);
    else openChain.delete(e.token);
  }

  for (const e of events) {
    const at = x(onsetOf(e));
    switch (e.kind) {
      case 'scene':
        if (!isSlot(e.slot)) {
          notes.push(`A scene at ${bar(at)} names an unknown slot (${e.slot}); left out.`);
          break;
        }
        out.push({ kind: 'scene', at, slot: e.slot, crash: e.crash });
        break;
      case 'fill': {
        if (e.link === 'rise') break; // part of its Rise
        const into = intoByFill.get(e.requestId);
        const length: FillLength = e.length === 'beat' ? 'beat' : 'bar';
        if (e.outcome === 'cutShort') notes.push(`The ${eventName({ id: '', kind: 'fill', at, style: e.style, length })} at ${bar(at)} was cut short in the take; it is kept whole.`);
        if (into && isSlot(into.slot)) {
          out.push({ kind: 'fill', at, style: e.style, length, into: into.slot, crash: into.crash });
        } else {
          out.push({ kind: 'fill', at, style: e.style, length });
        }
        break;
      }
      case 'fillInto':
        if (!fillIds.has(e.fillRequestId) && isSlot(e.slot)) {
          out.push({ kind: 'scene', at, slot: e.slot, crash: e.crash });
          notes.push(`The Fill into ${cap(e.slot)} at ${bar(at)} has no fill in the take; kept as a scene change.`);
        }
        break;
      case 'rise':
        if (e.outcome === 'cancelled' || e.outcome === 'replaced') {
          notes.push(`The Rise to ${cap(e.slot)} at ${bar(at)} was ${e.outcome === 'cancelled' ? 'canceled' : 'replaced'} mid-rise; left out, because the take doesn't say where it stopped.`);
          break;
        }
        if (!isSlot(e.slot)) break;
        if (e.outcome === 'open') notes.push(`The take stopped during the Rise to ${cap(e.slot)} at ${bar(at)}; kept as asked, landing after the take.`);
        out.push({ kind: 'rise', at, slot: e.slot, bars: asBars(e.bars), withFill: e.withFill, crash: e.crash });
        break;
      default:
        break;
    }
  }
  for (const chain of chains) {
    const head = chain[0]!;
    const tail = chain.at(-1)!;
    const at = x(head.onset ?? 0);
    const end = tail.endOnset !== undefined ? x(tail.endOnset) : takeEnd;
    const divisions = [...new Set(chain.map((r) => r.division))];
    if (divisions.length > 1) notes.push(`The repeat at ${bar(at)} changed division while held (${divisions.map((d) => `1/${d}`).join(' then ')}); kept as one 1/${head.division} span.`);
    else if (chain.length > 1) notes.push(`The repeat at ${bar(at)} was captured ${chain.length} times on one hold; kept as one span.`);
    out.push({ kind: 'repeat', at, division: asDivision(head.division), length: Math.max(1, end - at) });
  }

  // Snap anything a cue or seek moved off its grid, and fix the length.
  const placed: ArrangementEvent[] = sortEvents(out.map((e, i) => ({ ...e, id: `t${i}` }) as ArrangementEvent)).map((e, i) => ({ ...e, id: `e${i + 1}` }));
  for (const e of placed) {
    if (onGrid(e) && e.at >= 0) continue;
    const to = snapAt(e, e.at, 'sixteenth');
    notes.push(`The ${eventName(e)} at ${bar(e.at)} was off its grid (the take crossed a cue, seek or loop); moved to ${bar(to)}.`);
    e.at = to;
  }
  const last = Math.max(takeEnd, ...placed.map(needs));
  // Room to keep composing past the take: at least DEFAULT_BARS, and HEADROOM_BARS past
  // what it used, rounded up to a 4-bar phrase. A one-scene take is otherwise one bar
  // long, and every nudge or insert past it is refused.
  const used = Math.ceil(last / STEPS_PER_BAR);
  const lengthBars = Math.min(MAX_BARS, Math.max(DEFAULT_BARS, Math.ceil((used + HEADROOM_BARS) / 4) * 4));
  const arrangement: Arrangement = { ...base, lengthBars, events: sortEvents(placed) };
  return { arrangement, notes };
}

// ---- Files ----------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `bckgrnd-arrangement-<track>-<YYYY-MM-DD-HHmm>.json`, local time at `when`. */
export function arrangementFilename(track: string, when: Date = new Date()): string {
  const id = track.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'track';
  const stamp = Number.isNaN(when.getTime())
    ? 'undated'
    : `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}-${pad2(when.getHours())}${pad2(when.getMinutes())}`;
  return `bckgrnd-arrangement-${id}-${stamp}.json`;
}

/** An arrangement as its own file. */
export function exportArrangement(a: Arrangement, when: Date = new Date()): TakeExport {
  return { filename: arrangementFilename(a.track, when), json: `${JSON.stringify(a, null, 2)}\n` };
}

/** contracts/arrangement.json, checked with the same validator as a take. */
export const validateArrangementShape: (doc: unknown) => string[] = schemaValidator(arrangementSchema);

export type Opened = { ok: true; arrangement: Arrangement; notes: string[]; conflicts: Conflict[] } | { ok: false; reason: string };

/**
 * Open a file: an arrangement (version 1), or a take v2, converted with `fromTake`.
 * Refuses a project file, another version and anything else, in plain English. An
 * arrangement with conflicts opens, with them listed.
 */
export function openArrangementText(text: string, opts: { now?: Date } = {}): Opened {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Not an arrangement or a take: not JSON.' };
  }
  const d = doc as { format?: unknown; version?: unknown; events?: unknown } | null;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, reason: 'Not an arrangement or a take.' };
  if (d.format === 'bckgrnd-msc/performance') {
    const take = openTakeText(text, validateTake);
    if (!take.ok) return { ok: false, reason: `This take can't be arranged: ${take.error}` };
    const { arrangement, notes } = fromTake(take.take, opts);
    return { ok: true, arrangement, notes: ['Made from a take file.', ...notes], conflicts: validate(arrangement) };
  }
  if (d.format === 'bckgrnd-msc/project') {
    return { ok: false, reason: 'This is a project file. Open it with Open project; an arrangement is its own file.' };
  }
  if (d.format !== ARRANGEMENT_FORMAT) return { ok: false, reason: 'Not an arrangement or a take.' };
  if (typeof d.version !== 'number' || !Number.isInteger(d.version)) return { ok: false, reason: 'This arrangement has no version.' };
  if (d.version > ARRANGEMENT_VERSION) {
    return { ok: false, reason: `This arrangement is version ${d.version}, newer than this app reads (${ARRANGEMENT_VERSION}).` };
  }
  if (d.version < ARRANGEMENT_VERSION) return { ok: false, reason: `This arrangement is version ${d.version}; this app reads version ${ARRANGEMENT_VERSION}.` };
  const errors = validateArrangementShape(doc);
  if (errors.length > 0) {
    const first = errors[0]!.replace(/^\$\.?/, '') || 'the document';
    return { ok: false, reason: `This arrangement doesn't match the arrangement format (${first}${errors.length > 1 ? `, and ${errors.length - 1} more` : ''}).` };
  }
  const a = doc as Arrangement;
  const ids = new Set<string>();
  for (const e of a.events) {
    if (ids.has(e.id)) return { ok: false, reason: `Two events share the id ${e.id}: ids must be unique.` };
    ids.add(e.id);
  }
  const arrangement = { ...a, events: sortEvents(a.events) };
  const conflicts = validate(arrangement);
  const notes = conflicts.length ? [`Opened with ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} to fix.`] : [];
  return { ok: true, arrangement, notes, conflicts };
}

// ---- The editor -----------------------------------------------------------------------

type Entry = { doc: Arrangement; selected: string | null };

export type InsertProps = {
  scene: Partial<Pick<SceneEvent, 'slot' | 'crash'>>;
  fill: Partial<Pick<FillEvent, 'style' | 'length' | 'into' | 'crash'>>;
};

/** What `update` may change, by kind. `at` moves it (snapped). */
export type UpdateProps = Partial<{
  at: number;
  slot: SceneSlot;
  crash: boolean;
  style: string | null;
  length: FillLength | number;
  into: SceneSlot | null;
  bars: RiseBars;
  withFill: boolean;
  division: RepeatDivision;
}>;

export type EditorDefaults = { fillStyle: string | null; fillLength: FillLength };

/**
 * The working arrangement and its history: immutable snapshots, undo and redo (200
 * steps), the selection, the snap. Every edit is checked: one that would add a
 * conflict is refused and changes nothing.
 */
export class ArrangementEditor {
  private entry: Entry | null = null;
  private past: Entry[] = [];
  private future: Entry[] = [];
  private saved: Arrangement | null = null;
  private cached: { doc: Arrangement | null; conflicts: Conflict[] } = { doc: null, conflicts: [] };
  private listeners = new Set<() => void>();
  notes: string[] = [];
  snap: Snap;

  constructor(private readonly opts: { snap?: Snap; defaults?: () => EditorDefaults; limit?: number } = {}) {
    this.snap = opts.snap ?? DEFAULT_SNAP;
  }

  get working(): Arrangement | null {
    return this.entry?.doc ?? null;
  }

  get selected(): string | null {
    return this.entry?.selected ?? null;
  }

  get conflicts(): Conflict[] {
    const doc = this.working;
    if (this.cached.doc !== doc) this.cached = { doc, conflicts: doc ? validate(doc) : [] };
    return this.cached.conflicts;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Changed since it was made, opened or last saved. */
  get dirty(): boolean {
    return this.entry !== null && this.entry.doc !== this.saved;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start from a document: history cleared, not dirty. */
  load(doc: Arrangement, notes: string[] = []): void {
    this.entry = { doc, selected: null };
    this.past = [];
    this.future = [];
    this.saved = doc;
    this.notes = notes;
    this.emit();
  }

  close(): void {
    this.entry = null;
    this.past = [];
    this.future = [];
    this.saved = null;
    this.notes = [];
    this.emit();
  }

  markSaved(): void {
    this.saved = this.working;
    this.emit();
  }

  setSnap(snap: Snap): void {
    if (!SNAPS.includes(snap) || snap === this.snap) return;
    this.snap = snap;
    this.emit();
  }

  /** Select an event (or nothing). Not an undo step. */
  select(id: string | null): void {
    if (!this.entry || (id !== null && !this.find(id))) return;
    this.entry = { ...this.entry, selected: id };
    this.emit();
  }

  undo(): boolean {
    if (!this.entry || this.past.length === 0) return false;
    this.future.push(this.entry);
    this.entry = this.past.pop()!;
    this.emit();
    return true;
  }

  redo(): boolean {
    if (!this.entry || this.future.length === 0) return false;
    this.past.push(this.entry);
    this.entry = this.future.pop()!;
    this.emit();
    return true;
  }

  /** Move an event to `at`, snapped to its effective grid. */
  move(id: string, at: number): Result {
    const e = this.find(id);
    if (!e) return this.missing(id);
    if (!Number.isFinite(at)) return { ok: false, reason: 'That is not a position.' };
    const to = snapAt(e, at, this.snap);
    if (to === e.at) return { ok: true, id };
    return this.commit(this.replace(e, { ...e, at: to }), id, `Can't move the ${eventName(e)} to ${placeLabel(to)}`);
  }

  /** Move an event one grid place earlier (-1) or later (1), by the snap or `by`. */
  nudge(id: string, dir: -1 | 1, by?: Snap): Result {
    const e = this.find(id);
    if (!e) return this.missing(id);
    const g = effectiveGrid(e, by ?? this.snap);
    const to = e.at + dir * g.step;
    if (to < g.offset) return { ok: false, reason: `The ${eventName(e)} is already at the start.` };
    return this.commit(this.replace(e, { ...e, at: to }), id, `Can't nudge the ${eventName(e)} to ${placeLabel(to)}`);
  }

  remove(id: string): Result {
    const e = this.find(id);
    if (!e) return this.missing(id);
    const doc = this.working!;
    const next = { ...doc, events: doc.events.filter((x) => x.id !== id) };
    const after = this.neighbor(doc, e);
    return this.commit(next, after, `Can't remove the ${eventName(e)}`);
  }

  /** A copy at the next free place after it, on its effective grid. */
  duplicate(id: string): Result {
    const e = this.find(id);
    if (!e) return this.missing(id);
    const doc = this.working!;
    const g = effectiveGrid(e, this.snap);
    const end = doc.lengthBars * STEPS_PER_BAR;
    const copyId = this.newId();
    for (let at = e.at + g.step; at < end; at += g.step) {
      const next = { ...doc, events: sortEvents([...doc.events, { ...e, id: copyId, at }]) };
      if (added(doc, next).length === 0) return this.commit(next, copyId, '');
    }
    return { ok: false, reason: `No free place after the ${eventName(e)} before the end.` };
  }

  /** Insert a scene (the next slot after the scene sounding there) or a fill (the current style and length). */
  insert<K extends 'scene' | 'fill'>(kind: K, at: number, props: InsertProps[K] = {}): Result {
    const doc = this.working;
    if (!doc) return { ok: false, reason: 'No arrangement open.' };
    if (!Number.isFinite(at)) return { ok: false, reason: 'That is not a position.' };
    const id = this.newId();
    let e: ArrangementEvent;
    if (kind === 'scene') {
      const p = props as InsertProps['scene'];
      const slot = p.slot ?? this.nextSlot(doc, at);
      if (!isSlot(slot)) return { ok: false, reason: `There is no scene slot called ${String(slot)}.` };
      e = { id, kind: 'scene', at: 0, slot, crash: p.crash ?? false };
    } else {
      const p = props as InsertProps['fill'];
      const d = this.opts.defaults?.() ?? { fillStyle: null, fillLength: 'bar' as const };
      const length = p.length ?? d.fillLength;
      if (length !== 'bar' && length !== 'beat') return { ok: false, reason: 'A fill is a bar or a beat long.' };
      if (p.into !== undefined && !isSlot(p.into)) return { ok: false, reason: `There is no scene slot called ${String(p.into)}.` };
      e = { id, kind: 'fill', at: 0, style: p.style !== undefined ? p.style : d.fillStyle, length,
        ...(p.into ? { into: p.into, crash: p.crash ?? false } : {}) };
    }
    e.at = snapAt(e, at, this.snap);
    const next = { ...doc, events: sortEvents([...doc.events, e]) };
    return this.commit(next, id, `Can't insert the ${eventName(e)} at ${placeLabel(e.at)}`);
  }

  /** Change an event's own fields (not its kind or id). A move snaps. */
  update(id: string, props: UpdateProps): Result {
    const e = this.find(id);
    if (!e) return this.missing(id);
    const bad = (why: string): Result => ({ ok: false, reason: why });
    const has = (k: keyof UpdateProps) => Object.prototype.hasOwnProperty.call(props, k);
    const allowed: Record<ArrangementKind, (keyof UpdateProps)[]> = {
      scene: ['at', 'slot', 'crash'],
      fill: ['at', 'style', 'length', 'into', 'crash'],
      rise: ['at', 'slot', 'bars', 'withFill', 'crash'],
      repeat: ['at', 'division', 'length'],
    };
    for (const k of Object.keys(props) as (keyof UpdateProps)[]) {
      if (!allowed[e.kind].includes(k)) return bad(`A ${e.kind} has no ${k} to change.`);
    }
    const n = { ...e } as Record<string, unknown>;
    if (has('slot')) {
      if (!isSlot(props.slot)) return bad(`There is no scene slot called ${String(props.slot)}.`);
      n.slot = props.slot;
    }
    if (has('crash')) {
      if (typeof props.crash !== 'boolean') return bad('Crash is on or off.');
      if (e.kind === 'fill' && !(has('into') ? props.into : e.into)) return bad('Only a Fill into has a crash: it is the landing\'s.');
      n.crash = props.crash;
    }
    if (has('style')) {
      if (props.style !== null && typeof props.style !== 'string') return bad('A fill style is a name, or none.');
      n.style = props.style;
    }
    if (has('length')) {
      if (e.kind === 'fill') {
        if (props.length !== 'bar' && props.length !== 'beat') return bad('A fill is a bar or a beat long.');
        n.length = props.length;
      } else {
        if (!Number.isInteger(props.length) || (props.length as number) < 1) return bad('A repeat lasts at least one step.');
        n.length = props.length;
      }
    }
    if (has('into')) {
      if (props.into === null || props.into === undefined) {
        delete n.into;
        delete n.crash;
      } else if (!isSlot(props.into)) return bad(`There is no scene slot called ${String(props.into)}.`);
      else {
        n.into = props.into;
        n.crash = has('crash') ? props.crash : (e as FillEvent).crash ?? false;
      }
    }
    if (has('bars')) {
      if (props.bars !== 2 && props.bars !== 4 && props.bars !== 8) return bad('A Rise lasts 2, 4 or 8 bars.');
      n.bars = props.bars;
    }
    if (has('withFill')) {
      if (typeof props.withFill !== 'boolean') return bad('With Fill is on or off.');
      n.withFill = props.withFill;
    }
    if (has('division')) {
      if (props.division !== 4 && props.division !== 8 && props.division !== 16) return bad('A repeat divides by 4, 8 or 16.');
      n.division = props.division;
    }
    const next = n as ArrangementEvent;
    // A move, or a change of grid (a fill's length, a repeat's division), snaps.
    const at = has('at') ? props.at! : e.at;
    if (!Number.isFinite(at)) return bad('That is not a position.');
    next.at = has('at') || !onGrid(next) ? snapAt(next, at, this.snap) : at;
    return this.commit(this.replace(e, next), id, `Can't change the ${eventName(e)}`);
  }

  // ---- inside ----

  private find(id: string): ArrangementEvent | null {
    return this.working?.events.find((e) => e.id === id) ?? null;
  }

  private missing(id: string): Result {
    return { ok: false, reason: this.working ? `There is no event ${id}.` : 'No arrangement open.' };
  }

  private replace(e: ArrangementEvent, next: ArrangementEvent): Arrangement {
    const doc = this.working!;
    return { ...doc, events: sortEvents(doc.events.map((x) => (x.id === e.id ? next : x))) };
  }

  private neighbor(doc: Arrangement, e: ArrangementEvent): string | null {
    const i = doc.events.findIndex((x) => x.id === e.id);
    return doc.events[i + 1]?.id ?? doc.events[i - 1]?.id ?? null;
  }

  private newId(): string {
    const used = new Set(this.working?.events.map((e) => e.id) ?? []);
    let n = (this.working?.events.length ?? 0) + 1;
    while (used.has(`e${n}`)) n += 1;
    return `e${n}`;
  }

  /** The slot after the scene sounding at `at` (in slot order), or Sparse after Full when nothing has changed yet. */
  private nextSlot(doc: Arrangement, at: number): SceneSlot {
    const before = sceneChanges(doc).filter((c) => c.at <= at).at(-1);
    const current = before?.slot ?? doc.initial?.scene.slot ?? 'full';
    const i = SCENE_SLOTS.indexOf(current as SceneSlot);
    return SCENE_SLOTS[(i + 1) % SCENE_SLOTS.length]!;
  }

  /** Apply `next` unless it adds a conflict. One undo step. */
  private commit(next: Arrangement, selected: string | null | undefined, refused: string): Result {
    const doc = this.working;
    if (!doc || !this.entry) return { ok: false, reason: 'No arrangement open.' };
    const fresh = added(doc, next);
    if (fresh.length > 0) return { ok: false, reason: refused ? `${refused}: ${fresh[0]!.message}` : fresh[0]!.message };
    this.past.push(this.entry);
    const limit = this.opts.limit ?? HISTORY_LIMIT;
    if (this.past.length > limit) this.past.splice(0, this.past.length - limit);
    this.future = [];
    this.entry = { doc: next, selected: selected ?? null };
    this.emit();
    return selected ? { ok: true, id: selected } : { ok: true };
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
