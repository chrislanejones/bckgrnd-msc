/**
 * The project and parameter contract, as the UI reads it.
 *
 * `contracts/parameters.json` is the one list of parameters, shared with PHP
 * (`App\Support\Project\Contract`) and the MCP companion. Ranges and defaults are
 * read from it rather than restated here, so a control's limits and a saved
 * project's limits cannot disagree.
 *
 * A project is saved musical data. Telemetry (meters, playhead, live deck) is a
 * different type in `engine.ts` and is never part of a project.
 */

import registry from '../../contracts/parameters.json';
import scenesContract from '../../contracts/scenes.json';
import type { StemId, TrackArrangement, TrackSummary } from './types';

export const PROJECT_FORMAT = 'bckgrnd-msc/project';
export const PROJECT_VERSION = 2;

type Option = { value: number; label: string };

export type ParameterSpec = {
  id: string;
  label: string;
  kind: 'continuous' | 'enum' | 'toggle';
  min?: number;
  max?: number;
  step?: number;
  /** A narrower range the control offers than the engine accepts. */
  control?: { min: number; max: number };
  options?: Option[];
  default: number | boolean | 'track' | 'stem';
  /** Per-stem defaults, for a stem parameter whose default is "stem". */
  defaults?: Record<string, number>;
  /** How a control should spread the range: linear, log, db, or the engine's own curve. */
  taper?: 'linear' | 'log' | 'db' | 'engine';
  unit: string;
  scope: 'project' | 'performance';
  engine: string;
};

export type ParamId =
  | 'transport.bpm'
  | 'transport.swing'
  | 'master.level'
  | 'fx.low'
  | 'fx.mid'
  | 'fx.high'
  | 'fx.filter'
  | 'fx.stereo'
  | 'fx.filterQ'
  | 'fx.echoFeedback'
  | 'fx.echoReturn'
  | 'fx.reverbMix'
  | 'fx.reverbDecay'
  | 'fx.width'
  | 'fx.echoTime';

export const PARAMETERS = registry.parameters as ParameterSpec[];
export const STEMS = registry.stems as StemId[];

const byId = new Map(PARAMETERS.map((p) => [p.id, p]));

/** One parameter's spec. Throws on an id the registry does not list. */
export function param(id: string): ParameterSpec {
  const spec = byId.get(id);
  if (!spec) throw new Error(`unknown parameter: ${id}`);
  return spec;
}

/** The range a control should offer: its `control` range if narrower, else the engine's. */
export function controlRange(id: string): { min: number; max: number; step: number } {
  const spec = param(id);
  return {
    min: spec.control?.min ?? spec.min ?? 0,
    max: spec.control?.max ?? spec.max ?? 1,
    step: spec.step ?? 0.01,
  };
}

const STEM_PARAMETERS = registry.stemParameters as ParameterSpec[];

export function stemParam(id: 'volume' | 'send'): ParameterSpec {
  const spec = STEM_PARAMETERS.find((p) => p.id === id);
  if (!spec) throw new Error(`unknown stem parameter: ${id}`);
  return spec;
}

/** The range of a per-stem parameter, from the registry's stemParameters. */
export function stemRange(id: 'volume' | 'send'): { min: number; max: number; step: number } {
  const spec = stemParam(id);
  return { min: spec.min ?? 0, max: spec.max ?? 1, step: spec.step ?? 0.01 };
}

/** A stem's own default echo send. */
export function defaultSend(stem: StemId): number {
  return stemParam('send').defaults?.[stem] ?? 0;
}

/** A fixed default. Throws for a track-relative parameter; use `trackDefault` for those. */
export function fixedDefault(id: string): number {
  const d = param(id).default;
  if (d === 'track') throw new Error(`${id} defaults to the track's own value`);
  return Number(d);
}

export function trackDefault(id: ParamId, track: TrackSummary): number {
  const d = param(id).default;
  if (d !== 'track') return Number(d);
  if (id === 'transport.bpm') return track.bpm;
  if (id === 'transport.swing') return track.swing;
  throw new Error(`no track default for ${id}`);
}

export type StemSettings = { volume: number; send: number; muted: boolean; solo: boolean };

/** The four scene slots, in order (contracts/scenes.json). */
export const SCENE_SLOTS = ['full', 'sparse', 'build', 'drop'] as const;
export type SceneSlotId = (typeof SCENE_SLOTS)[number];

/** The parameters a scene holds, in the engine's scene-vector order. */
export const SCENE_PARAMS = scenesContract.sceneVector as ParamId[];

type FactoryRecipe = {
  id: string;
  name: string;
  description: string;
  stems: Partial<Record<StemId, { scale?: number; cut?: boolean }>>;
  params: Partial<Record<ParamId, number>>;
};
export const FACTORY_SCENES = scenesContract.factory as FactoryRecipe[];

/**
 * A stored scene: a complete snapshot of the mix (every stem, every scene parameter).
 * `revision` goes up on every overwrite, so a queued launch can pin what it plays.
 */
export type Scene = {
  slot: SceneSlotId;
  name: string;
  factory: string;
  revision: number;
  params: Record<ParamId, number>;
  stems: Record<StemId, StemSettings>;
  /** Pattern references arrive in Night 4. Empty until then. */
  patterns: Record<string, never>;
};

export type Scenes = { slots: Scene[] };

export type Project = {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  id?: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  trackId: string;
  params: Record<ParamId, number>;
  stems: Record<StemId, StemSettings>;
  /** Reserved for pattern edits (Night 4). Empty. */
  patterns: Record<string, never>;
  scenes: Scenes;
};

const PROJECT_PARAMS = PARAMETERS.filter((p) => p.scope === 'project').map((p) => p.id as ParamId);

/**
 * One factory scene for a track, built from its recipe relative to the track's own
 * mix: `scale` multiplies the track's level, `cut` mutes the stem, anything not
 * listed keeps the track's level and the registry default. Mirrors
 * `Contract::factoryScene()`.
 */
export function factoryScene(
  track: TrackSummary | TrackArrangement,
  recipeId: string,
  slot: SceneSlotId,
  revision = 1,
): Scene {
  const recipe = FACTORY_SCENES.find((r) => r.id === recipeId);
  if (!recipe) throw new Error(`No factory scene ${recipeId}`);
  const params = {} as Record<ParamId, number>;
  for (const id of SCENE_PARAMS) params[id] = recipe.params[id] ?? fixedDefault(id);
  const stems = {} as Record<StemId, StemSettings>;
  for (const id of STEMS) {
    const rule = recipe.stems[id] ?? {};
    const level = track.mix[id] ?? 0.8;
    stems[id] = {
      volume: Math.max(0, Math.min(1, level * (rule.scale ?? 1))),
      send: defaultSend(id),
      muted: Boolean(rule.cut ?? false),
      solo: false,
    };
  }
  return { slot, name: recipe.name, factory: recipeId, revision, params, stems, patterns: {} };
}

/** The four factory scenes for a track: each slot gets the recipe of the same name. */
export function factoryScenes(track: TrackSummary | TrackArrangement): Scenes {
  return { slots: SCENE_SLOTS.map((slot) => factoryScene(track, slot, slot)) };
}

/** A fresh project: the track as written, every parameter at its default. */
export function projectFromTrack(track: TrackSummary | TrackArrangement): Project {
  const params = {} as Record<ParamId, number>;
  for (const id of PROJECT_PARAMS) params[id] = trackDefault(id, track);
  const stems = {} as Record<StemId, StemSettings>;
  for (const id of STEMS) {
    stems[id] = { volume: track.mix[id] ?? 0.8, send: defaultSend(id), muted: false, solo: false };
  }
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: track.name,
    trackId: track.id,
    params,
    stems,
    patterns: {},
    scenes: factoryScenes(track),
  };
}

/** Whether a value is one the parameter accepts as written (refused, not clamped). */
function inRange(spec: ParameterSpec, value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (spec.kind === 'enum') return (spec.options ?? []).some((o) => Math.abs(o.value - value) < 1e-9);
  return (spec.min ?? -Infinity) <= value && value <= (spec.max ?? Infinity);
}

const sameKeys = (o: Loose, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && k.every((key, i) => key === keys[i]);
};
const sameKeySet = (o: Loose, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((key) => k.includes(key));
};

/**
 * Read version 2 scenes strictly. Every slot present, in order, complete; any
 * unknown key, wrong type, out-of-range value or pattern reference refuses the whole
 * set. Nothing is clamped or filled. Mirrors `Contract::readScenes()`, error text
 * included.
 */
export function readScenes(raw: unknown): Scenes {
  const fail = (why: string): never => {
    throw new Error(`Scenes are malformed: ${why}`);
  };
  if (!isObj(raw) || !sameKeys(raw, ['slots'])) fail('expected an object with only "slots"');
  const slots = (raw as Loose).slots;
  if (!Array.isArray(slots) || slots.length !== SCENE_SLOTS.length) fail(`expected ${SCENE_SLOTS.length} slots`);
  const keys = ['slot', 'name', 'factory', 'revision', 'params', 'stems', 'patterns'];
  const factoryIds = FACTORY_SCENES.map((r) => r.id);
  return {
    slots: (slots as unknown[]).map((scene, i) => {
      const slot = SCENE_SLOTS[i]!;
      if (!isObj(scene)) fail(`slot ${slot} is not an object`);
      const sc = scene as Loose;
      const present = Object.keys(sc);
      const extra = present.filter((k) => !keys.includes(k));
      const missing = keys.filter((k) => !present.includes(k));
      if (extra.length || missing.length) {
        fail(`slot ${slot} has keys ${JSON.stringify(extra)} and lacks ${JSON.stringify(missing)}`);
      }
      if (sc.slot !== slot) fail(`slot ${i} should be ${slot}`);
      if (typeof sc.name !== 'string' || sc.name === '' || [...sc.name].length > 40) {
        fail(`slot ${slot} needs a name of 1 to 40 characters`);
      }
      if (typeof sc.factory !== 'string' || !factoryIds.includes(sc.factory)) {
        fail(`slot ${slot} names an unknown factory scene`);
      }
      if (typeof sc.revision !== 'number' || !Number.isInteger(sc.revision) || sc.revision < 1) {
        fail(`slot ${slot} needs a whole-number revision of at least 1`);
      }
      // PHP reads {} and [] alike, so both are accepted as "no patterns".
      const pats = sc.patterns;
      const emptyPatterns = (isObj(pats) && Object.keys(pats).length === 0) || (Array.isArray(pats) && pats.length === 0);
      if (!emptyPatterns) fail(`slot ${slot} refers to patterns, which this version does not support`);

      if (!isObj(sc.params) || !sameKeySet(sc.params, SCENE_PARAMS)) {
        fail(`slot ${slot} must hold exactly the scene parameters`);
      }
      const params = {} as Record<ParamId, number>;
      for (const id of SCENE_PARAMS) {
        const value = (sc.params as Loose)[id];
        if (!inRange(param(id), value)) fail(`slot ${slot} has ${id} out of range`);
        params[id] = value as number;
      }

      if (!isObj(sc.stems) || !sameKeys(sc.stems, STEMS)) fail(`slot ${slot} must hold every stem, in order`);
      const stems = {} as Record<StemId, StemSettings>;
      for (const id of STEMS) {
        const entry = (sc.stems as Loose)[id];
        if (!isObj(entry) || !sameKeys(entry, ['volume', 'send', 'muted', 'solo'])) {
          fail(`slot ${slot} stem ${id} must have volume, send, muted and solo`);
        }
        const e = entry as Loose;
        for (const level of ['volume', 'send'] as const) {
          const v = e[level];
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
            fail(`slot ${slot} stem ${id} ${level} must be a number from 0 to 1`);
          }
        }
        if (typeof e.muted !== 'boolean' || typeof e.solo !== 'boolean') {
          fail(`slot ${slot} stem ${id} muted and solo must be true or false`);
        }
        stems[id] = { volume: e.volume as number, send: e.send as number, muted: e.muted as boolean, solo: e.solo as boolean };
      }
      return {
        slot,
        name: sc.name as string,
        factory: sc.factory as string,
        revision: sc.revision as number,
        params,
        stems,
        patterns: {},
      };
    }),
  };
}

function clamp(spec: ParameterSpec, value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (spec.kind === 'enum' && spec.options) {
    return spec.options.reduce(
      (best, o) => (Math.abs(o.value - n) < Math.abs(best - n) ? o.value : best),
      spec.options[0]!.value,
    );
  }
  return Math.min(spec.max ?? n, Math.max(spec.min ?? n, n));
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read any supported document into a complete version 2 project.
 *
 * Accepts version 2, version 1 (migrated by adding the track's factory scenes and
 * changing nothing else), and a legacy preset (no `format`). Refuses an unknown
 * format or a newer version rather than half-reading it, and refuses a version 2
 * document whose scenes do not read cleanly. `lookup` resolves the track, so a
 * project for a track this build does not have is refused too.
 *
 * Mirrors `Contract::migrate()` in PHP; `tools/check-contract.mjs` runs both against
 * the same fixtures.
 */
export function migrateProject(
  raw: unknown,
  lookup: (id: string) => TrackSummary | undefined,
): Project {
  if (!isObj(raw)) throw new Error('A project must be a JSON object.');
  let doc: Loose = raw;
  if (!('format' in doc)) doc = fromLegacyPreset(doc);
  if (doc.format !== PROJECT_FORMAT) {
    throw new Error(`Not a bckgrnd-msc project: format is ${JSON.stringify(doc.format)}`);
  }
  const version = doc.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('Project version is missing or invalid.');
  }
  if (version > PROJECT_VERSION) {
    throw new Error(
      `Project version ${version} is newer than this app understands (${PROJECT_VERSION}).`,
    );
  }
  if (version === 1 && 'scenes' in doc) throw new Error('A version 1 project cannot carry scenes.');
  if (version >= 2 && !('scenes' in doc)) throw new Error('Scenes are missing from a version 2 project.');

  const track = lookup(String(doc.trackId ?? ''));
  if (!track) throw new Error(`Unknown track: ${String(doc.trackId ?? '')}`);
  const fresh = projectFromTrack(track);

  const givenParams = isObj(doc.params) ? doc.params : {};
  const params = {} as Record<ParamId, number>;
  for (const id of PROJECT_PARAMS) params[id] = clamp(param(id), givenParams[id], fresh.params[id]);

  const givenStems = isObj(doc.stems) ? doc.stems : {};
  const stems = {} as Record<StemId, StemSettings>;
  for (const id of STEMS) {
    const g = isObj(givenStems[id]) ? (givenStems[id] as Loose) : {};
    const volume = typeof g.volume === 'number' ? g.volume : fresh.stems[id].volume;
    const send = typeof g.send === 'number' && Number.isFinite(g.send) ? g.send : fresh.stems[id].send;
    stems[id] = {
      volume: Math.min(1, Math.max(0, volume)),
      send: Math.min(1, Math.max(0, send)),
      muted: Boolean(g.muted ?? false),
      solo: Boolean(g.solo ?? false),
    };
  }

  // A version 1 project gets the track's factory scenes. Nothing is applied: the
  // working mix above is what it was.
  const scenes = 'scenes' in doc ? readScenes(doc.scenes) : fresh.scenes;

  const out: Project = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: typeof doc.name === 'string' && doc.name !== '' ? doc.name : track.name,
    trackId: track.id,
    params,
    stems,
    patterns: {},
    scenes,
  };
  if (typeof doc.id === 'string') out.id = doc.id;
  if (typeof doc.createdAt === 'string') out.createdAt = doc.createdAt;
  if (typeof doc.updatedAt === 'string') out.updatedAt = doc.updatedAt;
  // Key order matches PHP's, so the two serialize identically.
  return {
    format: out.format,
    version: out.version,
    ...(out.id !== undefined ? { id: out.id } : {}),
    name: out.name,
    ...(out.createdAt !== undefined ? { createdAt: out.createdAt } : {}),
    ...(out.updatedAt !== undefined ? { updatedAt: out.updatedAt } : {}),
    trackId: out.trackId,
    params: out.params,
    stems: out.stems,
    patterns: out.patterns,
    scenes: out.scenes,
  };
}

/** A legacy preset as a version 1 document (then migrated). Effects were never saved, so they default. */
function fromLegacyPreset(preset: Loose): Loose {
  const mix = isObj(preset.mix) ? preset.mix : {};
  const muted = isObj(preset.muted) ? preset.muted : {};
  const solo = isObj(preset.solo) ? preset.solo : {};
  const stems: Loose = {};
  for (const id of STEMS) {
    const entry: Loose = {};
    if (id in mix) entry.volume = Number(mix[id]);
    if (id in muted) entry.muted = Boolean(muted[id]);
    if (id in solo) entry.solo = Boolean(solo[id]);
    stems[id] = entry;
  }
  const params: Loose = {};
  if (preset.bpm !== undefined) params['transport.bpm'] = Number(preset.bpm);
  if (preset.swing !== undefined) params['transport.swing'] = Number(preset.swing);
  return {
    format: PROJECT_FORMAT,
    version: 1,
    ...(preset.id !== undefined ? { id: String(preset.id) } : {}),
    name: typeof preset.name === 'string' ? preset.name : '',
    ...(preset.updatedAt !== undefined ? { updatedAt: String(preset.updatedAt) } : {}),
    trackId: String(preset.trackId ?? ''),
    params,
    stems,
    patterns: {},
  };
}

/** Whether two projects describe the same music. Names and timestamps are ignored. */
export function sameMusic(a: Project, b: Project): boolean {
  if (a.trackId !== b.trackId) return false;
  for (const id of PROJECT_PARAMS) if (Math.abs(a.params[id] - b.params[id]) > 1e-6) return false;
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
