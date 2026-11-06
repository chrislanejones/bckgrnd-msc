import { Engine, initSync } from '@wasm';
import { renderProject } from './lib/project-renderer';
self.onmessage = async ({ data }) => {
  try {
    initSync({ module: data.wasm });
    const result = await renderProject(Engine, data.snapshot, data.source, data.settings, undefined,
      (progress) => self.postMessage({ progress }));
    self.postMessage({ result }, { transfer: [result.wav.buffer] });
  } catch (e) { self.postMessage({ error: (e as Error).message }); }
};
