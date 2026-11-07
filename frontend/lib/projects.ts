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

const RECOVERY_DELAY_MS = 400;

export function useProjects(inst: Instrument) {
  const store = useRef<ProjectStore>(isDesktop() ? new NativeProjectStore() : new BrowserProjectStore());
  // `pristine` is a track nobody has touched: nothing to save, recover or warn about.
  const state = useRef({ id: crypto.randomUUID() as string, trackId: '', source: null as unknown, name: '', revision: 1, saved: 0, pristine: true, content: '' });
  const isDirty = () => !state.current.pristine && state.current.saved !== state.current.revision;
  const loading = useRef(false), saving = useRef(false);
  const [noticeText, setNoticeText] = useState('');
  // A notice describes one revision. "Saved" must not outlive the next edit.
  const noticeAt = useRef(0);
  const setNotice = (text: string) => { noticeAt.current = state.current.revision; setNoticeText(text); };
  const saveError = useRef<{ revision: number; reason: string } | null>(null);
  // The project opened against newer library data than it was saved with.
  const [sourceWarning, setSourceWarning] = useState<{ id: string; text: string } | null>(null);
  // Desktop: the app's copy saved, but the file the project was saved as didn't update.
  const fileBehind = useRef(false);
  const seenProject = useRef<unknown>(null);
  const [records, setRecords] = useState<ProjectRecord[]>([]);
  const [, refresh] = useState(0);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const exportJob = useRef<AbortController | null>(null);
  const closing = useRef(false);
  const exportFinished = useRef<Promise<void> | null>(null);
  const p = inst.project;
  const current = state.current;
  // Identity changes on a source handover; no autosave ever consults liveDeck.
  // Any source load is a new composition, even the track already loaded: it resets the
  // edits, so it must not replace the recovery copy of the work it just discarded.
  if (p && !loading.current && (p !== seenProject.current || current.source !== inst.track)) {
    seenProject.current = p;
    const content = canonical(p);
    if (current.trackId !== p.trackId || current.source !== inst.track) {
      Object.assign(current, { id: crypto.randomUUID(), trackId: p.trackId, source: inst.track, name: p.name, revision: 1, saved: 0, pristine: true, content });
    } else if (current.content !== content) { current.content = content; current.revision++; current.pristine = false; }
  }
  const dirty = isDirty();
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
  const flushRecovery = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!p || !dirty || loading.current || blocked) return;
    // A fader drag is a revision per tick; hash and write once it settles.
    flushRecovery.current = () => {
      flushRecovery.current = null;
      void snapshot().then((s) => store.current.recover(s)).catch((e: Error) => setNotice(`Recovery write failed: ${e.message}`));
    };
    const timer = window.setTimeout(() => flushRecovery.current?.(), RECOVERY_DELAY_MS);
    return () => { window.clearTimeout(timer); flushRecovery.current = null; };
  }, [p, current.id, current.revision, dirty, blocked]);
  // Leaving must not wait out the delay. Hidden comes first and leaves time to finish
  // the write; pagehide is the last chance, and the browser may still cut it short.
  useEffect(() => {
    const flush = () => flushRecovery.current?.();
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (!closing.current && (isDirty() || exportJob.current)) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);

  /** The store is the app's copy. A project saved as a file keeps that file current too. */
  async function updateLinkedFile(s: Snapshot): Promise<string> {
    if (!isDesktop()) return '';
    try {
      const { path } = await nativeAction('update-file', { snapshot: s });
      fileBehind.current = false;
      return path ? ` · ${path}` : '';
    } catch (e) {
      fileBehind.current = true;
      return ` in the app. The project file was not updated: ${(e as Error).message}`;
    }
  }

  async function save(as = false): Promise<Snapshot | null> {
    if (blocked) { setNotice(blocked); saveError.current = { revision: state.current.revision, reason: blocked }; return null; }
    if (saving.current || loading.current) return null;
    // Nothing new: writing again would turn the only rollback copy into this one.
    if (!as && state.current.saved === state.current.revision) {
      const s = await snapshot();
      const fileNote = fileBehind.current ? await updateLinkedFile(s) : '';
      setNotice(`Saved ${state.current.name} · r${state.current.revision}${fileNote}`);
      return s;
    }
    saving.current = true;
    try {
      const originId = state.current.id, originRevision = state.current.revision;
      const expected = as ? 0 : state.current.saved;
      const s = await snapshot();
      if (as) { s.id = crypto.randomUUID(); s.revision = 1; }
      let chosenFile = '';
      if (as && isDesktop()) {
        const out = await nativeAction('save-file', { snapshot: s });
        if (out.cancelled) return null;
        chosenFile = out.path ? ` · ${out.path}` : '';
      }
      setNotice(`Saving ${s.project.name} · r${s.revision}…`);
      await store.current.write(s, expected);
      // A late completion can only mark the captured identity/revision saved.
      if (as && state.current.id === originId) Object.assign(state.current, { id: s.id, revision: s.revision + state.current.revision - originRevision, saved: s.revision, pristine: false });
      else if (state.current.id === s.id) Object.assign(state.current, { saved: s.revision, pristine: false });
      saveError.current = null;
      // Saved with the library data it was checked against, so there's nothing left to warn about.
      setSourceWarning(null);
      const fileNote = as ? chosenFile : await updateLinkedFile(s);
      setNotice(`Saved ${s.project.name} · r${s.revision}${fileNote}`); await list(); refresh((v) => v + 1);
      return s;
    } catch (e) {
      saveError.current = { revision: state.current.revision, reason: (e as Error).message };
      setNotice(`Save failed: ${(e as Error).message} Your work is still open.`);
      refresh((v) => v + 1);
      return null;
    }
    finally { saving.current = false; }
  }

  async function open(raw: unknown, pristine = false) {
    if (blocked || loading.current || saving.current) return;
    try {
      // Validate all dependencies before changing anything in memory.
      let sourceChanged = false;
      const s = await readSnapshot(raw, latest.current.tracks, async (id) => (await fetchTrack(id)).track, () => { sourceChanged = true; });
      // Read storage before touching anything: a failure here must leave the open
      // project and its identity paired, or the next Save overwrites the wrong one.
      const stored = (await store.current.list()).find((r) => r.current?.id === s.id)?.current;
      if (isDirty()) await store.current.recover(await snapshot());
      loading.current = true;
      await latest.current.openProject(s.project);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      // Same music as the saved copy is that saved copy, whichever revision was opened.
      // Anything else continues above it, so it can always be saved.
      // A changed source is new work too: Save records it against today's library.
      const revision = sourceChanged ? Math.max(s.revision, stored?.revision ?? 0) + 1
        : !stored ? s.revision : canonical(stored.project) === canonical(s.project) ? stored.revision : Math.max(s.revision, stored.revision + 1);
      seenProject.current = latest.current.project;
      Object.assign(state.current, { id: s.id, trackId: s.project.trackId, source: latest.current.track, name: s.project.name, revision, saved: stored?.revision ?? 0, pristine, content: canonical(latest.current.project) });
      setNotice(`Opened ${s.project.name} · r${s.revision} · stopped`);
      fileBehind.current = false;
      setSourceWarning(sourceChanged ? { id: s.id, text: `The ${s.project.trackId} track has changed in the library since ${s.project.name} was saved, so it may sound different. Your mix and edits are all here. Have a listen, then Save to keep it with the new track.` } : null);
    } catch (e) { setNotice(`Open failed: ${(e as Error).message}`); }
    finally { loading.current = false; refresh((v) => v + 1); }
  }

  async function exportWav(seconds?: number) {
    if (blocked || exportJob.current || loading.current) return;
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
      if (isDirty() && !(await save())) {
        // Never trap someone in the app, or quit silently: say why, and let them choose.
        const reason = saveError.current?.reason ?? 'the save did not finish';
        await snapshot().then((s) => store.current.recover(s)).catch(() => undefined);
        if (!window.confirm(`Your latest changes aren't saved: ${reason}\n\nQuit anyway? A recovery copy stays in Projects. Choose Cancel to keep the app open.`)) return;
      } else if (isDirty()) { setNotice('New changes arrived during save. Close again to save them.'); return; }
      if (fileBehind.current && !window.confirm("Your work is saved in the app, but the project file couldn't be updated.\n\nQuit anyway? Choose Cancel to keep the app open and use Save As.")) return;
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

  const saveFailed = dirty && saveError.current?.revision === current.revision;

  return {
    name: current.name, revision: current.revision, saved: current.saved, dirty, blocked, records, exportProgress,
    sourceWarning: sourceWarning?.id === current.id ? sourceWarning.text : '',
    notice: noticeAt.current === current.revision ? noticeText : '',
    status: current.pristine ? 'Track as written' : `${dirty ? 'Unsaved' : 'Saved'} · r${current.revision}`,
    /** The short word and state the transport shows; `status` carries the revision. */
    indicator: (saveFailed ? { state: 'error', label: 'Save failed' }
      : current.pristine ? { state: 'idle', label: 'As written' }
      : dirty ? { state: 'warn', label: 'Unsaved' }
      : { state: 'ok', label: 'Saved' }) as { state: 'error' | 'idle' | 'warn' | 'ok'; label: string },
    rename(name: string) {
      const next = name.trim().slice(0, 80);
      if (next && next !== current.name) { current.name = next; current.revision++; current.pristine = false; refresh((v) => v + 1); }
    },
    native: isDesktop(), nativeOpen,
    async reveal() { try { await nativeAction('reveal'); } catch (e) { setNotice((e as Error).message); } },
    async recoveryFolder() { try { await nativeAction('recovery-folder'); } catch (e) { setNotice((e as Error).message); } },
    save, open, list, exportWav,
    cancelExport() { exportJob.current?.abort(); },
    async projectFile() { try { const s = await snapshot(); download(JSON.stringify(s, null, 2), `${s.project.name}-r${s.revision}.bckgrnd.json`, 'application/json'); } catch (e) { setNotice((e as Error).message); } },
    async remove(id: string) {
      try {
        await store.current.remove(id);
        // The open project lost its saved copy, so it has to say so, and its next Save
        // must not expect a revision that is gone.
        if (id === state.current.id) { Object.assign(state.current, { saved: 0, pristine: false }); refresh((v) => v + 1); }
        await list();
      }
      catch (e) { setNotice(`Delete failed: ${(e as Error).message}`); }
    },
    async fresh() {
      if (blocked || !latest.current.track) return;
      const { projectFromTrack } = await import('./contract');
      await open(projectFromTrack(latest.current.track), true);
    },
  };
}
