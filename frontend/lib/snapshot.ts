/** Portable immutable project file. The envelope versions persistence separately
 * from the musical v3 contract; old apps refuse its unknown format safely. */
import { migrateProject, PROJECT_VERSION, type Project } from './contract';
import type { TrackArrangement, TrackSummary } from './types';

export const RENDERER_VERSION = 'project-renderer-1';
export type Snapshot = {
  format: 'bckgrnd-msc/snapshot';
  version: 1;
  id: string;
  revision: number;
  savedAt: string;
  renderer: typeof RENDERER_VERSION;
  source: { trackId: string; sha256: string };
  project: Project;
};

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function contentHash(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function snapshotOf(project: Project, source: TrackArrangement, id: string, revision: number): Promise<Snapshot> {
  // Copy before the first await: callers may continue editing during hashing/writing.
  const copy = structuredClone(project);
  return { format: 'bckgrnd-msc/snapshot', version: 1, id, revision,
    savedAt: new Date().toISOString(), renderer: RENDERER_VERSION,
    source: { trackId: source.id, sha256: await contentHash(source) }, project: copy };
}

/**
 * The source hash says which library data a project was saved against. A render has to
 * reproduce that exactly, so without `onSourceChanged` a different library is refused.
 * The app passes it: a library update must not lock anyone out of their own work.
 */
export async function readSnapshot(raw: unknown, tracks: TrackSummary[], source: (id: string) => Promise<TrackArrangement>, onSourceChanged?: (trackId: string) => void): Promise<Snapshot> {
  const doc = raw as Partial<Snapshot> | null;
  if (!doc || typeof doc !== 'object') throw new Error('A project file must be a JSON object.');
  const wrapped = doc.format === 'bckgrnd-msc/snapshot';
  if (wrapped) {
    const allowed = ['format', 'version', 'id', 'revision', 'savedAt', 'renderer', 'source', 'project'];
    if (Object.keys(doc).some((key) => !allowed.includes(key)) || typeof doc.savedAt !== 'string' || !Number.isFinite(Date.parse(doc.savedAt))) throw new Error('Malformed snapshot metadata.');
    if (!doc.source || Object.keys(doc.source).sort().join(',') !== 'sha256,trackId' || !/^[a-f0-9]{64}$/.test(doc.source.sha256)) throw new Error('Malformed source dependency.');
    if (doc.version !== 1) throw new Error(`Unsupported snapshot version: ${doc.version}. Keep the original file and use a compatible app.`);
    if (doc.renderer !== RENDERER_VERSION) throw new Error(`Unsupported renderer: ${doc.renderer}.`);
    if (typeof doc.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(doc.id) || !Number.isSafeInteger(doc.revision) || doc.revision! < 1) throw new Error('Invalid project identity or revision.');
    if (doc.project?.version !== PROJECT_VERSION) throw new Error('Unsupported musical project version in snapshot.');
  }
  const project = migrateProject(wrapped ? doc.project : raw, (id) => tracks.find((t) => t.id === id));
  // Current snapshots are canonical, complete documents. Never silently clamp,
  // drop unknown data, or repair corruption while validating a saved revision.
  if (wrapped && canonical(project) !== canonical(doc.project)) throw new Error('Project contains unsupported fields or invalid parameter values.');
  const arranged = await source(project.trackId);
  const hash = await contentHash(arranged);
  if (wrapped && doc.source?.trackId !== project.trackId) throw new Error(`Source library mismatch for ${project.trackId}. The file names a different track than its project.`);
  if (wrapped && doc.source?.sha256 !== hash) {
    if (!onSourceChanged) throw new Error(`Source library mismatch for ${project.trackId}. Install the matching library before opening or rendering this project.`);
    onSourceChanged(project.trackId);
  }
  return wrapped ? structuredClone(doc as Snapshot) : snapshotOf(project, arranged, crypto.randomUUID(), 1);
}
