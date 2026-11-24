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
import type { ScenePatterns } from './patterns';

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

/**
 * A mix laid out like the engine's scene vector, but in the store's own doubles. The
 * engine's copy (`sceneVector`) is float32; this is what those floats came from.
 */
export function sceneValues(mix: SceneMix): number[] {
  const out = new Array<number>(SCENE_VECTOR_LENGTH).fill(0);
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

/**
 * An engine vector read back without its float32 rounding, wherever the engine is
 * only holding a value the host gave it. Each slot takes the first of `known` (mixes
 * as `sceneValues`) whose float32 is exactly the engine's; a slot that matches none
 * (a build part way between two values) keeps the engine's number.
 *
 * Without this, following a build wrote float32 into the store: Echo time 1/8T came
 * back as 0.3333333432674408, which is not one of the registry's options, so a
 * project saved after it would not open again.
 */
export function exactValues(engine: ArrayLike<number>, known: readonly (readonly number[])[]): number[] {
  return Array.from({ length: engine.length }, (_, i) => {
    const got = Number(engine[i]);
    for (const mix of known) {
      const candidate = mix[i];
      if (candidate !== undefined && Math.fround(candidate) === got) return candidate;
    }
    return got;
  });
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
 * Capture the working mix into a slot. The name, factory recipe and Crash on launch
 * stay; the revision goes up, so anything already queued from the old revision is not changed
 * by this (the engine holds its own copy).
 */
export function captureScene(
  scenes: Scenes,
  slot: SceneSlotId,
  working: SceneMix,
  patterns: ScenePatterns = {},
): Scenes {
  const old = scenes.slots.find((s) => s.slot === slot);
  if (!old) return scenes;
  const mix = copyMix(working);
  return withSlot(scenes, {
    ...old,
    revision: old.revision + 1,
    params: mix.params,
    stems: mix.stems,
    patterns: JSON.parse(JSON.stringify(patterns)) as ScenePatterns,
  });
}

/** Rename a slot. Trimmed, 1 to 40 characters; anything else is refused (null). */
export function renameScene(scenes: Scenes, slot: SceneSlotId, name: string): Scenes | null {
  const clean = name.trim();
  if (clean === '' || [...clean].length > 40) return null;
  const old = scenes.slots.find((s) => s.slot === slot);
  if (!old) return null;
  return withSlot(scenes, { ...old, name: clean, revision: old.revision + 1 });
}

/** Copy one slot's mix (and name) into another slot. The target keeps its own Crash on launch. */
export function duplicateScene(scenes: Scenes, from: SceneSlotId, to: SceneSlotId): Scenes {
  const src = scenes.slots.find((s) => s.slot === from);
  const dst = scenes.slots.find((s) => s.slot === to);
  if (!src || !dst || from === to) return scenes;
  const mix = copyMix(src);
  return withSlot(scenes, {
    ...dst,
    name: src.name,
    revision: dst.revision + 1,
    params: mix.params,
    stems: mix.stems,
    patterns: JSON.parse(JSON.stringify(src.patterns)) as ScenePatterns,
  });
}

/**
 * Put a slot back to its factory mix for this track. Crash on launch is the user's
 * own choice, not part of the recipe, so it stays as it was.
 */
export function resetScene(
  scenes: Scenes,
  slot: SceneSlotId,
  track: TrackSummary | TrackArrangement,
): Scenes {
  const old = scenes.slots.find((s) => s.slot === slot);
  if (!old) return scenes;
  return withSlot(scenes, { ...factoryScene(track, old.factory, slot, old.revision + 1), crash: old.crash });
}

/**
 * Turn Crash on launch on or off for one slot (ADR-022). Explicit only: nothing else
 * ever sets it. The revision moves, as for a rename, so the slot reads as changed;
 * a launch already queued keeps the accent it was sent with.
 */
export function setSceneCrash(scenes: Scenes, slot: SceneSlotId, crash: boolean): Scenes {
  const old = scenes.slots.find((s) => s.slot === slot);
  if (!old || old.crash === crash) return scenes;
  return withSlot(scenes, { ...old, crash, revision: old.revision + 1 });
}

/** Stored levels for the miniature mixer, accounting for both cuts and solos. */
export function sceneLevels(scene: SceneMix): number[] {
  const soloing = STEMS.some((id) => scene.stems[id].solo);
  return STEMS.map((id) => {
    const stem = scene.stems[id];
    return stem.muted || (soloing && !stem.solo) ? 0 : stem.volume;
  });
}

const SCENE_SUMMARIES: Record<string, string> = {
  full: 'All eight sounds',
  sparse: 'Hats, bass & pad',
  build: 'Less bass, more echo',
  drop: 'Kick & bass return',
};

/** Describe the stored mix, not the slot's original recipe after a capture or copy. */
export function scenePreview(scene: Scene, track: TrackSummary | TrackArrangement) {
  const recipe = Object.keys(scene.patterns).length === 0
    ? FACTORY_SCENES.find((r) => sameMix(scene, factoryScene(track, r.id, scene.slot)))
    : undefined;
  if (recipe) {
    return { summary: SCENE_SUMMARIES[recipe.id] ?? recipe.name, description: recipe.description };
  }
  const count = sceneLevels(scene).filter((level) => level > 0).length;
  return {
    summary: `${count} sound${count === 1 ? '' : 's'} · custom mix`,
    description: 'Your captured levels, effects and patterns. Reset to factory restores this slot’s original mix.',
  };
}

// ---- Requests and what the engine says about them ---------------------------

export type Timing = 'now' | 'beat' | 'bar';
export const TIMING_CODE: Record<Timing, number> = { now: 0, beat: 1, bar: 2 };

/**
 * What a launch is of: a scene slot, one of the session-only compare slots, or the
 * working mix from before a comparison or scene selection began.
 */
export type LaunchTarget = SceneSlotId | 'compareA' | 'compareB' | 'restore' | 'restoreScene';

/** Whether a launch target is one of the four scene slots. */
export const isSceneSlot = (t: LaunchTarget): t is SceneSlotId =>
  SCENE_SLOTS.includes(t as SceneSlotId);

/**
 * Compare A/B: two session-only mixes of the same track on the same engine and
 * playhead. Never saved, never a scene, nothing to do with Deck A / Deck B.
 */
export type Compare = {
  a: SceneMix | null;
  b: SceneMix | null;
  /** Which one the engine last applied, or null before either was heard. */
  listening: 'a' | 'b' | null;
  /** Exit's return point: the first capture, or the mix restored by Cancel scene. */
  before: SceneMix;
  /** The scene that was active then, restored with it. */
  beforeActive: { slot: SceneSlotId; mix: SceneMix } | null;
};

export type RequestStatus =
  | 'sending'
  | 'queued'
  | 'building'
  | 'applied'
  | 'cancelled'
  | 'replaced'
  | 'rejected';

/** How many bars a timed build rises over (docs/NIGHT7_PROTOCOL.md). */
export type BuildBars = 2 | 4 | 8;
export const BUILD_BAR_CHOICES: readonly BuildBars[] = [2, 4, 8];

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
  /** The lanes the launch sets (Night 4), adopted as the working patterns on `applied`. */
  lanes?: ScenePatterns;
  /**
   * Set when the launch is a timed build (Night 7): the mix rises to the scene over
   * `bars` bars instead of switching on one onset. `bar` is the bar of the build now
   * playing (1 to `bars`) once it has started. `fill` (Rise + Fill, Night 8) is the fill
   * that plays its last bar, under its own request id; `filling` once it has started.
   */
  build?: { bars: BuildBars; bar?: number; fill?: LinkedFill };
  /**
   * Set when the launch is the scene half of a Fill into (Night 8): it lands on the
   * onset its fill ends. `filling` once that fill has started.
   */
  fillInto?: LinkedFill;
};

/** The fill a Fill into's scene or a Rise waits on (docs/NIGHT8_PROTOCOL.md). */
export type LinkedFill = { fillId: number; filling?: boolean };

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
  buildQueued: 41,
  buildApplied: 42,
  buildCancelled: 43,
  buildReplaced: 44,
  buildRejected: 45,
  buildStarted: 46,
  buildProgress: 47,
  fillLinked: 51,
  fillUnlinked: 52,
  accentFired: 53,
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
  11: 'its Rise was replaced',
};

/**
 * Why a build was not started, where a scene's wording would mislead: a build is
 * refused (not cancelled) during a scratch, brake or backspin, and needs playback.
 */
export const BUILD_REFUSAL: Record<number, string> = {
  3: 'not while the deck is scratched or braking',
  7: 'press Play first',
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
  if (!isPending(request)) return request;
  if (request.build) return foldBuildEvent(request, request.build, event);
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

/**
 * The same fold for a timed build (kinds 41-47, docs/NIGHT7_PROTOCOL.md). `started`
 * is bar 1 of n and `progress` carries the bar now playing; neither settles it.
 */
function foldBuildEvent(
  request: SceneRequest,
  build: NonNullable<SceneRequest['build']>,
  event: EngineEvent,
): SceneRequest {
  switch (event.kind) {
    case EVENT.buildQueued:
      // A loop change re-announces a waiting build with its new bar; once it has
      // started, a late one must not rewind it.
      return request.status === 'building' ? request : { ...request, status: 'queued', bar: event.a };
    case EVENT.buildStarted:
      return { ...request, status: 'building', build: { ...build, bar: 1 } };
    case EVENT.buildProgress:
      return { ...request, status: 'building', build: { ...build, bar: event.a } };
    case EVENT.buildApplied:
      return { ...request, status: 'applied', build: { ...build, bar: build.bars } };
    case EVENT.buildCancelled:
      return { ...request, status: 'cancelled', reason: event.a };
    case EVENT.buildReplaced:
      return { ...request, status: 'replaced' };
    case EVENT.buildRejected:
      return { ...request, status: 'rejected', reason: event.a };
    default:
      return request;
  }
}

/** Where a fill request stands (docs/NIGHT3_PROTOCOL.md, docs/NIGHT8_PROTOCOL.md). */
export type FillStatus = 'sending' | 'queued' | 'playing' | 'ended' | 'cancelled' | 'rejected';

export type FillRequest = {
  requestId: number;
  status: FillStatus;
  /** The bar it plays (1-based), from `fillQueued`: a phrase fill's is the phrase's last. */
  bar?: number;
  /** The request it leads into (a Fill into's scene), from `fillLinked` until `fillUnlinked`. */
  linkedTo?: number;
  /** The step that request is predicted to land on, while linked. */
  landing?: number;
  reason?: number;
  /** For a refused linked request, the part refused (`b` of `fillRejected`). */
  part?: number;
};

/** Whether a fill request may still start or is playing. */
export const isFillPending = (f: FillRequest | null): f is FillRequest =>
  f !== null && (f.status === 'sending' || f.status === 'queued' || f.status === 'playing');

/**
 * Fold one engine event into a fill request (kinds 11-15, 51, 52). Returns the same
 * object for another request's event, and once the fill has ended, been cancelled or
 * been refused, nothing moves it again. A late `fillQueued` cannot rewind a playing fill.
 */
export function foldFillEvent<F extends FillRequest>(fill: F, event: EngineEvent): F {
  if (event.id !== fill.requestId || !isFillPending(fill)) return fill;
  switch (event.kind) {
    case EVENT.fillQueued:
      return fill.status === 'playing' ? fill : { ...fill, status: 'queued', bar: event.a };
    case EVENT.fillStarted:
      return { ...fill, status: 'playing' };
    case EVENT.fillEnded:
      return { ...fill, status: 'ended', ...(event.a < 0 ? { reason: event.b } : {}) };
    case EVENT.fillCancelled:
      return { ...fill, status: 'cancelled', reason: event.a };
    case EVENT.fillRejected:
      return { ...fill, status: 'rejected', reason: event.a, part: event.b };
    case EVENT.fillLinked:
      return { ...fill, linkedTo: event.a, landing: event.b };
    case EVENT.fillUnlinked: {
      const rest = { ...fill };
      delete rest.linkedTo;
      delete rest.landing;
      return rest;
    }
    default:
      return fill;
  }
}

/** Whether an engine event kind belongs to a fill (kinds 11-15, 51 and 52). */
export const isFillEvent = (kind: number): boolean =>
  (kind >= EVENT.fillQueued && kind <= EVENT.fillRejected) ||
  kind === EVENT.fillLinked ||
  kind === EVENT.fillUnlinked;
/**
 * The status line for `accentFired` (kind 53, `b`: 0 silent under a solo, 1 played,
 * 2 merged with the Drop's own crash). A crash you could hear is said; a silent one
 * under a solo says nothing, so the line stays "<name> active".
 */
export function accentStatus(name: string, b: number): string | null {
  return b === 1 || b === 2 ? `${name} active, with a crash` : null;
}

/** Whether an engine event kind belongs to a scene launch or a timed build. */
export const isLaunchEvent = (kind: number): boolean =>
  (kind >= EVENT.sceneQueued && kind <= EVENT.sceneRejected) ||
  (kind >= EVENT.buildQueued && kind <= EVENT.buildProgress);

/** A pending request is one the engine may still apply. */
export const isPending = (r: SceneRequest | null): r is SceneRequest =>
  r !== null && (r.status === 'sending' || r.status === 'queued' || r.status === 'building');

// ---- Every request the engine may still apply ---------------------------------

/**
 * The host's record of its launches, one per request id. The engine settles every
 * request with exactly one of applied, cancelled, replaced or refused
 * (docs/NIGHT7_PROTOCOL.md), so each pending one is kept until its own outcome
 * arrives. The host never guesses what a newer request did to an older one: a refused
 * or cancelled newer request leaves an older one pending, and a scene queued over a
 * running Rise only replaces the Rise if it commits.
 */
export type RequestBook = {
  /** Every request the engine may still apply, oldest first. */
  pending: readonly SceneRequest[];
  /**
   * The request the pads, Cancel and the status line speak for: the newest sent, or,
   * once that one settles without landing, the newest still pending. Null before any.
   */
  shown: SceneRequest | null;
};

export const EMPTY_BOOK: RequestBook = { pending: [], shown: null };

/** A request just sent: it is the one shown, and every older pending one is kept. */
export function bookSend(book: RequestBook, request: SceneRequest): RequestBook {
  return { pending: [...book.pending, request], shown: request };
}

/** The pending request with this id, or the shown one if it has it. */
export function bookFind(book: RequestBook, id: number): SceneRequest | null {
  return book.pending.find((r) => r.requestId === id) ?? (book.shown?.requestId === id ? book.shown : null);
}

/** The newest pending timed build, if one is running or waiting. */
export function bookBuild(book: RequestBook): SceneRequest | null {
  return book.pending.filter((r) => r.build).at(-1) ?? null;
}

/** A request's record replaced by `next` (same id), wherever the book holds it. */
export function bookUpdate(book: RequestBook, next: SceneRequest): RequestBook {
  const pending = book.pending.flatMap((r) => (r.requestId !== next.requestId ? [r] : isPending(next) ? [next] : []));
  return { pending, shown: book.shown?.requestId === next.requestId ? next : book.shown };
}

/**
 * Everything pending cancelled at once by the engine, for `reason` (Panic, an
 * auto-mix): the book empties and the shown request reads cancelled. `closing` is the
 * Rise among them, if one was waiting or running, even under a scene queued after it:
 * the engine still sends the base it restores as it cancels, and the knobs must follow
 * that base back although the Rise is no longer in the book.
 */
export function bookCancelAll(book: RequestBook, reason: number): { book: RequestBook; closing: SceneRequest | null } {
  const shown = book.shown;
  return {
    book: { pending: [], shown: isPending(shown) ? { ...shown, status: 'cancelled', reason } : shown },
    closing: bookBuild(book),
  };
}

/** What one engine event did to the book. */
export type BookStep = {
  book: RequestBook;
  /** The request the event was about, before and after. Equal when nothing moved. */
  prev: SceneRequest | null;
  next: SceneRequest | null;
  /** Whether that request was the one shown. */
  wasShown: boolean;
  /**
   * An older request shown again because the shown one settled without landing:
   * the engine is still running it.
   */
  resumed: SceneRequest | null;
};

/**
 * Fold one launch event (kinds 1-5, 41-47) into the book. An event for a request the
 * book does not hold, or one that moves nothing, returns the book unchanged.
 */
export function foldBookEvent(book: RequestBook, event: EngineEvent): BookStep {
  const prev = bookFind(book, event.id);
  const unchanged = { book, prev, next: prev, wasShown: book.shown?.requestId === event.id, resumed: null };
  if (!prev) return unchanged;
  const next = foldSceneEvent(prev, event);
  if (next === prev) return unchanged;
  let updated = bookUpdate(book, next);
  let resumed: SceneRequest | null = null;
  if (unchanged.wasShown && next.status !== 'applied' && !isPending(next)) {
    resumed = updated.pending.at(-1) ?? null;
    if (resumed) updated = { ...updated, shown: resumed };
  }
  return { book: updated, prev, next, wasShown: unchanged.wasShown, resumed };
}

/** The inverse of `sceneVector`: the mix a 44-value engine vector describes. */
export function mixFromVector(values: ArrayLike<number>): SceneMix {
  const stems = {} as Record<StemId, StemSettings>;
  STEMS.forEach((id, i) => {
    stems[id] = {
      volume: Number(values[4 * i]),
      send: Number(values[4 * i + 1]),
      muted: Number(values[4 * i + 2]) > 0.5,
      solo: Number(values[4 * i + 3]) > 0.5,
    };
  });
  const params = {} as Record<ParamId, number>;
  SCENE_PARAMS.forEach((id, j) => {
    params[id] = Number(values[STEMS.length * 4 + j]);
  });
  return { params, stems };
}
