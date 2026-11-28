/**
 * The arrangement editor's API as the drawer reads it (Night 12): `inst.arrangement`,
 * built by the model branch (night12/model, frontend/lib/arrangement.ts). These types
 * are the coordinator's spec for it, here so the drawer builds on its own; at the merge
 * they are replaced by imports from lib/arrangement, and nothing else changes.
 */

export type Snap = 'bar' | 'beat' | 'sixteenth';
export const SNAP_STEPS: Record<Snap, number> = { bar: 16, beat: 4, sixteenth: 1 };

export type ArrangementEventBase = { id: string; at: number };
export type ArrScene = ArrangementEventBase & { kind: 'scene'; slot: string; crash: boolean };
export type ArrFill = ArrangementEventBase & { kind: 'fill'; style: string | null; length: 'bar' | 'beat'; into?: string | null };
export type ArrRise = ArrangementEventBase & { kind: 'rise'; slot: string; bars: number; withFill: boolean; crash: boolean };
export type ArrRepeat = ArrangementEventBase & { kind: 'repeat'; division: number; length: number };
export type ArrangementEvent = ArrScene | ArrFill | ArrRise | ArrRepeat;

export type Arrangement = {
  track: string;
  bpm: number;
  lengthBars: number;
  /** Where it came from: a take, a file. Read defensively: shown as a name only. */
  source?: unknown;
  initial?: unknown;
  events: ArrangementEvent[];
};

export type EditResult = { ok: true; id?: string } | { ok: false; reason: string };

export type ArrangementApi = {
  working: Arrangement | null;
  dirty: boolean;
  conflicts: { ids: string[]; message: string }[];
  notes: string[];
  canUndo: boolean;
  canRedo: boolean;
  snap: Snap;
  setSnap: (s: Snap) => void;
  fromTake: () => EditResult | void;
  startEmpty: () => EditResult | void;
  move: (id: string, at: number) => EditResult;
  nudge: (id: string, dir: -1 | 1, by?: Snap) => EditResult;
  remove: (id: string) => EditResult;
  duplicate: (id: string) => EditResult;
  insert: (kind: 'scene' | 'fill', at: number, props?: Record<string, unknown>) => EditResult;
  update: (id: string, props: Record<string, unknown>) => EditResult;
  undo: () => EditResult | void;
  redo: () => EditResult | void;
  save: () => EditResult | boolean | void;
  open: (text: string, filename?: string) => EditResult | Promise<EditResult>;
  close: () => void;
};

/** A source's name for the header: "from <take>". */
export function sourceName(a: Arrangement): string {
  const s = a.source as { filename?: unknown; name?: unknown; track?: unknown; kind?: unknown } | string | undefined | null;
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') {
    for (const k of ['filename', 'name', 'track'] as const) if (typeof s[k] === 'string' && s[k]) return s[k] as string;
  }
  return a.track;
}

/** The steps an event spans on the timeline; 0 for a point. */
export function spanOf(e: ArrangementEvent): number {
  switch (e.kind) {
    case 'scene':
      return 0;
    case 'fill':
      return e.length === 'beat' ? 4 : 16;
    case 'rise':
      return e.bars * 16;
    case 'repeat':
      return Math.max(1, e.length);
  }
}
