/** Forward worklet playback over Break and Drop. No seeks: they suppress seams. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:8080');
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/build/engine-worklet.js');
    const node = new AudioWorkletNode(ctx, 'bckgrnd-msc-engine', { outputChannelCount: [2] });
    const sink = ctx.createGain(); sink.gain.value = 0; node.connect(sink).connect(ctx.destination);
    const { track } = await (await fetch('/library/warehouse.json')).json();
    // Keep audible channel targets, so the all-cut gate does not suppress the
    // transitions. Empty musical lanes leave only the seam sounds to measure.
    for (const key of ['kick','clap','hat','hatOpen','shaker','rim','congaHi','congaLo']) if (Array.isArray(track[key])) track[key].fill(0);
    for (const key of ['bass','stab','lead','pad','arp']) track[key].fill(null);
    let previous = -1; const steps = []; const peaks = { before: 0, break: 0, riser: 0, drop: 0 }; const errors = [];
    let done; const completed = new Promise((resolve) => { done = resolve; });
    const timer = setTimeout(() => done(false), 30000);
    node.port.onmessage = ({ data }) => {
      if (data.type === 'error') { errors.push(data.message); done(false); }
      if (data.type !== 'telemetry') return;
      const step = data.frame[8], peak = Math.max(data.frame[12], data.frame[13]);
      if (step !== previous) { steps.push(step); previous = step; }
      const span = step < 128 ? 'before' : step < 144 ? 'break' : step >= 192 ? 'drop' : step >= 160 ? 'riser' : null;
      if (span) peaks[span] = Math.max(peaks[span], peak);
      if (step >= 208) done(true);
    };
    try {
      const wasm = await (await fetch('/wasm/bckgrnd_msc_engine_bg.wasm')).arrayBuffer();
      node.port.postMessage({ type: 'init', wasm, sampleRate: ctx.sampleRate }, [wasm]);
      node.port.postMessage({ type: 'track', deck: 'a', json: JSON.stringify(track) });
      node.port.postMessage({ type: 'bpm', value: 240 });
      node.port.postMessage({ type: 'transport', deck: 'a', action: 'play' });
      await ctx.resume();
      return { complete: await completed, steps, peaks, errors, sampleRate: ctx.sampleRate };
    } finally { clearTimeout(timer); node.disconnect(); await ctx.close(); }
  });
  assert(result.complete, JSON.stringify(result)); assert.deepEqual(result.errors, []);
  assert(result.steps.some((s) => s >= 128 && s < 144)); assert(result.steps.some((s) => s >= 192));
  assert(result.peaks.before < 0.0001, 'Fixture contains musical signal before the seams');
  for (const span of ['break','riser','drop']) assert(result.peaks[span] > 0.001, `${span} produced no transition signal`);
  console.log('PASS actual forward worklet playback:', JSON.stringify({ ...result, steps: result.steps.length }));
} finally { await browser.close(); }
