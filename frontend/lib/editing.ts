/**
 * Pattern editing as pure functions.
 *
 * Every operation takes a pattern and returns a new one, never touching the input, so
 * the undo history can keep the exact before and after of every edit. Each returned
 * pattern has its revision bumped and an `origin` saying what made it. Nothing here
 * knows about the screen, the engine or React: `tools/check-editing.mjs` runs these
 * directly, and the editor only decides which to call.
 *
 * Positions are absolute song steps (0..255) throughout; the editor converts from a
 * bar and a column.
 */

import {
  STEPS,
  STEPS_PER_BAR,
  clonePattern,
  isNoteEvent,
  laneSpec,
  type DrumEvent,
  type LaneId,
  type Locks,
  type NoteEvent,
  type Origin,
  type Pattern,
  type PatternEvent,
  type Patterns,
} from './patterns';

const byStep = (a: PatternEvent, b: PatternEvent) => a.step - b.step;

/**
 * The next pattern revision: same identity (a factory lane becomes `p-<lane>` on its
 * first edit), revision one higher, events sorted, origin as given.
 */
export function revise(p: Pattern, events: PatternEvent[], origin: Origin): Pattern {
  return {
    id: p.id.startsWith('factory-') ? `p-${p.lane}` : p.id,
    revision: p.revision + 1,
    lane: p.lane,
    length: STEPS,
    events: [...events].sort(byStep),
    origin,
  };
}

/** An event id not yet used in `p`: the lane's prefix, `n`, and a counter. */
export function newEventId(p: Pattern, taken: Set<string> = new Set()): string {
  const used = new Set([...p.events.map((e) => e.id), ...taken]);
  const prefix = laneSpec(p.lane).prefix;
  for (let i = 1; ; i += 1) {
    const id = `${prefix}n${i}`;
    if (!used.has(id)) return id;
  }
}

export const barRange = (bar: number): [number, number] => [bar * STEPS_PER_BAR, bar * STEPS_PER_BAR + STEPS_PER_BAR - 1];

// ---- Drum lanes ----------------------------------------------------------------

/**
 * A painted row: one edit over several steps. The operation is decided by the step
 * the gesture started on (`mode`): `add` puts a hit on every step that has none, at
 * `vel`; `remove` takes the hits off. A step crossed twice is not toggled back.
 */
export function paintHits(p: Pattern, steps: number[], mode: 'add' | 'remove', vel: number): Pattern {
  const set = new Set(steps);
  const taken = new Set<string>();
  let events: PatternEvent[];
  if (mode === 'remove') {
    events = p.events.filter((e) => !set.has(e.step));
  } else {
    events = [...p.events];
    const have = new Set(p.events.map((e) => e.step));
    for (const step of [...set].sort((a, b) => a - b)) {
      if (have.has(step) || step < 0 || step >= STEPS) continue;
      const id = newEventId(p, taken);
      taken.add(id);
      events.push({ id, step, vel } as DrumEvent);
    }
  }
  return revise(p, events, { kind: 'edit' });
}

/**
 * Set the velocity of the hits with `ids`. `mode` `set` gives each `value`; `scale`
 * multiplies each by `value`, so the accents stay louder than the rest. Velocities
 * are kept above zero: making a hit quiet never deletes it (turning it off is a
 * separate act).
 */
export const MIN_VELOCITY = 0.02;
export function setVelocities(p: Pattern, ids: string[], mode: 'set' | 'scale', value: number): Pattern {
  const set = new Set(ids);
  const events = p.events.map((e) => {
    if (!set.has(e.id)) return e;
    const v = mode === 'set' ? value : e.vel * value;
    return { ...e, vel: Math.min(1, Math.max(MIN_VELOCITY, Math.round(v * 1000) / 1000)) };
  });
  return revise(p, events, { kind: 'edit' });
}

/** Remove every event that starts on steps `from..to`. An empty result is silence, not "no override". */
export function clearRange(p: Pattern, from: number, to: number): Pattern {
  return revise(
    p,
    p.events.filter((e) => e.step < from || e.step > to),
    { kind: 'edit' },
  );
}

/** A copied range: its events with positions relative to the range's start. */
export type Clip = { lane: LaneId; length: number; events: PatternEvent[]; label: string };

export function copyRange(p: Pattern, from: number, to: number, label: string): Clip {
  return {
    lane: p.lane,
    length: to - from + 1,
    events: p.events
      .filter((e) => e.step >= from && e.step <= to)
      .map((e) => ({ ...e, step: e.step - from }) as PatternEvent),
    label,
  };
}

/**
 * Paste `clip` at `at`, replacing everything that started in the destination range
 * (no merging, so nothing doubles). Notes are clamped to end by the song's end.
 * Refuses (returns null) a clip from a lane of the other kind, or a destination that
 * would run past the song's end.
 */
export function pasteClip(p: Pattern, clip: Clip, at: number, origin: Origin = { kind: 'paste' }): Pattern | null {
  if (laneSpec(clip.lane).kind !== laneSpec(p.lane).kind) return null;
  if (at < 0 || at + clip.length > STEPS) return null;
  const end = at + clip.length - 1;
  const kept = p.events.filter((e) => e.step < at || e.step > end);
  const taken = new Set(kept.map((e) => e.id));
  const pasted = clip.events.map((e) => {
    const id = taken.has(e.id) ? newEventId(p, taken) : e.id;
    taken.add(id);
    const step = e.step + at;
    if (isNoteEvent(e)) return { ...e, id, step, len: Math.min(e.len, STEPS - step), notes: [...e.notes] };
    return { ...e, id, step };
  });
  return revise(p, [...kept, ...pasted], origin);
}

/** Duplicate bar `from` onto bar `to` (replacing it). Never wraps: `to` must be a real bar. */
export function duplicateBar(p: Pattern, from: number, to: number): Pattern | null {
  if (to < 0 || to >= STEPS / STEPS_PER_BAR || to === from) return null;
  const [a, b] = barRange(from);
  return pasteClip(p, copyRange(p, a, b, ''), to * STEPS_PER_BAR, { kind: 'paste', from, to });
}

// ---- Note lanes ----------------------------------------------------------------

/** The steps a note sounds on: its onset up to (not including) onset + len. */
const span = (e: NoteEvent): [number, number] => [e.step, e.step + e.len];

/**
 * The note (other than `ignoreId`) that `[step, step + len)` would overlap, if any.
 * New phrases are single-note: a move or a resize that would overlap another note is
 * refused rather than shortening or deleting the other one.
 */
export function overlapping(p: Pattern, step: number, len: number, ignoreId?: string): NoteEvent | null {
  for (const e of p.events) {
    if (!isNoteEvent(e) || e.id === ignoreId) continue;
    const [a, b] = span(e);
    if (step < b && a < step + len) return e;
  }
  return null;
}

/** Add a one-pitch note, or null if it would overlap or run past the end. */
export function addNote(p: Pattern, step: number, pitch: number, len: number, vel: number): Pattern | null {
  if (step < 0 || step >= STEPS) return null;
  const length = Math.min(len, STEPS - step);
  if (overlapping(p, step, length)) return null;
  const note: NoteEvent = { id: newEventId(p), step, notes: [pitch], len: length, vel, accent: false };
  return revise(p, [...p.events, note], { kind: 'edit' });
}

/**
 * Move a note to `step` and transpose it by `semitones`, or resize it to `len`. A chord
 * moves in time and keeps its voicing; its pitches transpose together. Refused (null)
 * when the result would overlap another note, leave the song, or leave 0..127.
 */
export function editNote(
  p: Pattern,
  id: string,
  change: { step?: number; semitones?: number; len?: number; vel?: number; accent?: boolean },
): Pattern | null {
  const e = p.events.find((x) => x.id === id);
  if (!e || !isNoteEvent(e)) return null;
  const step = change.step ?? e.step;
  if (step < 0 || step >= STEPS) return null;
  const len = Math.min(change.len ?? e.len, STEPS - step);
  if (len <= 0) return null;
  const shift = change.semitones ?? 0;
  const notes = e.notes.map((n) => n + shift);
  if (notes.some((n) => n < 0 || n > 127)) return null;
  if (overlapping(p, step, len, id)) return null;
  const next: NoteEvent = {
    ...e,
    step,
    len,
    notes,
    vel: change.vel === undefined ? e.vel : Math.min(1, Math.max(MIN_VELOCITY, change.vel)),
    accent: change.accent ?? e.accent,
  };
  return revise(
    p,
    p.events.map((x) => (x.id === id ? next : x)),
    { kind: 'edit' },
  );
}

/** Delete events by id. */
export function deleteEvents(p: Pattern, ids: string[]): Pattern {
  const set = new Set(ids);
  return revise(
    p,
    p.events.filter((e) => !set.has(e.id)),
    { kind: 'edit' },
  );
}

/** A note that started in an earlier bar and is still sounding at `bar`'s first step. */
export function carriedInto(p: Pattern, bar: number): NoteEvent[] {
  const start = bar * STEPS_PER_BAR;
  return p.events.filter((e): e is NoteEvent => isNoteEvent(e) && e.step < start && e.step + e.len > start);
}

// ---- Humanize: velocity only, seeded, always from the source ---------------------

/** The generator's name and version, recorded in every humanized pattern. */
export const HUMANIZE_GENERATOR = 'ui-humanize-velocity-1';

/** A small seeded generator (mulberry32): the same seed gives the same numbers. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable number from a string, to give each event its own draw whatever its order. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export type HumanizeSettings = {
  /** 0..1: at 1, a velocity moves by up to ±20%. */
  amount: number;
  preserveAccents: boolean;
  seed: number;
  /** The steps it applies to, inclusive. */
  from: number;
  to: number;
};

/** An accent, for "Preserve accents": a note marked accent, or a hit at the top of its bar. */
export function isAccent(p: Pattern, e: PatternEvent): boolean {
  if (isNoteEvent(e)) return e.accent;
  const bar = Math.floor(e.step / STEPS_PER_BAR);
  const top = Math.max(...p.events.filter((x) => Math.floor(x.step / STEPS_PER_BAR) === bar).map((x) => x.vel));
  return e.vel >= top - 1e-6 && e.vel >= 0.8;
}

/**
 * Humanize velocities, always computed from `source`, never from an earlier result,
 * so moving the amount back and forth never wears the pattern away. Each event's
 * change comes from the seed and its own id, so the result does not depend on event
 * order and the same inputs always give the same pattern. Locked events and lanes,
 * and (optionally) accents, are left exactly as they were; every value stays within
 * MIN_VELOCITY..1.
 */
export function humanize(source: Pattern, settings: HumanizeSettings, locks: Locks): Pattern {
  if (locks.lanes.includes(source.lane)) return clonePattern(source);
  const locked = new Set(locks.events[source.lane] ?? []);
  const spread = 0.2 * Math.max(0, Math.min(1, settings.amount));
  const events = source.events.map((e) => {
    if (e.step < settings.from || e.step > settings.to) return e;
    if (locked.has(e.id) || (settings.preserveAccents && isAccent(source, e))) return e;
    const r = mulberry32(settings.seed ^ hashString(e.id))() * 2 - 1;
    const v = Math.round(e.vel * (1 + r * spread) * 1000) / 1000;
    return { ...e, vel: Math.min(1, Math.max(MIN_VELOCITY, v)) };
  });
  return revise(source, events, {
    kind: 'humanize',
    generator: HUMANIZE_GENERATOR,
    seed: settings.seed,
    amount: settings.amount,
    preserveAccents: settings.preserveAccents,
    scope: { from: settings.from, to: settings.to },
    sourceRevision: source.revision,
  });
}

/** How two versions of a lane differ, in words: "3 hits added · 2 velocities changed". */
export function changeSummary(before: Pattern, after: Pattern): string {
  const a = new Map(before.events.map((e) => [e.id, e]));
  const b = new Map(after.events.map((e) => [e.id, e]));
  let added = 0;
  let removed = 0;
  let velocity = 0;
  let moved = 0;
  for (const [id, e] of b) {
    const old = a.get(id);
    if (!old) added += 1;
    else {
      if (old.step !== e.step || (isNoteEvent(old) && isNoteEvent(e) && (old.len !== e.len || old.notes.join() !== e.notes.join()))) moved += 1;
      if (Math.abs(old.vel - e.vel) > 1e-6) velocity += 1;
    }
  }
  for (const id of a.keys()) if (!b.has(id)) removed += 1;
  const noun = laneSpec(after.lane).kind === 'drum' ? ['hit', 'hits'] : ['note', 'notes'];
  const parts: string[] = [];
  if (added) parts.push(`${added} ${added === 1 ? noun[0] : noun[1]} added`);
  if (removed) parts.push(`${removed} ${removed === 1 ? noun[0] : noun[1]} removed`);
  if (moved) parts.push(`${moved} ${moved === 1 ? noun[0] : noun[1]} moved`);
  if (velocity) parts.push(`${velocity} ${velocity === 1 ? 'velocity' : 'velocities'} changed`);
  return parts.length ? parts.join(' · ') : 'no change';
}

// ---- Undo: changes over the working patterns ----------------------------------

/** An edit's effect on the working patterns: each lane's new pattern, or null for the factory lane. */
export type LaneChange = Partial<Record<LaneId, Pattern | null>>;

/** The working patterns with `change` applied. Never touches `working`. */
export function applyChange(working: Patterns, change: LaneChange): Patterns {
  const next: Patterns = { ...working };
  for (const lane of Object.keys(change) as LaneId[]) {
    const p = change[lane];
    if (p) next[lane] = p;
    else delete next[lane];
  }
  return next;
}

/** What undoes `change` on `working`: every lane it touches, as it is now. */
export function inverseOf(working: Patterns, change: LaneChange): LaneChange {
  const out: LaneChange = {};
  for (const lane of Object.keys(change) as LaneId[]) out[lane] = working[lane] ?? null;
  return out;
}
