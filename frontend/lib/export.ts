import type { Snapshot } from './snapshot';
import type { TrackArrangement } from './types';
import type { RenderSettings, renderProject } from './project-renderer';
import { verifyEngine } from './build-identity';

export async function exportProject(snapshot: Snapshot, source: TrackArrangement, settings: RenderSettings, signal: AbortSignal, progress: (n: number) => void) {
  const response = await fetch(`/wasm/bckgrnd_msc_engine_bg.wasm?v=${__BUILD_ID__}`, { signal });
  if (!response.ok) throw new Error('WASM asset missing. Reinstall the matching app build.');
  const wasm = await response.arrayBuffer(); signal.throwIfAborted();
  await verifyEngine(wasm); signal.throwIfAborted();
  return new Promise<Awaited<ReturnType<typeof renderProject>>>((resolve, reject) => {
    // A fresh worker owns a fresh WASM noise stream, independent of live playback.
    const worker = new Worker(new URL('../export-worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { worker.terminate(); signal.removeEventListener('abort', abort); };
    const abort = () => { finish(); reject(new DOMException('Export cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = (e) => { finish(); reject(new Error(e.message)); };
    worker.onmessage = ({ data }) => {
      if (data.error) { finish(); reject(new Error(data.error)); }
      else if (data.result) { finish(); resolve(data.result); }
      else progress(data.progress);
    };
    worker.postMessage({ wasm, snapshot, source, settings }, [wasm]);
  });
}
