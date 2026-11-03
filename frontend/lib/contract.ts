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
import type { StemId, TrackArrangement, TrackSummary } from './types';

export const PROJECT_FORMAT = 'bckgrnd-msc/project';
export const PROJECT_VERSION = 1;

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
  default: number | boolean | 'track';
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

/** The range of a per-stem parameter (`volume`), from the registry's stemParameters. */
export function stemRange(id: 'volume'): { min: number; max: number; step: number } {
  const spec = STEM_PARAMETERS.find((p) => p.id === id);
  if (!spec) throw new Error(`unknown stem parameter: ${id}`);
  return { min: spec.min ?? 0, max: spec.max ?? 1, step: spec.step ?? 0.01 };
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

export type StemSettings = { volume: number; muted: boolean; solo: boolean };

export type ProjectV1 = {
  format: typeof PROJECT_FORMAT;
  version: 1;
  id?: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  trackId: string;
  params: Record<ParamId, number>;
  stems: Record<StemId, StemSettings>;
  /** Reserved for pattern edits. Empty in version 1. */
  patterns: Record<string, never>;
};

const PROJECT_PARAMS = PARAMETERS.filter((p) => p.scope === 'project').map((p) => p.id as ParamId);

/** A fresh project: the track as written, every parameter at its default. */
export function projectFromTrack(track: TrackSummary | TrackArrangement): ProjectV1 {
  const params = {} as Record<ParamId, number>;
  for (const id of PROJECT_PARAMS) params[id] = trackDefault(id, track);
  const stems = {} as Record<StemId, StemSettings>;
  for (const id of STEMS) stems[id] = { volume: track.mix[id] ?? 0.8, muted: false, solo: false };
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: track.name,
    trackId: track.id,
    params,
    stems,
    patterns: {},
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
 * Read any supported document into a complete version 1 project.
 *
 * Accepts version 1, and a legacy preset (no `format`). Refuses an unknown format or
 * a newer version rather than half-reading it. `lookup` resolves the track, so a
 * project for a track this build does not have is refused too.
 *
 * Mirrors `Contract::migrate()` in PHP; `tools/check-contract.mjs` runs both against
 * the same fixtures.
 */
export function migrateProject(
  raw: unknown,
  lookup: (id: string) => TrackSummary | undefined,
): ProjectV1 {
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
    stems[id] = {
      volume: Math.min(1, Math.max(0, volume)),
      muted: Boolean(g.muted ?? false),
      solo: Boolean(g.solo ?? false),
    };
  }

  const out: ProjectV1 = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: typeof doc.name === 'string' && doc.name !== '' ? doc.name : track.name,
    trackId: track.id,
    params,
    stems,
    patterns: {},
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
  };
}

/** A legacy preset as a version 1 document. Effects were never saved, so they default. */
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
    version: PROJECT_VERSION,
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
export function sameMusic(a: ProjectV1, b: ProjectV1): boolean {
  if (a.trackId !== b.trackId) return false;
  for (const id of PROJECT_PARAMS) if (Math.abs(a.params[id] - b.params[id]) > 1e-6) return false;
  for (const id of STEMS) {
    const x = a.stems[id];
    const y = b.stems[id];
    if (Math.abs(x.volume - y.volume) > 1e-6 || x.muted !== y.muted || x.solo !== y.solo) {
      return false;
    }
  }
  return true;
}
