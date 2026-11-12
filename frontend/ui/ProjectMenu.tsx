import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { useProjects } from '../lib/projects';
import { StatusIndicator } from './controls';

export function ProjectMenu({ projects: p }: { projects: ReturnType<typeof useProjects> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  // What is being typed, spaces included. The project keeps the trimmed name.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // The desktop File menu opens projects with this dialog shut. The warning still has to be seen.
  useEffect(() => { if (p.sourceWarning && !dialog.current?.open) dialog.current?.showModal(); }, [p.sourceWarning]);
  return <>
    <button type="button" className="save-status" onClick={() => { void p.list(); dialog.current?.showModal(); }} aria-label={`Projects · ${p.status}`} title={p.status}>
      <FolderOpen className="save-status-icon size-4" aria-hidden />
      <StatusIndicator state={p.indicator.state} label={p.indicator.label} />
    </button>
    <dialog ref={dialog} className="project-dialog" aria-label="Projects">
      <div className="project-dialog-head"><h2>Projects</h2><button onClick={() => dialog.current?.close()} aria-label="Close projects">Close</button></div>
      <label>Project name<input aria-label="Project name" value={nameDraft ?? p.name} onChange={(e) => { setNameDraft(e.target.value); p.rename(e.target.value); }} onBlur={() => setNameDraft(null)} /></label>
      <p role="status" data-testid="project-status" className="project-status">{p.notice || p.status}</p>
      {p.blocked && <p>{p.blocked}</p>}
      {p.sourceWarning && <p role="alert" data-testid="source-warning">{p.sourceWarning}</p>}
      {/* Three jobs, three rows: keep this project, move it as a file, render audio. */}
      <div className="project-actions">
        <div className="project-group" role="group" aria-label="Save">
          <span className="control-label" aria-hidden="true">Save</span>
          <div className="project-group-row">
            <button className="project-primary" disabled={!!p.blocked} onClick={() => void p.save()}>Save project</button>
            <button disabled={!!p.blocked} onClick={() => void p.save(true)}>Save As</button>
            <button disabled={!!p.blocked} onClick={() => void p.fresh()}>New project</button>
          </div>
        </div>
        <div className="project-group" role="group" aria-label="Project file">
          <span className="control-label" aria-hidden="true">Project file</span>
          <div className="project-group-row">
            <button disabled={!!p.blocked} onClick={() => p.native ? void p.nativeOpen() : file.current?.click()}>Import project file</button>
            <button disabled={!!p.blocked} onClick={() => void p.projectFile()}>Download project file</button>
            {p.native && <button onClick={() => void p.recoveryFolder()}>Open Recovery Folder</button>}
          </div>
        </div>
        <div className="project-group" role="group" aria-label="Export">
          <span className="control-label" aria-hidden="true">Export</span>
          <div className="project-group-row">
            <button disabled={!!p.blocked || p.exportProgress !== null} onClick={() => void p.exportWav()}>Export WAV</button>
            {p.exportProgress !== null && <button onClick={p.cancelExport}>Cancel export ({p.exportProgress}%)</button>}
            {p.native && <button onClick={() => void p.reveal()}>Reveal Export</button>}
          </div>
        </div>
      </div>
      <input hidden type="file" ref={file} accept=".json" aria-label="Import project file" onChange={async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        try { await p.open(JSON.parse(await f.text())); setError(''); } catch (err) { setError((err as Error).message); }
        e.target.value = '';
      }} />
      {error && <p role="alert">{error}</p>}
      <p className="text-xs text-muted">Saved on this device. Download a project file to move it to the desktop or MCP. A/B captures stay in this session; Keep current or capture a scene to preserve a comparison.</p>
      <p className="text-xs text-muted">Build <code title={__BUILD_ID__}>{__BUILD_ID__.slice(0, 12)}</code> · project v3 · snapshot v1</p>
      {p.records.length === 0 && <p className="empty-note" data-testid="projects-empty">No saved projects yet. Save project keeps this one on this device.</p>}
      <ul>{p.records.map((r) => {
        const s = r.current ?? r.recovery!;
        return <li key={s.id}>
          <span>{s.project.name} · r{s.revision}</span>
          {r.current && <button disabled={!!p.blocked} onClick={() => {
            // Editing the older copy eventually replaces the newer unsaved one.
            const newer = r.recovery && r.recovery.revision > r.current!.revision;
            if (!newer || window.confirm(`${s.project.name} has unsaved work at r${r.recovery!.revision}. Open the older saved r${r.current!.revision} anyway? Editing it will replace that work. Choose Cancel, then Recover, to keep it.`)) void p.open(r.current);
          }}>Open</button>}
          {r.recovery && <button disabled={!!p.blocked} onClick={() => void p.open(r.recovery)}>Recover r{r.recovery.revision}</button>}
          {r.previous && <button disabled={!!p.blocked} onClick={() => void p.open(r.previous)}>Previous r{r.previous.revision}</button>}
          <button onClick={() => { if (window.confirm(`Delete saved copies of ${s.project.name}?`)) void p.remove(s.id); }}>Delete</button>
        </li>;
      })}</ul>
    </dialog>
  </>;
}
