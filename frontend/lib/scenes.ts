/**
 * Scenes and Compare A/B, as the UI reasons about them. Pure: no React, no engine.
 *
 * Three kinds of state are kept apart (docs/NIGHT3_PROTOCOL.md):
 *
 * - **Stored snapshots**: the project's four scene slots, plus the session-only
 *   Compare A/B slots. Changed only by an explicit action (capture, rename,
 *   duplicate, reset, update).
 * - **Working mix**: what the knobs and faders show and the engine's base values.
 * - **Temporary overrides**: held gestures, which live in the engine only and are
 *   never part of the working mix, so a capture can never pick one up.
 *
 * A scene is applied by the engine at a musical boundary. The UI's idea of what is
 * active changes only when the engine says `applied`.
 */

import {
  FACTORY_SCENES,
  SCENE_PARAMS,
  SCENE_SLOTS,
  STEMS,
  factoryScene,
  type ParamId,
  type Scene,
  type SceneSlotId,
  type Scenes,
  type StemSettings,
} from './contract';
import type { StemId, TrackArrangement, TrackSummary } from './types';

export { factoryScenes } from './contract';

/** The part of the working mix a scene covers. */
export type SceneMix = {
  params: Record<ParamId, number>;
  stems: Record<StemId, StemSettings>;
};

/** Length of the engine's scene vector: 8 stems x 4, then the scene parameters. */
export const SCENE_VECTOR_LENGTH = STEMS.length * 4 + SCENE_PARAMS.length;

/** The engine's scene vector for a mix (layout in docs/NIGHT3_PROTOCOL.md). */
export function sceneVector(mix: SceneMix): Float32Array {
  const out = new Float32Array(SCENE_VECTOR_LENGTH);
  STEMS.forEach((id, i) => {
    const s = mix.stems[id];
    out[4 * i] = s.volume;
    out[4 * i + 1] = s.send;
    out[4 * i + 2] = s.muted ? 1 : 0;
    out[4 * i + 3] = s.solo ? 1 : 0;
  });
  SCENE_PARAMS.forEach((id, j) => {
    out[STEMS.length * 4 + j] = mix.params[id];
  });
  return out;
}

/** A copy of just the scene part of a mix, so later edits cannot reach a snapshot. */
export function copyMix(mix: SceneMix): SceneMix {
  const params = {} as Record<ParamId, number>;
  for (const id of SCENE_PARAMS) params[id] = mix.params[id];
  const stems = {} as Record<StemId, StemSettings>;
  for (const id of STEMS) stems[id] = { ...mix.stems[id] };
  return { params, stems };
}

/** Whether two mixes sound the same as far as a scene is concerned. */
export function sameMix(a: SceneMix, b: SceneMix): boolean {
  for (const id of SCENE_PARAMS) if (Math.abs(a.params[id] - b.params[id]) > 1e-6) return false;
  for (const id of STEMS) {
    const x = a.stems[id];
    const y = b.stems[id];
    if (
      Math.abs(x.volume - y.volume) > 1e-6 ||
      Math.abs(x.send - y.send) > 1e-6 ||
      x.muted !== y.muted ||
      x.solo !== y.solo
    ) {
      return false;
    }
  }
  return true;
}

/** The slot index, for the menu's "Duplicate to" list and keyboard shortcuts. */
export const slotIndex = (slot: SceneSlotId) => SCENE_SLOTS.indexOf(slot);

/** One slot, replaced, with every other slot untouched. */
function withSlot(scenes: Scenes, next: Scene): Scenes {
  return { slots: scenes.slots.map((s) => (s.slot === next.slot ? next : s)) };
}

/**
 * Capture the working mix into a slot. The name and factory recipe stay; the
 * revision goes up, so anything already queued from the old revision is not changed
 * by this (the engine holds its own copy).
 */
export function captureScene(scenes: Scenes, slot: SceneSlotId, working: SceneMix): Scenes {
  const old = scenes.slots.find((s) => s.slot === slot);
  if (!old) return scenes;
  const mix = copyMix(working);
  return withSlot(scenes, { ...old, revision: old.revision + 1, params: mix.params, stems: mix.stems });
}

/** Rename a slot. Trimmed, 1 to 40 characters; anything else is refused (null). */
export function renameScene(scenes: Scenes, slot: SceneSlotId, name: string): Scenes | null {
  const clean = name.trim();
  if (clean === '' || [...clean].length > 40) return null;
  const old = scenes.slots.find((s) => s.slot === slot);
  if (!old) return null;
  return withSlot(scenes, { ...old, name: clean, revision: old.revision + 1 });
}

/** Copy one slot's mix (and name) into another slot. */
export function duplicateScene(scenes: Scenes, from: SceneSlotId, to: SceneSlotId): Scenes {
  const src = scenes.slots.find((s) => s.slot === from);
  const dst = scenes.slots.find((s) => s.slot === to);
  if (!src || !dst || from === to) return scenes;
  const mix = copyMix(src);
  return withSlot(scenes, { ...dst, name: src.name, revision: dst.revision + 1, params: mix.params, stems: mix.stems });
}

/** Put a slot back to its factory recipe for this track. */
export function resetScene(
  scenes: Scenes,
  slot: SceneSlotId,
  track: TrackSummary | TrackArrangement,
): Scenes {
  const old = scenes.slots.find((s) => s.slot === slot);
  if (!old) return scenes;
  return withSlot(scenes, factoryScene(track, old.factory, slot, old.revision + 1));
}

/** The short description shown in a slot's menu. */
export function sceneDescription(scene: Scene): string {
  return FACTORY_SCENES.find((r) => r.id === scene.factory)?.description ?? '';
}

// ---- Requests and what the engine says about them ---------------------------

export type Timing = 'now' | 'beat' | 'bar';
export const TIMING_CODE: Record<Timing, number> = { now: 0, beat: 1, bar: 2 };

/**
 * What a launch is of: a scene slot, one of the session-only compare slots, or the
 * working mix from before a comparison began (Exit Comparison).
 */
export type LaunchTarget = SceneSlotId | 'compareA' | 'compareB' | 'restore';

/** Whether a launch target is one of the four scene slots. */
export const isSceneSlot = (t: LaunchTarget): t is SceneSlotId =>
  t !== 'compareA' && t !== 'compareB' && t !== 'restore';

/**
 * Compare A/B: two session-only mixes of the same track on the same engine and
 * playhead. Never saved, never a scene, nothing to do with Deck A / Deck B.
 */
export type Compare = {
  a: SceneMix | null;
  b: SceneMix | null;
  /** Which one the engine last applied, or null before either was heard. */
  listening: 'a' | 'b' | null;
  /** The working mix when the comparison began, for Exit Comparison. */
  before: SceneMix;
  /** The scene that was active then, restored with it. */
  beforeActive: { slot: SceneSlotId; mix: SceneMix } | null;
};

export type RequestStatus = 'sending' | 'queued' | 'applied' | 'cancelled' | 'replaced' | 'rejected';

export type SceneRequest = {
  requestId: number;
  target: LaunchTarget;
  /** The slot's revision when the request was made: what is about to play. */
  revision: number;
  generation: number;
  timing: Timing;
  status: RequestStatus;
  /** The bar (1-based, of the 16-bar song) the engine predicts it lands on. */
  bar?: number;
  reason?: number;
  /** The exact mix that was sent, so `applied` can become the working mix. */
  mix: SceneMix;
};

/** Engine event kinds (docs/NIGHT3_PROTOCOL.md). */
export const EVENT = {
  sceneQueued: 1,
  sceneApplied: 2,
  sceneCancelled: 3,
  sceneReplaced: 4,
  sceneRejected: 5,
  fillQueued: 11,
  fillStarted: 12,
  fillEnded: 13,
  fillCancelled: 14,
  fillRejected: 15,
  gestureExpired: 21,
} as const;

/** Why something was refused or cancelled, in words for the status line. */
export const REASON: Record<number, string> = {
  1: 'not a valid mix',
  2: 'playback stopped',
  3: 'the playhead moved',
  4: 'the track changed',
  5: 'panic',
  6: 'not during a mix',
  7: 'playback is needed',
  8: 'already playing',
  9: 'the track changed',
  10: 'cancelled',
};

export type EngineEvent = { kind: number; id: number; a: number; b: number };

/** Split the worklet's flat event list (four numbers each) into events. */
export function readEvents(flat: ArrayLike<number>): EngineEvent[] {
  const out: EngineEvent[] = [];
  for (let i = 0; i + 3 < flat.length; i += 4) {
    out.push({ kind: flat[i]!, id: flat[i + 1]!, a: flat[i + 2]!, b: flat[i + 3]! });
  }
  return out;
}

/**
 * Fold one scene event into the pending request. Returns the updated request, or the
 * same object when the event is about some other request. A request that has
 * already settled (applied, cancelled, replaced, rejected) never changes again, so a
 * late or duplicated event cannot resurrect it.
 */
export function foldSceneEvent(request: SceneRequest, event: EngineEvent): SceneRequest {
  if (event.id !== request.requestId) return request;
  if (request.status !== 'sending' && request.status !== 'queued') return request;
  switch (event.kind) {
    case EVENT.sceneQueued:
      return { ...request, status: 'queued', bar: event.a };
    case EVENT.sceneApplied:
      return { ...request, status: 'applied' };
    case EVENT.sceneCancelled:
      return { ...request, status: 'cancelled', reason: event.a };
    case EVENT.sceneReplaced:
      return { ...request, status: 'replaced' };
    case EVENT.sceneRejected:
      return { ...request, status: 'rejected', reason: event.a };
    default:
      return request;
  }
}

/** A pending request is one the engine may still apply. */
export const isPending = (r: SceneRequest | null): r is SceneRequest =>
  r !== null && (r.status === 'sending' || r.status === 'queued');
