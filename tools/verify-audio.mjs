/**
 * End-to-end audio verification.
 *
 * Everything else in this project tests the engine in isolation: Rust unit tests for
 * the DSP, PHP tests for the arrangements, a Playwright check that the UI renders.
 * None of those touch the seam that actually breaks in practice — the wasm-bindgen
 * glue running inside a real `AudioWorkletProcessor`.
 *
 * Three separate bugs lived there, and all three presented as plain silence rather
 * than as errors, because a throw inside `process()` is swallowed by the browser and
 * the worklet's `console` is not reachable from the page:
 *
 *  - `TextEncoder`/`TextDecoder` do not exist in `AudioWorkletGlobalScope`, but the
 *    wasm-bindgen glue constructs them at module scope, so the module threw before
 *    `registerProcessor` ran.
 *  - Methods annotated only on the Rust side were never exported to JS, so
 *    `engine.play` did not exist.
 *  - A call to a method that had been deleted threw once the engine became ready.
 *
 * So this drives a real `AudioContext`, taps the worklet's output with an
 * `AnalyserNode`, and asserts on the samples that come out.
 *
 * Usage: node tools/verify-audio.mjs [baseUrl]
 */

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8080';

/**
 * Find an installed Chromium.
 *
 * Playwright's own download is unavailable in some sandboxes, and its default
 * resolution points at a build that was never fetched. Search the cache for a
 * browser that is actually on disk.
 */
function findChromium() {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  let entries = [];
  try {
    entries = readdirSync(cache);
  } catch {
    return undefined; // fall back to Playwright's own resolution
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith('chromium-')) continue;
    candidates.push(
      join(cache, entry, 'chrome-linux64', 'chrome'),
      join(cache, entry, 'chrome-linux', 'chrome'),
      join(cache, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(cache, entry, 'chrome-win', 'chrome.exe'),
    );
  }
  return candidates.find((path) => existsSync(path));
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

  const result = await page.evaluate(async (base) => {
    /**
     * Boot one engine into a fresh context, send commands, and measure the output.
     *
     * The tap is an `AnalyserNode` on the worklet's output, polled across the whole
     * window rather than sampled once — a single 2048-frame snapshot can easily
     * land in a gap between hits and read as silence.
     */
    async function measure({
      trackId = 'warehouse',
      ms = 1200,
      commands = [],
      // Messages posted at `at` ms after play, and named spans whose peak is wanted.
      timeline = [],
      windows = [],
    } = {}) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('/build/engine-worklet.js');

      const node = new AudioWorkletNode(ctx, 'bckgrnd-msc-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });

      const errors = [];
      // Accumulate across the whole window rather than keeping the last snapshot:
      // a single sample cannot show that the playhead *advances* or that meters
      // *move*, and it lands wherever the window happened to end.
      const stepLog = [];
      let t0 = performance.now();
      const seen = { steps: new Set(), maxLevels: new Array(8).fill(0), sawPlaying: false, frames: 0 };
      node.port.onmessage = (e) => {
        if (e.data.type === 'error') {
          errors.push(`${e.data.command}: ${e.data.message}`);
          return;
        }
        if (e.data.type !== 'telemetry') return;
        const f = e.data.frame;
        seen.frames += 1;
        seen.steps.add(f[8]);
        if (timeline.length) stepLog.push([performance.now() - t0, f[8]]);
        seen.sawPlaying ||= f[9] === 1;
        for (let i = 0; i < 8; i += 1) seen.maxLevels[i] = Math.max(seen.maxLevels[i], f[i]);
      };

      // Two analysers so left and right can be compared, proving real stereo.
      const splitter = ctx.createChannelSplitter(2);
      const analyserL = ctx.createAnalyser();
      const analyserR = ctx.createAnalyser();
      analyserL.fftSize = 2048;
      analyserR.fftSize = 2048;
      node.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);
      // A muted sink: headless Chrome has no output device, and some builds will
      // not run a graph whose destination is silent.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);

      const wasm = await (await fetch(`${base}/wasm/bckgrnd_msc_engine_bg.wasm`)).arrayBuffer();
      const { track } = await (await fetch(`${base}/api/tracks/${trackId}`)).json();

      node.port.postMessage({ type: 'init', wasm, sampleRate: ctx.sampleRate }, [wasm]);
      node.port.postMessage({ type: 'track', deck: 'a', json: JSON.stringify(track) });
      for (const command of commands) {
        node.port.postMessage(command);
      }
      node.port.postMessage({ type: 'transport', deck: 'a', action: 'play' });
      t0 = performance.now();
      for (const { at, message } of timeline) {
        setTimeout(() => node.port.postMessage(message), at);
      }
      const windowPeak = Object.fromEntries(windows.map((w) => [w.name, 0]));

      const bufL = new Float32Array(analyserL.fftSize);
      const bufR = new Float32Array(analyserR.fftSize);
      let peak = 0;
      let peakL = 0;
      let peakR = 0;
      let nonFinite = 0;

      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        analyserL.getFloatTimeDomainData(bufL);
        analyserR.getFloatTimeDomainData(bufR);
        for (let i = 0; i < bufL.length; i += 1) {
          const l = bufL[i];
          const r = bufR[i];
          if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite += 1;
          const m = Math.max(Math.abs(l), Math.abs(r));
          if (m > peak) peak = m;
          if (Math.abs(l) > peakL) peakL = Math.abs(l);
          if (Math.abs(r) > peakR) peakR = Math.abs(r);
        }
        const now = performance.now() - t0;
        for (const w of windows) {
          if (now < w.from || now > w.to) continue;
          for (let i = 0; i < bufL.length; i += 1) {
            windowPeak[w.name] = Math.max(windowPeak[w.name], Math.abs(bufL[i]), Math.abs(bufR[i]));
          }
        }
        await new Promise((r) => setTimeout(r, 16));
      }

      const out = {
        peak,
        peakL,
        peakR,
        nonFinite,
        errors,
        windowPeak,
        stepLog,
        sampleRate: ctx.sampleRate,
        telemetry: {
          frames: seen.frames,
          distinctSteps: seen.steps.size,
          minStep: Math.min(...seen.steps),
          maxStep: Math.max(...seen.steps),
          sawPlaying: seen.sawPlaying,
          maxLevels: seen.maxLevels.map((v) => +v.toFixed(4)),
        },
      };

      node.disconnect();
      await ctx.close();
      return out;
    }

    const out = {};

    // 1. The happy path.
    out.full = await measure({});

    // 2. Every style in the library must sound.
    out.tracks = {};
    for (const id of ['acid', 'tunnel', 'kettle', 'rain', 'southside', 'ravetape', 'lowtide']) {
      out.tracks[id] = await measure({ trackId: id, ms: 900 });
    }

    // 3. Cutting every stem must fall silent — proves the messages reach the engine.
    out.allMuted = await measure({
      ms: 900,
      commands: Array.from({ length: 8 }, (_, index) => ({
        type: 'mute',
        index,
        value: true,
      })),
    });

    // 3b. A lo-fi track with every stem cut keeps only the record's surface: the
    //     crackle and tape hiss are the medium rather than a stem, so no cut silences
    //     them. Deliberately not the check above, which stays on a club track and
    //     stays at true silence.
    out.lofiMuted = await measure({
      trackId: 'rain',
      ms: 1500,
      commands: Array.from({ length: 8 }, (_, index) => ({
        type: 'mute',
        index,
        value: true,
      })),
    });

    // 4. Soloing the bass leaves something, but far less than the full mix.
    //
    //    Measured over two bars rather than a fraction of one: every track's form
    //    withholds the bassline through the intro, and at 126 BPM bar 2 of a
    //    16-bar song does not begin until ~3.8 s. A short window would correctly
    //    report silence and tell us nothing about soloing.
    out.fullLong = await measure({ ms: 5000 });
    out.bassSolo = await measure({
      ms: 5000,
      commands: [{ type: 'solo', index: 3, value: true }],
    });

    // 5. Tempo and swing reach the engine.
    out.tempo = await measure({
      ms: 900,
      commands: [
        { type: 'bpm', value: 150 },
        { type: 'swing', value: 0.5 },
        { type: 'filter', value: 0.4 },
        { type: 'bands', low: 0.5, mid: 1, high: 1 },
        { type: 'echo', on: true },
        { type: 'stereo', mode: 2 },
      ],
    });

    // 6. Scratch: grab at 1.5 s, drag back at normal speed, let go at step 64.
    out.scratch = await measure({
      ms: 2800,
      timeline: [
        { at: 1500, message: { type: 'scratchStart' } },
        { at: 1550, message: { type: 'scratch', rate: -1 } },
        { at: 2100, message: { type: 'scratchEnd', step: 64 } },
      ],
      windows: [{ name: 'drag', from: 1650, to: 2050 }],
    });

    return out;
  }, baseUrl);

  // --- assertions -------------------------------------------------------

  check(
    'worklet renders audio',
    result.full.peak > 0.02 && result.full.nonFinite === 0,
    `peak ${result.full.peak.toFixed(4)} at ${result.full.sampleRate} Hz`,
  );
  check('no worklet errors', result.full.errors.length === 0, result.full.errors.join('; '));
  check(
    'telemetry arrives at ~30 Hz',
    result.full.telemetry.frames > 10,
    `${result.full.telemetry.frames} frames in 1.2 s`,
  );
  check(
    'playhead advances',
    result.full.telemetry.sawPlaying && result.full.telemetry.distinctSteps > 3,
    `${result.full.telemetry.distinctSteps} distinct steps, ${result.full.telemetry.minStep}..${result.full.telemetry.maxStep}`,
  );
  check(
    'meters show signal',
    result.full.telemetry.maxLevels.some((l) => l > 0.001),
    `peak levels ${JSON.stringify(result.full.telemetry.maxLevels)}`,
  );
  check(
    'output is stereo, not duplicated mono',
    result.full.peakL > 0 && result.full.peakR > 0 && result.full.peakL !== result.full.peakR,
    `L ${result.full.peakL.toFixed(4)} R ${result.full.peakR.toFixed(4)}`,
  );

  for (const [id, r] of Object.entries(result.tracks)) {
    check(
      `track "${id}" renders`,
      r.peak > 0.02 && r.errors.length === 0,
      `peak ${r.peak.toFixed(4)}${r.errors.length ? ` errors: ${r.errors.join('; ')}` : ''}`,
    );
  }

  check(
    'cutting every stem falls silent',
    result.allMuted.peak < 1e-3,
    `peak ${result.allMuted.peak.toExponential(2)}`,
  );
  check(
    'a lo-fi track with every stem cut keeps only its hiss and crackle',
    result.lofiMuted.peak > 1e-4 && result.lofiMuted.peak < 0.1 && result.lofiMuted.nonFinite === 0,
    `peak ${result.lofiMuted.peak.toExponential(2)}`,
  );
  check(
    'bass solo is audible but quieter than the full mix',
    result.bassSolo.peak > 0.005 && result.bassSolo.peak < result.fullLong.peak,
    `solo ${result.bassSolo.peak.toFixed(4)} vs full ${result.fullLong.peak.toFixed(4)}`,
  );
  check(
    'tempo / filter / echo / stereo all accepted',
    result.tempo.peak > 0.01 && result.tempo.errors.length === 0,
    `peak ${result.tempo.peak.toFixed(4)}${result.tempo.errors.length ? ` errors: ${result.tempo.errors.join('; ')}` : ''}`,
  );

  {
    const r = result.scratch;
    // The first playhead reports a beat or so after letting go, allowing for
    // message and telemetry latency.
    const after = r.stepLog.filter(([t]) => t > 2250).map(([, step]) => step);
    const first = after.length ? after[0] : -1;
    check(
      'scratch drags audible signal and resumes near step 64',
      r.windowPeak.drag > 0.01 && first >= 64 && first <= 72 && r.errors.length === 0,
      `drag peak ${r.windowPeak.drag.toFixed(4)}, first step after release ${first}${r.errors.length ? ` errors: ${r.errors.join('; ')}` : ''}`,
    );
  }

  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll audio checks passed.');