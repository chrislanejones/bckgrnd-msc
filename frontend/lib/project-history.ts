import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { editHistory } from './history';
import { canonical } from './snapshot';
import type { Project } from './contract';

/** One chronological history for accepted composition, including scenes+lanes.
 * Continuous controls already report gesture boundaries through editHistory. */
export function useProjectHistory(project: Project | null, epoch: number, suspended: boolean, label: string | undefined, apply: (p: Project) => void) {
  type Entry = { project: Project; label: string };
  const history = useRef({ past: [] as Entry[], future: [] as Entry[], last: null as Project | null, epoch, applying: false });
  const [tick, refresh] = useState(0);
  useEffect(() => editHistory.subscribe(() => refresh((x) => x + 1)), []);
  useLayoutEffect(() => {
    if (!project) return;
    const h = history.current;
    if (h.epoch !== epoch || h.last?.trackId !== project.trackId) {
      Object.assign(h, { past: [], future: [], last: structuredClone(project), epoch, applying: false });
      refresh((x) => x + 1); return;
    }
    if (h.applying) { if (canonical(h.last) === canonical(project)) h.applying = false; return; }
    if (suspended || editHistory.active || canonical(h.last) === canonical(project)) return;
    const patternChanged = canonical(h.last?.patterns) !== canonical(project.patterns);
    h.past = [...h.past.slice(-199), { project: h.last!, label: patternChanged ? label ?? 'patterns' : 'project change' }]; h.future = []; h.last = structuredClone(project);
    refresh((x) => x + 1);
  }, [project, epoch, suspended, tick, label]);
  function move(back: boolean) {
    if (suspended || editHistory.active || !project) return;
    const h = history.current;
    const stack = back ? h.past : h.future;
    const next = stack.pop(); if (!next) return;
    (back ? h.future : h.past).push({ project: structuredClone(project), label: next.label });
    h.applying = true; h.last = structuredClone(next.project); apply(next.project); refresh((x) => x + 1);
  }
  return { canUndo: history.current.past.length > 0 && !suspended, canRedo: history.current.future.length > 0 && !suspended,
    undo: () => move(true), redo: () => move(false), undoLabel: history.current.past.at(-1)?.label, redoLabel: history.current.future.at(-1)?.label };
}
