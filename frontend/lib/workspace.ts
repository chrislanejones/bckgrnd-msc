/**
 * The pattern workspace: the working patterns, the undo history over them, what the
 * engine has been sent and has confirmed, and the one variation being previewed.
 *
 * - **Working vs audible.** `working` is the composition as edited. Each change is
 *   staged to the engine as a revision holding every lane this session has touched
 *   (so "latest wins" is exact, and an undo is just another revision). The engine
 *   applies it at the next bar while playing, at once while stopped, and reports
 *   `queued` then `applied`. The status line follows those events: a grid that
 *   changed on screen is *edited*, not yet *audible*.
 * - **Undo is real.** Every accepted edit (a painted row, a note drag, a paste, a
 *   clear, a kept variation, a scene launch that set lanes) is one entry holding the
 *   lanes before and after, so undo restores exactly what was there, while playing.
 * - **Preview** stages a candidate without touching `working`. Keep turns it into one
 *   undoable edit; Revert stages `working` again. Composition edits wait until it is
 *   kept or reverted; mixing and playback do not.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { applyChange, inverseOf, type LaneChange } from './editing';
import { engine } from './engine';
import type { Deck } from './engine';
import {
  LANE_IDS,
  NO_LOCKS,
  clonePattern,
  compileLanes,
  factoryPattern,
  isFactoryRef,
  lanePattern,
  sameEvents,
  type LaneId,
  type Locks,
  type Pattern,
  type Patterns,
  type ScenePatterns,
} from './patterns';
import type { TrackArrangement } from './types';

/** Engine event kinds for pattern revisions (NIGHT4_PROTOCOL.md). */
export const PATTERN_EVENT = { queued: 31, applied: 32, cancelled: 33, replaced: 34, rejected: 35 } as const;

export type ChangeState = 'none' | 'sending' | 'queued' | 'audible' | 'cancelled' | 'rejected';

export type ChangeStatus = {
  state: ChangeState;
  requestId: number;
  /** The bar it is queued for, 1-based. */
  bar?: number;
  reason?: number;
};

/** One undo step: the lanes it changed, before and after (null = the factory lane). */
export type HistoryEntry = {
  label: string;
  before: LaneChange;
  after: LaneChange;
};

export type Preview = {
  lane: LaneId;
  candidate: Pattern;
  /** What the candidate is, for the header: "Variation · seed 42". */
  title: string;
  summary: string;
  scope: string;
};

const HISTORY_LIMIT = 200;

/** Request ids for pattern revisions; kept apart from scene ids by starting high. */
let nextId = 1_000_000;

export function usePatternWorkspace({
  track,
  liveDeck,
  generation,
}: {
  track: TrackArrangement | null;
  liveDeck: Deck;
  /** The live deck's track generation, read when a revision is sent. */
  generation: () => number;
}) {
  const [working, setWorking] = useState<Patterns>({});
  const [audible, setAudible] = useState<Patterns>({});
  const staged = useRef<{ id: number; lanes: Patterns } | null>(null);
  const [locks, setLocks] = useState<Locks>(NO_LOCKS);
  const [undoStack, setUndoState] = useState<HistoryEntry[]>([]);
  const [redoStack, setRedoState] = useState<HistoryEntry[]>([]);
  // The stacks are read through refs so two undos in one frame each take one step.
  const undoRef = useRef(undoStack);
  const redoRef = useRef(redoStack);
  const setUndo = (f: (u: HistoryEntry[]) => HistoryEntry[]) => {
    undoRef.current = f(undoRef.current);
    setUndoState(undoRef.current);
  };
  const setRedo = (f: (u: HistoryEntry[]) => HistoryEntry[]) => {
    redoRef.current = f(redoRef.current);
    setRedoState(redoRef.current);
  };
  const [status, setStatus] = useState<ChangeStatus>({ state: 'none', requestId: 0 });
  const [preview, setPreview] = useState<Preview | null>(null);

  const workingRef = useRef(working);
  workingRef.current = working;
  const trackRef = useRef(track);
  trackRef.current = track;
  const statusRef = useRef(status);
  statusRef.current = status;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const generationRef = useRef(generation);
  generationRef.current = generation;
  /** Lanes this session has sent to the engine; every revision carries all of them. */
  const touched = useRef(new Set<LaneId>());
  const restoredTrack = useRef<string | null>(null);

  // A new track is a new project: nothing edited, nothing to undo. The engine
  // withdraws any revision staged for the old track itself (`track`).
  const trackId = track?.id;
  useEffect(() => {
    if (restoredTrack.current === trackId) { restoredTrack.current = null; return; }
    setWorking({});
    setAudible({}); staged.current = null;
    setLocks(NO_LOCKS);
    setUndo(() => []);
    setRedo(() => []);
    previewRef.current = null;
    setPreview(null);
    setStatus({ state: 'none', requestId: 0 });
    touched.current = new Set();
  }, [trackId]);

  /** Restore accepted composition only. A load clears previews and local history. */
  function restore(source: TrackArrangement, lanes: Patterns, nextLocks: Locks, fresh = false) {
    if (trackRef.current?.id !== source.id) restoredTrack.current = source.id;
    trackRef.current = source;
    previewRef.current = null;
    setPreview(null);
    workingRef.current = structuredClone(lanes);
    setWorking(workingRef.current);
    setLocks(structuredClone(nextLocks));
    setUndo(() => []); setRedo(() => []);
    touched.current = new Set(fresh ? [] : LANE_IDS);
    if (fresh) {
      staged.current = null; setAudible({});
      statusRef.current = { state: 'none', requestId: 0 }; setStatus(statusRef.current);
    } else stage(workingRef.current);
  }

  /** Send `lanes` (the composition to hear) as one revision. */
  function stage(lanes: Patterns, extraLanes: LaneId[] = []) {
    const t = trackRef.current;
    if (!t) return;
    for (const l of [...Object.keys(lanes), ...extraLanes] as LaneId[]) touched.current.add(l);
    const set = LANE_IDS.filter((l) => touched.current.has(l)).map((l) => lanes[l] ?? factoryPattern(t, l));
    if (set.length === 0) return;
    const requestId = nextId++;
    staged.current = { id: requestId, lanes: structuredClone(lanes) };
    if (!engine.booted) setAudible(staged.current.lanes);
    // Before the first Play there is no engine to answer: the revision is held and
    // sent when it boots, so it is what playback starts with.
    const next: ChangeStatus = { state: engine.booted ? 'sending' : 'audible', requestId };
    statusRef.current = next;
    setStatus(next);
    engine.queuePatterns(requestId, 2, compileLanes(set), generationRef.current());
  }

  // The engine's word on each revision. Only the latest request is followed: an older
  // one being replaced is the expected outcome of editing again.
  useEffect(
    () =>
      engine.onSceneEvents((events) => {
        for (const e of events) {
          if (e.kind < PATTERN_EVENT.queued || e.kind > PATTERN_EVENT.rejected) continue;
          const current = statusRef.current;
          if (e.requestId !== current.requestId) continue;
          let next: ChangeStatus | null = null;
          if (e.kind === PATTERN_EVENT.queued) next = { ...current, state: 'queued', bar: e.a };
          else if (e.kind === PATTERN_EVENT.applied) {
            next = { state: 'audible', requestId: e.requestId };
            if (staged.current?.id === e.requestId) setAudible(staged.current.lanes);
          }
          else if (e.kind === PATTERN_EVENT.cancelled) next = { state: 'cancelled', requestId: e.requestId, reason: e.a };
          else if (e.kind === PATTERN_EVENT.rejected) next = { state: 'rejected', requestId: e.requestId, reason: e.a };
          if (next) {
            statusRef.current = next;
            setStatus(next);
          }
        }
      }),
    [],
  );

  /**
   * Accept an edit: `lanes` maps each changed lane to its new pattern, or null to go
   * back to the factory lane. One call is one undo step.
   */
  function commit(label: string, lanes: LaneChange) {
    const before = inverseOf(workingRef.current, lanes);
    const next = applyChange(workingRef.current, lanes);
    workingRef.current = next;
    setWorking(next);
    setUndo((u) => [...u.slice(-(HISTORY_LIMIT - 1)), { label, before, after: lanes }]);
    setRedo(() => []);
    stage(next, Object.keys(lanes) as LaneId[]);
  }

  function applyEntry(entry: HistoryEntry, side: 'before' | 'after') {
    const lanes = entry[side];
    const next = applyChange(workingRef.current, lanes);
    workingRef.current = next;
    setWorking(next);
    stage(next, Object.keys(lanes) as LaneId[]);
  }

  function undo() {
    if (previewRef.current) return;
    const entry = undoRef.current.at(-1);
    if (!entry) return;
    setUndo((u) => u.slice(0, -1));
    setRedo((r) => [...r, entry]);
    applyEntry(entry, 'before');
  }

  function redo() {
    if (previewRef.current) return;
    const entry = redoRef.current.at(-1);
    if (!entry) return;
    setRedo((r) => r.slice(0, -1));
    setUndo((u) => [...u, entry]);
    applyEntry(entry, 'after');
  }

  // ---- Preview, Keep, Revert ---------------------------------------------------

  function startPreview(p: Preview) {
    previewRef.current = p;
    setPreview(p);
    stage({ ...workingRef.current, [p.lane]: p.candidate }, [p.lane]);
  }

  function keepPreview() {
    const p = previewRef.current;
    if (!p) return;
    previewRef.current = null;
    setPreview(null);
    commit(p.title, { [p.lane]: p.candidate });
  }

  function revertPreview() {
    const p = previewRef.current;
    if (!p) return;
    previewRef.current = null;
    setPreview(null);
    stage(workingRef.current, [p.lane]);
  }

  // ---- Scenes ------------------------------------------------------------------

  /**
   * What a capture stores: a pinned copy of every lane this session has edited, and
   * the factory marker for a lane it touched and put back. Lanes nobody touched are
   * left out, so a scene captured from an unedited track launches the mix only.
   */
  function sceneLanes(): ScenePatterns {
    const out: ScenePatterns = {};
    for (const lane of LANE_IDS) {
      const p = workingRef.current[lane];
      if (p) out[lane] = clonePattern(p);
      else if (touched.current.has(lane)) out[lane] = { factory: true };
    }
    return out;
  }

  /** The payload a launch carries for the lanes `scene` sets, or undefined if none. */
  function scenePayload(scene: ScenePatterns): Float32Array | undefined {
    const t = trackRef.current;
    const lanes = Object.keys(scene) as LaneId[];
    if (!t || lanes.length === 0) return undefined;
    return compileLanes(
      lanes.map((l) => {
        const v = scene[l]!;
        return isFactoryRef(v) ? factoryPattern(t, l) : v;
      }),
    );
  }

  /** Whether the working patterns differ from what `scene` would set. */
  function differsFrom(scene: ScenePatterns): boolean {
    const t = trackRef.current;
    if (!t) return false;
    for (const lane of Object.keys(scene) as LaneId[]) {
      const v = scene[lane]!;
      const want = isFactoryRef(v) ? factoryPattern(t, lane) : v;
      if (!sameEvents(lanePattern(t, workingRef.current, lane), want)) return true;
    }
    return false;
  }

  /**
   * A scene that set lanes has applied: the working patterns take its lanes, as one
   * undoable step. If an edit was still on its way to the engine it is sent again
   * on top of the scene's lanes, so the engine never ends up behind the screen.
   * `send` is for a launch applied before the engine has booted, which nothing
   * carried to the engine yet.
   */
  function adoptScene(name: string, scene: ScenePatterns, send = false) {
    // A launch ends a preview: what plays now is the scene over the working lanes.
    const hadPreview = previewRef.current !== null;
    if (hadPreview) {
      previewRef.current = null;
      setPreview(null);
    }
    const lanes = Object.keys(scene) as LaneId[];
    if (lanes.length === 0) {
      if (hadPreview) stage(workingRef.current);
      return;
    }
    const change: LaneChange = {};
    for (const lane of lanes) {
      const v = scene[lane]!;
      change[lane] = isFactoryRef(v) ? null : clonePattern(v);
      touched.current.add(lane);
    }
    const before = inverseOf(workingRef.current, change);
    const next = applyChange(workingRef.current, change);
    workingRef.current = next;
    setWorking(next);
    setUndo((u) => [...u.slice(-(HISTORY_LIMIT - 1)), { label: `Launch ${name}`, before, after: change }]);
    setRedo(() => []);
    const s = statusRef.current.state;
    setAudible(structuredClone(next));
    if (send || hadPreview || s === 'sending' || s === 'queued') stage(next);
  }

  // ---- Locks -------------------------------------------------------------------

  function toggleLaneLock(lane: LaneId) {
    setLocks((l) => ({
      ...l,
      lanes: l.lanes.includes(lane) ? l.lanes.filter((x) => x !== lane) : LANE_IDS.filter((x) => x === lane || l.lanes.includes(x)),
    }));
  }

  function toggleEventLock(lane: LaneId, id: string) {
    setLocks((l) => {
      const ids = new Set(l.events[lane] ?? []);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      const events = { ...l.events };
      if (ids.size) events[lane] = [...ids].sort();
      else delete events[lane];
      return { ...l, events };
    });
  }

  /** Re-send the working patterns now (Audition), as a revision applied at once. */
  function stageNow() {
    stage(workingRef.current);
  }

  const canUndo = undoStack.length > 0 && !preview;
  const canRedo = redoStack.length > 0 && !preview;

  return useMemo(
    () => ({
      working,
      audible,
      locks,
      status,
      preview,
      canUndo,
      canRedo,
      undoLabel: undoStack.at(-1)?.label,
      redoLabel: redoStack.at(-1)?.label,
      liveDeck,
      lane: (id: LaneId) => (track ? lanePattern(track, working, id) : null),
      commit,
      undo,
      redo,
      startPreview,
      keepPreview,
      revertPreview,
      sceneLanes,
      scenePayload,
      differsFrom,
      adoptScene,
      toggleLaneLock,
      toggleEventLock,
      stageNow,
      restore,
    }),
    // Functions read refs or the state listed; recomputed when any of it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [working, audible, locks, status, preview, undoStack, redoStack, track, liveDeck],
  );
}

export type PatternWorkspace = ReturnType<typeof usePatternWorkspace>;
