import { useRef, useState } from 'react';
import type { useProjects } from '../lib/projects';

export function ProjectMenu({ projects: p }: { projects: ReturnType<typeof useProjects> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  return <>
    <button className="save-status" onClick={() => { void p.list(); dialog.current?.showModal(); }} aria-label={`Projects · ${p.status}`}>
      {p.status}
    </button>
    <dialog ref={dialog} className="project-dialog" aria-label="Projects">
      <div className="flex items-center justify-between gap-4"><h2>Projects</h2><button onClick={() => dialog.current?.close()} aria-label="Close projects">Close</button></div>
      <label>Project name<input aria-label="Project name" value={p.name} onChange={(e) => p.rename(e.target.value)} /></label>
      <p role="status" data-testid="project-status">{p.notice || p.status}</p>
      {p.blocked && <p>{p.blocked}</p>}
      <div className="project-actions">
        <button disabled={!!p.blocked} onClick={() => void p.save()}>Save project</button>
        <button disabled={!!p.blocked} onClick={() => void p.save(true)}>Save As</button>
        <button disabled={!!p.blocked} onClick={() => void p.fresh()}>New project</button>
        <button disabled={!!p.blocked} onClick={() => p.native ? void p.nativeOpen() : file.current?.click()}>Import project file</button>
        <button disabled={!!p.blocked} onClick={() => void p.projectFile()}>Download project file</button>
        <button disabled={!!p.blocked || p.exportProgress !== null} onClick={() => void p.exportWav()}>Export WAV</button>
        {p.exportProgress !== null && <button onClick={p.cancelExport}>Cancel export ({p.exportProgress}%)</button>}
        {p.native && <><button onClick={() => void p.reveal()}>Reveal Export</button><button onClick={() => void p.recoveryFolder()}>Open Recovery Folder</button></>}
      </div>
      <input hidden type="file" ref={file} accept=".json" aria-label="Import project file" onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        try { await p.open(JSON.parse(await f.text())); setError(''); } catch (err) { setError((err as Error).message); }
        e.target.value = '';
      }} />
      {error && <p role="alert">{error}</p>}
      <p className="text-xs text-muted">Saved on this device. Download a project file to move it to the desktop or MCP. A/B captures stay in this session; Keep current or capture a scene to preserve a comparison.</p>
      <p className="text-xs text-muted">Build <code title={__BUILD_ID__}>{__BUILD_ID__.slice(0, 12)}</code> · project v3 · snapshot v1</p>
      <ul>{p.records.map((r) => {
        const s = r.current ?? r.recovery!;
        return <li key={s.id}>
          <span>{s.project.name} · r{s.revision}</span>
          {r.current && <button disabled={!!p.blocked} onClick={() => void p.open(r.current)}>Open</button>}
          {r.recovery && <button disabled={!!p.blocked} onClick={() => void p.open(r.recovery)}>Recover r{r.recovery.revision}</button>}
          {r.previous && <button disabled={!!p.blocked} onClick={() => void p.open(r.previous)}>Previous r{r.previous.revision}</button>}
          <button onClick={() => { if (window.confirm(`Delete saved copies of ${s.project.name}?`)) void p.remove(s.id); }}>Delete</button>
        </li>;
      })}</ul>
    </dialog>
  </>;
}
