/** Compare actual bundled export workers, including the installed app, with MCP. */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
if (!process.env.NATIVE_CDP) throw new Error('NATIVE_CDP must point to an installed test build.');
const mcp = resolve(process.env.BCKGRND_MCP_DIR ?? '../bckgrnd-msc-mcp');
const { loadProject, renderSavedProject } = await import(pathToFileURL(join(mcp, 'dist/projects.js')));
const { canonical, resolvedArrangement } = await import(pathToFileURL(resolve('public/shared/runtime.js')));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const browser = await chromium.launch();
const desktop = await chromium.connectOverCDP(process.env.NATIVE_CDP);
const folder = mkdtempSync(join(tmpdir(), 'bckgrnd parity café '));
const settings = { startSeconds: 0.25, seconds: 2, fadeInSeconds: 0.01, fadeOutSeconds: 0.02, tailSeconds: 0.25, sampleRate: 48000 };
const results = [];
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:8080');
  const native = desktop.contexts()[0].pages()[0];
  for (const name of ['edited', 'silent']) {
    const path = resolve(`tests/fixtures/release/${name}.bckgrnd.json`);
    const project = await loadProject(path);
    const eventHash = sha(canonical(resolvedArrangement(project.source, project.snapshot.project.patterns)));
    assert.equal(eventHash, project.identity.resolved_events_sha256);
    const rendered = [];
    for (const [runtime, target] of [['browser', page], ['native', native]]) {
      const result = await target.evaluate(async ({ snapshot, source, settings }) => {
        const app = document.querySelector('script[type=module][src]');
        const code = await (await fetch(app.src)).text();
        const workerUrl = code.match(/\/build\/assets\/export-worker-[\w-]+\.js/)?.[0];
        if (!workerUrl) throw new Error('Bundled export worker not found');
        const manifest = await (await fetch('/build-manifest.json')).json();
        const wasm = await (await fetch('/wasm/bckgrnd_msc_engine_bg.wasm')).arrayBuffer();
        const result = await new Promise((resolve, reject) => {
          const w = new Worker(workerUrl, { type: 'module' });
          const timer = setTimeout(() => { w.terminate(); reject(new Error('Export timed out')); }, 20000);
          w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message)); };
          w.onmessage = ({ data }) => {
            if (data.result || data.error) { clearTimeout(timer); w.terminate(); data.error ? reject(new Error(data.error)) : resolve(data.result); }
          };
          w.postMessage({ snapshot, source, settings, wasm }, [wasm]);
        });
        return { bytes: Array.from(result.wav), frames: result.frames, peak: result.peak, revision: result.revision, build: manifest.buildId, engine: manifest.engine['bckgrnd_msc_engine_bg.wasm'] };
      }, { snapshot: project.snapshot, source: project.source, settings });
      const bytes = Buffer.from(result.bytes); delete result.bytes;
      writeFileSync(join(folder, `${name}-${runtime}.wav`), bytes);
      rendered.push({ runtime, sha256: sha(bytes), ...result });
    }
    const output = join(folder, `${name}-mcp.wav`);
    const result = await renderSavedProject(project, settings, output);
    rendered.push({ runtime: 'mcp', sha256: sha(readFileSync(output)), frames: result.frames, peak: result.peak, revision: result.project_revision, build: result.build_id, engine: project.bundle.files['engine/bckgrnd_msc_engine_bg.wasm'] });
    for (const r of rendered) {
      assert.equal(r.frames, 108000); assert.equal(r.revision, 7);
      assert.equal(r.engine, rendered[0].engine); assert.equal(r.sha256, rendered[0].sha256);
      if (name === 'silent') assert.equal(r.peak, 0);
      else assert(r.peak > 0.01);
    }
    results.push({ fixture: name, resolved_events_sha256: eventHash, settings, rendered });
  }
  writeFileSync(join(folder, 'evidence.json'), JSON.stringify(results, null, 2));
  console.log(`PASS browser/installed native/MCP: identical resolved events, immutable mix, exact frame counts and byte-identical PCM WAV with isolated WASM noise and controlled encoding. ${folder}`);
} finally { await browser.close(); await desktop.close(); }
