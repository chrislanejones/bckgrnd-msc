/**
 * Variations, as the editor asks for them.
 *
 * PHP writes every variation (`App\Support\Project\Variation`); the browser only
 * previews one. With Laravel running, the editor posts the lane as the user has it
 * now to `POST /api/variations`. The static build has no PHP, so it reads the catalog
 * `tools/export-variations.php` exported for each track as written, and uses an
 * entry only when the phrase on screen hashes the same as the one it was made from
 * (`sourceHash`). A phrase the user has changed has no entry: the answer is
 * "unavailable", with the reason, never a variation of different notes.
 */

import { request, usingStaticLibrary } from './api';
import {
  readPattern,
  sourceHash,
  type LaneId,
  type Locks,
  type Pattern,
  type PatternEvent,
  type Patterns,
} from './patterns';

export type Strength = 'subtle' | 'moderate' | 'adventurous';
export const STRENGTHS: Strength[] = ['subtle', 'moderate', 'adventurous'];
export const STRENGTH_LABEL: Record<Strength, string> = {
  subtle: 'Subtle',
  moderate: 'Moderate',
  adventurous: 'Adventurous',
};

export type VariationRequest = {
  trackId: string;
  lane: LaneId;
  from: number;
  to: number;
  strength: Strength;
  seed: number;
  source: Pattern;
  locks: Locks;
  /** The other lanes as they are now (the generator keeps closed and open hats apart). */
  context: Patterns;
};

export type VariationResult =
  | {
      status: 'ok';
      candidate: Pattern;
      mode: 'drums' | 'rhythm';
      reason: string | null;
      preserved: string[];
      from: 'api' | 'catalog';
    }
  | { status: 'unavailable'; reason: string };

type Wire =
  | { status: 'ok'; candidate: unknown; mode: 'drums' | 'rhythm'; reason: string | null; preserved: string[] }
  | { status: 'unavailable'; reason: string };

type CatalogEntry = {
  lane: LaneId;
  from: number;
  to: number;
  strength: Strength;
  seed: number;
  sourceHash: string;
  mode: 'drums' | 'rhythm';
  reason: string | null;
  preserved: string[];
  events: PatternEvent[];
};
type Catalog = { generator: string; seeds: number[]; entries: CatalogEntry[] };

const catalogs = new Map<string, Promise<Catalog>>();

function catalog(trackId: string): Promise<Catalog> {
  let c = catalogs.get(trackId);
  if (!c) {
    c = request<Catalog>(`/library/variations/${trackId}.json`);
    c.catch(() => catalogs.delete(trackId));
    catalogs.set(trackId, c);
  }
  return c;
}

/** The catalog's answer for `req`, with the same honesty rules as the API. */
export async function fromCatalog(req: VariationRequest): Promise<VariationResult> {
  if (req.locks.lanes.includes(req.lane)) return { status: 'unavailable', reason: 'This lane is locked.' };
  let cat: Catalog;
  try {
    cat = await catalog(req.trackId);
  } catch {
    return { status: 'unavailable', reason: 'The variation catalog is missing from this build.' };
  }
  if (!cat.seeds.includes(req.seed)) {
    return {
      status: 'unavailable',
      reason: `This build carries seeds ${cat.seeds.join(', ')} only; the desktop app can make any seed.`,
    };
  }
  const entry = cat.entries.find(
    (e) => e.lane === req.lane && e.from === req.from && e.to === req.to && e.strength === req.strength && e.seed === req.seed,
  );
  if (!entry) return { status: 'unavailable', reason: 'This build has no variation for that range.' };
  if (entry.sourceHash !== sourceHash(req.source, req.from, req.to)) {
    return {
      status: 'unavailable',
      reason:
        'This phrase has been changed, and this build only carries variations of the track as written. The desktop app can vary your own phrases.',
    };
  }
  // The catalog was made without locks: refuse an entry that would move a locked event.
  const locked = new Set(req.locks.events[req.lane] ?? []);
  const after = new Map(entry.events.map((e) => [e.id, e]));
  for (const e of req.source.events) {
    if (!locked.has(e.id) || e.step < req.from || e.step > req.to) continue;
    if (JSON.stringify(after.get(e.id)) !== JSON.stringify(e)) {
      return {
        status: 'unavailable',
        reason: 'That variation would change a locked event, and this build cannot work around locks. Try another seed.',
      };
    }
  }
  const outside = req.source.events.filter((e) => e.step < req.from || e.step > req.to);
  const raw = {
    id: req.source.id.startsWith('factory-') ? `p-${req.lane}` : req.source.id,
    revision: req.source.revision + 1,
    lane: req.lane,
    length: req.source.length,
    events: [...outside, ...entry.events],
    origin: {
      kind: 'variation',
      generator: cat.generator,
      seed: req.seed,
      strength: req.strength,
      scope: { from: req.from, to: req.to },
      sourceRevision: req.source.revision,
      sourceHash: entry.sourceHash,
      mode: entry.mode,
    },
  };
  return {
    status: 'ok',
    candidate: readPattern(raw, req.lane, 'variation'),
    mode: entry.mode,
    reason: entry.reason,
    preserved: entry.preserved,
    from: 'catalog',
  };
}

/** Ask PHP for a variation; without PHP (a static build, or the API down) ask the catalog. */
export async function requestVariation(req: VariationRequest): Promise<VariationResult> {
  if (usingStaticLibrary()) return fromCatalog(req);
  let wire: Wire;
  try {
    wire = await request<Wire>('/api/variations', {
      method: 'POST',
      body: JSON.stringify({
        lane: req.lane,
        from: req.from,
        to: req.to,
        strength: req.strength,
        seed: req.seed,
        source: req.source,
        locks: req.locks,
        context: req.context,
      }),
    });
  } catch (e) {
    // No PHP to ask (or it refused): the catalog may still have this one. If not, the
    // server's reason is the more useful one to show.
    const fallback = await fromCatalog(req);
    return fallback.status === 'ok' ? fallback : { status: 'unavailable', reason: (e as Error).message };
  }
  if (wire.status !== 'ok') return wire;
  return {
    status: 'ok',
    candidate: readPattern(wire.candidate, req.lane, 'variation'),
    mode: wire.mode,
    reason: wire.reason,
    preserved: wire.preserved,
    from: 'api',
  };
}
