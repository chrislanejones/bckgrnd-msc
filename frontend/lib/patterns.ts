/**
 * Patterns: the editable musical data of a project (contract version 3).
 *
 * A project may override any of the nine lanes (`contracts/patterns.json`) with a
 * pattern of its own. The rules every reader keeps (this file, and
 * `App\Support\Project\Patterns` in PHP, held to the same fixtures):
 *
 * - **No override means the factory lane.** A lane missing from `patterns` plays the
 *   track as written. A lane present with no events plays **nothing**: an empty
 *   pattern is silence, never "missing". Clearing a bar can therefore never bring the
 *   factory pattern back.
 * - **Positions are sixteenths of the 16-bar song**, 0..255 (`step`); a note's `len` is
 *   in sixteenths too and must end by step 256. Screen coordinates, selections, scroll
 *   and the playhead are never part of a pattern.
 * - **Every event has a stable `id`**, unique in its pattern. The factory's ids are
 *   derived from lane and step (`h12`), so a project and the factory agree on them.
 * - **Nothing is flattened.** A note event keeps every pitch it has (chords of up to
 *   six), its length, velocity and accent, whether or not the editor shows them.
 * - **A pattern is refused whole** if anything in it is malformed, as scenes are: a
 *   half-read phrase would play something nobody wrote.
 */

import registry from '../../contracts/patterns.json';
import type { NoteEvent as TrackNote, TrackArrangement } from './types';

export type LaneId = 'kick' | 'clap' | 'hat' | 'hatOpen' | 'bass' | 'stab' | 'lead' | 'pad' | 'arp';
export type LaneKind = 'drum' | 'notes';

export type LaneSpec = {
  id: LaneId;
  stem: string;
  kind: LaneKind;
  label: string;
  prefix: string;
  engine: number;
  editable: boolean;
  velocity: number;
  range?: [number, number];
};

export const STEPS = registry.steps;
export const STEPS_PER_BAR = registry.stepsPerBar;
export const BARS = STEPS / STEPS_PER_BAR;
export const MAX_NOTES = registry.maxNotes;
export const LANES = registry.lanes as LaneSpec[];
export const LANE_IDS = LANES.map((l) => l.id);
const ORIGIN_KINDS = registry.originKinds;

export function laneSpec(id: LaneId): LaneSpec {
  const spec = LANES.find((l) => l.id === id);
  if (!spec) throw new Error(`unknown lane ${id}`);
  return spec;
}

export type DrumEvent = { id: string; step: number; vel: number };
export type NoteEvent = { id: string; step: number; notes: number[]; len: number; vel: number; accent: boolean };
export type PatternEvent = DrumEvent | NoteEvent;

/** Where a pattern came from: an edit, a paste, a humanize or a variation, with its settings. */
export type Origin = { kind: string } & Record<string, unknown>;

export type Pattern = {
  id: string;
  revision: number;
  lane: LaneId;
  length: number;
  events: PatternEvent[];
  origin?: Origin;
};

/** A scene's record of a lane it leaves at the factory pattern. */
export type FactoryRef = { factory: true };
export type ScenePatterns = Partial<Record<LaneId, Pattern | FactoryRef>>;
export type Patterns = Partial<Record<LaneId, Pattern>>;

/** Locked lanes and events: a variation or a humanize never changes them. */
export type Locks = { lanes: LaneId[]; events: Partial<Record<LaneId, string[]>> };
export const NO_LOCKS: Locks = { lanes: [], events: {} };

/** Visual projection only; the engine still receives revisions over the original
 * source so editing the bass cannot change the source-root kick tuning. */
export function resolvedArrangement(source: TrackArrangement, patterns: Patterns): TrackArrangement {
  const out = structuredClone(source);
  for (const lane of LANE_IDS) {
    const p = patterns[lane]; if (!p) continue;
    if (laneSpec(lane).kind === 'drum') {
      const hits = Array<number>(STEPS).fill(0);
      for (const e of p.events) hits[e.step] = e.vel;
      (out[lane] as number[]) = hits;
    } else {
      const notes = Array<TrackNote | null>(STEPS).fill(null);
      for (const e of p.events as NoteEvent[]) notes[e.step] = { notes: [...e.notes], len: e.len, vel: e.vel, accent: e.accent };
      (out[lane] as (TrackNote | null)[]) = notes;
    }
  }
  return out;
}

export const isNoteEvent = (e: PatternEvent): e is NoteEvent => 'notes' in e;
export const isFactoryRef = (p: Pattern | FactoryRef): p is FactoryRef => 'factory' in p;

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,24}$/;

/** PHP reads `{}` and `[]` alike, so either is an empty map. */
const isEmptyMap = (v: unknown) => (isObj(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);

function fail(where: string, why: string): never {
  throw new Error(`Patterns are malformed: ${where}: ${why}`);
}

/**
 * Read one pattern strictly. `lane` is the key it was stored under, which must match
 * the pattern's own `lane`. Events come back sorted by step, the canonical order.
 */
export function readPattern(raw: unknown, lane: string, where: string): Pattern {
  const spec = LANES.find((l) => l.id === lane);
  if (!spec) fail(where, `unknown lane ${JSON.stringify(lane)}`);
  const at = `${where} ${lane}`;
  if (!isObj(raw)) fail(at, 'expected an object');
  const p = raw as Loose;
  const allowed = ['id', 'revision', 'lane', 'length', 'events', 'origin'];
  const extra = Object.keys(p).filter((k) => !allowed.includes(k));
  if (extra.length) fail(at, `unknown keys ${JSON.stringify(extra)}`);
  for (const k of ['id', 'revision', 'lane', 'length', 'events']) if (!(k in p)) fail(at, `missing ${k}`);
  if (typeof p.id !== 'string' || !ID.test(p.id)) fail(at, 'id must be 1 to 64 letters, digits, - or _');
  if (typeof p.revision !== 'number' || !Number.isInteger(p.revision) || p.revision < 1) {
    fail(at, 'revision must be a whole number of at least 1');
  }
  if (p.lane !== lane) fail(at, `is stored under ${lane} but says ${JSON.stringify(p.lane)}`);
  if (p.length !== STEPS) fail(at, `length must be ${STEPS}`);
  if (!Array.isArray(p.events)) fail(at, 'events must be a list');
  if ((p.events as unknown[]).length > registry.maxEvents) fail(at, `more than ${registry.maxEvents} events`);
  const seenIds = new Set<string>();
  const seenSteps = new Set<number>();
  const events = (p.events as unknown[]).map((raw, i): PatternEvent => {
    const e = raw as Loose;
    const where2 = `${at} event ${i}`;
    if (!isObj(raw)) fail(where2, 'expected an object');
    const keys = spec!.kind === 'drum' ? ['id', 'step', 'vel'] : ['id', 'step', 'notes', 'len', 'vel', 'accent'];
    const present = Object.keys(e);
    if (present.length !== keys.length || !keys.every((k) => present.includes(k))) {
      fail(where2, `must have exactly ${keys.join(', ')}`);
    }
    if (typeof e.id !== 'string' || !EVENT_ID.test(e.id)) fail(where2, 'id must be 1 to 24 letters, digits, - or _');
    if (seenIds.has(e.id as string)) fail(where2, `repeats id ${e.id as string}`);
    seenIds.add(e.id as string);
    if (typeof e.step !== 'number' || !Number.isInteger(e.step) || e.step < 0 || e.step >= STEPS) {
      fail(where2, `step must be a whole number from 0 to ${STEPS - 1}`);
    }
    if (seenSteps.has(e.step as number)) fail(where2, `a second event on step ${e.step as number}`);
    seenSteps.add(e.step as number);
    if (!isNum(e.vel) || e.vel <= 0 || e.vel > 1) fail(where2, 'vel must be above 0 and at most 1');
    if (spec!.kind === 'drum') return { id: e.id as string, step: e.step as number, vel: e.vel as number };
    const notes = e.notes;
    if (!Array.isArray(notes) || notes.length < 1 || notes.length > MAX_NOTES) {
      fail(where2, `notes must hold 1 to ${MAX_NOTES} pitches`);
    }
    for (const n of notes as unknown[]) {
      if (!isNum(n) || n < registry.pitch.min || n > registry.pitch.max) {
        fail(where2, `every pitch must be from ${registry.pitch.min} to ${registry.pitch.max}`);
      }
    }
    if (!isNum(e.len) || e.len <= 0 || (e.step as number) + e.len > STEPS) {
      fail(where2, `len must be above 0 and end by step ${STEPS}`);
    }
    if (typeof e.accent !== 'boolean') fail(where2, 'accent must be true or false');
    return {
      id: e.id as string,
      step: e.step as number,
      notes: [...(notes as number[])],
      len: e.len as number,
      vel: e.vel as number,
      accent: e.accent as boolean,
    };
  });
  events.sort((a, b) => a.step - b.step);
  const out: Pattern = { id: p.id as string, revision: p.revision as number, lane: lane as LaneId, length: STEPS, events };
  if ('origin' in p) {
    const o = p.origin;
    if (!isObj(o) || typeof o.kind !== 'string' || !ORIGIN_KINDS.includes(o.kind)) {
      fail(at, `origin must be an object whose kind is one of ${ORIGIN_KINDS.join(', ')}`);
    }
    out.origin = JSON.parse(JSON.stringify(o)) as Origin;
  }
  return out;
}

/** Read a project's `patterns`: a map of lane to pattern, in registry order. */
export function readPatterns(raw: unknown, where = 'patterns'): Patterns {
  if (raw === undefined || isEmptyMap(raw)) return {};
  if (!isObj(raw)) fail(where, 'expected an object of lanes');
  const out: Patterns = {};
  for (const key of Object.keys(raw as Loose)) {
    if (!LANE_IDS.includes(key as LaneId)) fail(where, `unknown lane ${JSON.stringify(key)}`);
  }
  for (const lane of LANE_IDS) {
    if (lane in (raw as Loose)) out[lane] = readPattern((raw as Loose)[lane], lane, where);
  }
  return out;
}

/** Read a scene's `patterns`: lanes it sets, each a pinned pattern or `{factory: true}`. */
export function readScenePatterns(raw: unknown, slot: string): ScenePatterns {
  const where = `slot ${slot} patterns`;
  if (raw === undefined || isEmptyMap(raw)) return {};
  if (!isObj(raw)) fail(where, 'expected an object of lanes');
  const out: ScenePatterns = {};
  for (const key of Object.keys(raw as Loose)) {
    if (!LANE_IDS.includes(key as LaneId)) fail(where, `unknown lane ${JSON.stringify(key)}`);
  }
  for (const lane of LANE_IDS) {
    if (!(lane in (raw as Loose))) continue;
    const v = (raw as Loose)[lane];
    if (isObj(v) && 'factory' in v) {
      if (Object.keys(v).length !== 1 || v.factory !== true) fail(`${where} ${lane}`, 'a factory reference is exactly {"factory": true}');
      out[lane] = { factory: true };
    } else {
      out[lane] = readPattern(v, lane, where);
    }
  }
  return out;
}

/** Read `locks`: locked lanes, and locked event ids per lane, deduplicated and sorted. */
export function readLocks(raw: unknown): Locks {
  const where = 'locks';
  if (raw === undefined) return { lanes: [], events: {} };
  if (!isObj(raw)) fail(where, 'expected an object with lanes and events');
  const r = raw as Loose;
  const keys = Object.keys(r);
  if (keys.length !== 2 || !keys.includes('lanes') || !keys.includes('events')) fail(where, 'must have exactly lanes and events');
  if (!Array.isArray(r.lanes)) fail(where, 'lanes must be a list');
  for (const l of r.lanes as unknown[]) if (!LANE_IDS.includes(l as LaneId)) fail(where, `unknown lane ${JSON.stringify(l)}`);
  const lanes = LANE_IDS.filter((l) => (r.lanes as unknown[]).includes(l));
  if (!isEmptyMap(r.events) && !isObj(r.events)) fail(where, 'events must be an object of lanes');
  const events: Partial<Record<LaneId, string[]>> = {};
  const given = isObj(r.events) ? (r.events as Loose) : {};
  for (const key of Object.keys(given)) if (!LANE_IDS.includes(key as LaneId)) fail(where, `unknown lane ${JSON.stringify(key)}`);
  for (const lane of LANE_IDS) {
    if (!(lane in given)) continue;
    const ids = given[lane];
    if (!Array.isArray(ids)) fail(where, `events ${lane} must be a list`);
    for (const id of ids as unknown[]) if (typeof id !== 'string' || !EVENT_ID.test(id)) fail(where, `events ${lane} has a bad id`);
    const unique = [...new Set(ids as string[])].sort();
    if (unique.length) events[lane] = unique;
  }
  return { lanes, events };
}

// ---- The factory: a track's own lanes as patterns ----------------------------

const DRUM_FIELD: Partial<Record<LaneId, 'kick' | 'clap' | 'hat' | 'hatOpen'>> = {
  kick: 'kick',
  clap: 'clap',
  hat: 'hat',
  hatOpen: 'hatOpen',
};

/** The id the factory gives the event on `step` of `lane`. */
export const factoryEventId = (lane: LaneId, step: number) => `${laneSpec(lane).prefix}${step}`;

/**
 * A lane as the track wrote it, as a pattern. Identity `factory-<lane>`, revision 1.
 * Mirrors `Patterns::factory()` in PHP.
 */
export function factoryPattern(track: TrackArrangement, lane: LaneId): Pattern {
  const spec = laneSpec(lane);
  const events: PatternEvent[] = [];
  if (spec.kind === 'drum') {
    const field = DRUM_FIELD[lane]!;
    (track[field] as number[]).forEach((v, step) => {
      if (v > 0 && step < STEPS) events.push({ id: factoryEventId(lane, step), step, vel: v });
    });
  } else {
    (track[lane as 'bass'] as (TrackNote | null)[]).forEach((e, step) => {
      if (!e || step >= STEPS) return;
      events.push({
        id: factoryEventId(lane, step),
        step,
        notes: [...e.notes],
        len: Math.min(e.len, STEPS - step),
        vel: e.vel,
        accent: Boolean(e.accent),
      });
    });
  }
  return { id: `factory-${lane}`, revision: 1, lane, length: STEPS, events };
}

/** The pattern a lane plays: the project's override, or the factory's. */
export function lanePattern(track: TrackArrangement, patterns: Patterns, lane: LaneId): Pattern {
  return patterns[lane] ?? factoryPattern(track, lane);
}

/** Whether two patterns hold the same music (ids of events included, provenance not). */
export function sameEvents(a: Pattern, b: Pattern): boolean {
  if (a.lane !== b.lane || a.events.length !== b.events.length) return false;
  return a.events.every((e, i) => JSON.stringify(e) === JSON.stringify(b.events[i]));
}

/** A deep copy, so edits never touch a pattern something else still holds. */
export const clonePattern = (p: Pattern): Pattern => JSON.parse(JSON.stringify(p)) as Pattern;

// ---- What the engine receives -----------------------------------------------

/** Floats per note event in the engine payload: step, len, vel, accent, count, six pitches. */
export const NOTE_WIDTH = 5 + MAX_NOTES;

/**
 * Compile lanes into the engine's pattern payload (docs/NIGHT4_PROTOCOL.md):
 * `[laneCount, (laneIndex, kind, n, ...data)...]`. A drum lane is `kind` 0 with
 * `n` = 256 velocities; a note lane is `kind` 1 with `n` events of NOTE_WIDTH floats
 * each, unused pitch slots -1. Built here, on the main thread, so the worklet only
 * validates and copies.
 */
export function compileLanes(lanes: Pattern[]): Float32Array {
  let size = 1;
  for (const p of lanes) size += 3 + (laneSpec(p.lane).kind === 'drum' ? STEPS : p.events.length * NOTE_WIDTH);
  const out = new Float32Array(size);
  let k = 0;
  out[k++] = lanes.length;
  for (const p of lanes) {
    const spec = laneSpec(p.lane);
    out[k++] = spec.engine;
    if (spec.kind === 'drum') {
      out[k++] = 0;
      out[k++] = STEPS;
      for (const e of p.events) out[k + e.step] = (e as DrumEvent).vel;
      k += STEPS;
    } else {
      out[k++] = 1;
      out[k++] = p.events.length;
      for (const raw of p.events) {
        const e = raw as NoteEvent;
        out[k] = e.step;
        out[k + 1] = e.len;
        out[k + 2] = e.vel;
        out[k + 3] = e.accent ? 1 : 0;
        out[k + 4] = e.notes.length;
        for (let i = 0; i < MAX_NOTES; i += 1) out[k + 5 + i] = e.notes[i] ?? -1;
        k += NOTE_WIDTH;
      }
    }
  }
  return out;
}

// ---- Matching a variation's source ------------------------------------------

/**
 * A content hash of a lane's events on steps `from..to` (inclusive), positions taken
 * relative to `from`, used to match a static variation candidate to its source. The
 * canonical text rounds velocities to thousandths so PHP and JS agree byte for byte.
 * FNV-1a, 32 bits, as eight hex digits. Mirrors `Patterns::sourceHash()`.
 */
export function sourceHash(pattern: Pattern, from: number, to: number): string {
  const parts: string[] = [];
  for (const e of pattern.events) {
    if (e.step < from || e.step > to) continue;
    const v = Math.round(e.vel * 1000);
    if (isNoteEvent(e)) {
      parts.push(`${e.step - from}:${v}:${e.notes.map((n) => Math.round(n)).join('.')}:${Math.round(e.len * 1000)}:${e.accent ? 1 : 0}`);
    } else {
      parts.push(`${e.step - from}:${v}`);
    }
  }
  const text = `${pattern.lane}|${parts.join(',')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
