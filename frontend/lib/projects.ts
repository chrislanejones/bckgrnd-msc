import { useEffect, useRef, useState } from 'react';
import { fetchTrack } from './api';
import type { Instrument } from './instrument';
import { BrowserProjectStore, type ProjectRecord, type ProjectStore } from './project-store';
import { canonical, readSnapshot, snapshotOf, type Snapshot } from './snapshot';
import { DEFAULT_RENDER } from './project-renderer';
import { exportProject } from './export';
import { isPending } from './scenes';
import { isDesktop, NativeProjectStore, nativeAction } from './native-projects';

export function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function useProjects(inst: Instrument) {
  const store = useRef<ProjectStore>(isDesktop() ? new NativeProjectStore() : new BrowserProjectStore());
  const state = useRef({ id: crypto.randomUUID() as string, trackId: '', name: '', revision: 1, saved: 0, content: '' });
  const loading = useRef(false), saving = useRef(false);
  const [notice, setNotice] = useState('');
  const [records, setRecords] = useState<ProjectRecord[]>([]);
  const [, refresh] = useState(0);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const exportJob = useRef<AbortController | null>(null);
  const closing = useRef(false);
  const exportFinished = useRef<Promise<void> | null>(null);
  const p = inst.project;
  const current = state.current;
  // Identity changes on a source handover; no autosave ever consults liveDeck.
  if (p && !loading.current) {
    const content = canonical(p);
    if (current.trackId !== p.trackId) {
      Object.assign(current, { id: crypto.randomUUID(), trackId: p.trackId, name: p.name, revision: 1, saved: 0, content });
    } else if (current.content !== content) { current.content = content; current.revision++; }
  }
  const dirty = current.saved !== current.revision;
  const blocked = inst.mixing ? 'Available after mix' : isPending(inst.sceneRequest) ? 'Waiting for scene confirmation' : inst.compare?.listening ? 'Keep current or exit comparison first' : null;
  const latest = useRef(inst); latest.current = inst;

  async function snapshot(): Promise<Snapshot> {
    const i = latest.current;
    if (!i.project || !i.track) throw new Error('No project is open.');
    return snapshotOf({ ...i.project, name: state.current.name }, i.track, state.current.id, state.current.revision);
  }
  async function list() {
    try { setRecords(await store.current.list()); }
    catch (e) { setNotice(`Storage unavailable: ${(e as Error).message}`); }
  }
  useEffect(() => { void list().catch((e: Error) => setNotice(`Storage unavailable: ${e.message}`)); }, []);
  useEffect(() => {
    if (!p || !dirty || loading.current || blocked) return;
    void snapshot().then((s) => store.current.recover(s)).catch((e: Error) => setNotice(`Recovery write failed: ${e.message}`));
  }, [p, current.id, current.revision, dirty, blocked]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!closing.current && (state.current.saved !== state.current.revision || exportJob.current)) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);

  async function save(as = false): Promise<Snapshot | null> {
    if (blocked || saving.current) return null;
    saving.current = true;
    try {
      const originId = state.current.id, originRevision = state.current.revision;
      const expected = as ? 0 : state.current.saved;
      const s = await snapshot();
      if (as) { s.id = crypto.randomUUID(); s.revision = 1; }
      if (as && isDesktop() && (await nativeAction('save-file', { snapshot: s })).cancelled) return null;
      setNotice(`Saving ${s.project.name} · r${s.revision}…`);
      await store.current.write(s, expected);
      // A late completion can only mark the captured identity/revision saved.
      if (as && state.current.id === originId) Object.assign(state.current, { id: s.id, revision: s.revision + state.current.revision - originRevision, saved: s.revision });
      else if (state.current.id === s.id) state.current.saved = s.revision;
      setNotice(`Saved ${s.project.name} · r${s.revision}`); await list(); refresh((v) => v + 1);
      return s;
    } catch (e) { setNotice(`Save failed: ${(e as Error).message} Your work is still open.`); return null; }
    finally { saving.current = false; }
  }

  async function open(raw: unknown) {
    if (blocked || loading.current || saving.current) return;
    try {
      // Validate all dependencies before changing anything in memory.
      const s = await readSnapshot(raw, latest.current.tracks, async (id) => (await fetchTrack(id)).track);
      if (state.current.saved !== state.current.revision) await store.current.recover(await snapshot());
      loading.current = true;
      await latest.current.openProject(s.project);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const existing = (await store.current.list()).find((r) => r.current?.id === s.id);
      Object.assign(state.current, { id: s.id, trackId: s.project.trackId, name: s.project.name, revision: existing?.current && canonical(existing.current.project) !== canonical(s.project) ? Math.max(s.revision, existing.current.revision + 1) : s.revision,
        saved: existing?.current?.revision ?? 0, content: canonical(latest.current.project) });
      setNotice(`Opened ${s.project.name} · r${s.revision} · stopped`);
    } catch (e) { setNotice(`Open failed: ${(e as Error).message}`); }
    finally { loading.current = false; refresh((v) => v + 1); }
  }

  async function exportWav(seconds?: number) {
    if (blocked || exportJob.current) return;
    const controller = new AbortController(); exportJob.current = controller; setExportProgress(0);
    let finish!: () => void; exportFinished.current = new Promise<void>((resolve) => { finish = resolve; });
    try {
      // Capture the source in the same synchronous turn as the snapshot. A track
      // handover during SHA-256 must not pair this revision with another source.
      const source = structuredClone(latest.current.track!);
      const s = await snapshot();
      const result = await exportProject(s, source, { ...DEFAULT_RENDER, seconds: seconds ?? 64 * 60 / s.project.params['transport.bpm'] }, controller.signal, setExportProgress);
      if (isDesktop()) {
        const out = await nativeAction('export', result.wav.buffer as ArrayBuffer);
        if (out.cancelled) { setNotice('Export dialog cancelled; project unchanged'); return; }
      } else download(result.wav.buffer as ArrayBuffer, `${s.project.name}-r${s.revision}.wav`, 'audio/wav');
      setNotice(`Exported ${s.project.name} · r${s.revision} · ${result.frames} frames`);
    } catch (e) { setNotice(controller.signal.aborted ? 'Export cancelled; project unchanged' : `Export failed: ${(e as Error).message}`); }
    finally { exportJob.current = null; setExportProgress(null); finish(); exportFinished.current = null; }
  }

  async function nativeOpen() {
    if (blocked) return;
    try { const result = await nativeAction('open'); if (!result.cancelled) await open(result.document); }
    catch (e) { setNotice(`Open failed: ${(e as Error).message}`); }
  }
  useEffect(() => {
    const bridge = window.BckgrndDesktop; if (!bridge) return;
    const offClose = bridge.onClose(() => { void (async () => {
      if (exportJob.current) {
        if (!window.confirm('Cancel export and quit? Choose Cancel to keep the app open.')) return;
        exportJob.current.abort();
        await exportFinished.current;
      }
      if (state.current.saved !== state.current.revision && !(await save())) return;
      if (state.current.saved !== state.current.revision) { setNotice('New changes arrived during save. Close again to save them.'); return; }
      closing.current = true; bridge.confirmClose();
    })(); });
    const offMenu = bridge.onMenu((action) => {
      if (action === 'bckgrnd.open') void nativeOpen();
      if (action === 'bckgrnd.save') void save();
      if (action === 'bckgrnd.saveAs') void save(true);
      if (action === 'bckgrnd.export') void exportWav();
      if (action === 'bckgrnd.recovery' || action === 'bckgrnd.reveal') void nativeAction(action === 'bckgrnd.recovery' ? 'recovery-folder' : 'reveal').catch((e: Error) => setNotice(e.message));
    });
    return () => { offClose(); offMenu(); };
  });

  return {
    name: current.name, revision: current.revision, saved: current.saved, dirty, blocked, notice, records, exportProgress,
    status: `${dirty ? 'Unsaved' : 'Saved'} · r${current.revision}`,
    rename(name: string) { if (name.trim() && name !== current.name) { current.name = name.trim().slice(0, 80); current.revision++; refresh((v) => v + 1); } },
    native: isDesktop(), nativeOpen,
    async reveal() { try { await nativeAction('reveal'); } catch (e) { setNotice((e as Error).message); } },
    async recoveryFolder() { try { await nativeAction('recovery-folder'); } catch (e) { setNotice((e as Error).message); } },
    save, open, list, exportWav,
    cancelExport() { exportJob.current?.abort(); },
    async projectFile() { try { const s = await snapshot(); download(JSON.stringify(s, null, 2), `${s.project.name}-r${s.revision}.bckgrnd.json`, 'application/json'); } catch (e) { setNotice((e as Error).message); } },
    async remove(id: string) {
      try { await store.current.remove(id); await list(); }
      catch (e) { setNotice(`Delete failed: ${(e as Error).message}`); }
    },
    async fresh() {
      if (blocked || !latest.current.track) return;
      const { projectFromTrack } = await import('./contract');
      await open(projectFromTrack(latest.current.track));
    },
  };
}
