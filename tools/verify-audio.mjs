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
  // An explicit path wins: CI images and sandboxes put Chromium in their own places.
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) {
    return process.env.PLAYWRIGHT_CHROMIUM;
  }
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
      // Ignore the first `settleMs` for the L-R difference and RMS, so glides land first.
      settleMs = 250,
      // Average the spectrum over the settled window, for checks about one band.
      spectrum = false,
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
      const seen = { steps: new Set(), maxLevels: new Array(8).fill(0), sawPlaying: false, frames: 0, masterPeak: 0, clipped: 0 };
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
        // [12] / [13] master peak left / right, [14] clipped (see engine-processor.ts).
        seen.masterPeak = Math.max(seen.masterPeak, f[12] ?? 0, f[13] ?? 0);
        if (f[14] === 1) seen.clipped += 1;
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
      // L - R, formed inside the graph so the two channels are sample-aligned. Reading
      // two analysers one after the other can straddle a render quantum, which made an
      // exactly mono output look 128 samples out of step with itself.
      const side = ctx.createGain();
      const invert = ctx.createGain();
      invert.gain.value = -1;
      splitter.connect(side, 0);
      splitter.connect(invert, 1);
      invert.connect(side);
      const analyserD = ctx.createAnalyser();
      analyserD.fftSize = 2048;
      side.connect(analyserD);
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
      let maxDiff = 0;
      // Per-channel peaks after the settle time, once glides (balance, width) arrive.
      let settledL = 0;
      let settledR = 0;
      let sumSq = 0;
      let count = 0;
      const bufD = new Float32Array(analyserD.fftSize);
      const freqBuf = new Float32Array(analyserL.frequencyBinCount);
      const power = new Float64Array(analyserL.frequencyBinCount);
      let spectra = 0;

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
        if (now >= settleMs) {
          analyserD.getFloatTimeDomainData(bufD);
          for (let i = 0; i < bufL.length; i += 1) {
            maxDiff = Math.max(maxDiff, Math.abs(bufD[i]));
            settledL = Math.max(settledL, Math.abs(bufL[i]));
            settledR = Math.max(settledR, Math.abs(bufR[i]));
            sumSq += bufL[i] * bufL[i] + bufR[i] * bufR[i];
            count += 2;
          }
          if (spectrum) {
            analyserL.getFloatFrequencyData(freqBuf);
            for (let i = 0; i < freqBuf.length; i += 1) power[i] += 10 ** (freqBuf[i] / 10);
            spectra += 1;
          }
        }
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
        maxDiff,
        settledL,
        settledR,
        rms: count ? Math.sqrt(sumSq / count) : 0,
        // Mean power per bin, and the bin width in Hz, when asked for.
        power: spectrum ? Array.from(power, (p) => p / Math.max(1, spectra)) : null,
        binHz: ctx.sampleRate / analyserL.fftSize,
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
          masterPeak: seen.masterPeak,
          clipped: seen.clipped,
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

    // 3b. The same on a lo-fi track: with every stem cut it falls silent too. (It
    //     once carried vinyl crackle and tape hiss outside the stems; they read as
    //     rain and were taken out.)
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

    // 5b. The effects rack's messages each reach the engine and change the sound.
    //     The DSP itself is tested in Rust; this proves the worklet plumbing.
    const fx = (commands) => measure({ ms: 1500, commands });
    out.fxDefault = await fx([]);
    out.fxMono = await fx([{ type: 'width', value: 0 }]);
    // Balance is heard as one speaker fading: hard left silences the right channel.
    out.fxBalanceLeft = await fx([{ type: 'stereoBalance', value: 0 }]);
    out.fxBalanceRight = await fx([{ type: 'stereoBalance', value: 1 }]);
    // Resonance is a peak at the cutoff, so it is measured there: the power in a band
    // around the cutoff with the filter closed to 0.3 (240 * 75^0.3, about 876 Hz).
    out.fxResonance = await measure({
      ms: 1500,
      spectrum: true,
      commands: [
        { type: 'filter', value: 0.3 },
        { type: 'filterQ', value: 6 },
      ],
    });
    out.fxDark = await measure({ ms: 1500, spectrum: true, commands: [{ type: 'filter', value: 0.3 }] });
    // The room is heard as what rings on after the music stops feeding it. Cutting
    // *every* stem now silences the returns too (the all-cut rule, checked below), so
    // the music is stopped here by cutting seven stems and turning the eighth down to a
    // whisper, and what is left a quarter second later is measured.
    const roomRun = (commands, allCut = false) =>
      measure({
        ms: 1550,
        commands,
        timeline: [
          ...Array.from({ length: allCut ? 8 : 7 }, (_, index) => ({
            at: 900,
            message: { type: 'mute', index, value: true },
          })),
          ...(allCut ? [] : [{ at: 900, message: { type: 'volume', index: 7, value: 0.001 } }]),
        ],
        windows: [{ name: 'tail', from: 1150, to: 1500 }],
      });
    out.fxRoomDefault = await roomRun([]);
    out.fxRoom = await roomRun([
      { type: 'reverbMix', value: 0.5 },
      { type: 'reverbDecay', value: 2.5 },
    ]);
    // Every stem cut with the room ringing: the output fades to silence, returns too.
    out.fxAllCut = await roomRun(
      [
        { type: 'reverbMix', value: 0.5 },
        { type: 'reverbDecay', value: 2.5 },
      ],
      true,
    );
    out.fxEcho = await fx([
      { type: 'echoFeedback', value: 0.9 },
      { type: 'echoReturn', value: 1 },
      { type: 'send', index: 0, value: 1 },
      { type: 'send', index: 1, value: 1 },
    ]);

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
  {
    const t = result.full.telemetry;
    // The telemetry peak and the analyser tap measure the same output, so they should
    // agree closely. Neither may reach full scale: a single deck is held at -0.3 dBFS.
    check(
      'master meter reports the output peak, without clipping',
      t.masterPeak > 0.02 &&
        Math.abs(t.masterPeak - result.full.peak) < 0.1 &&
        t.masterPeak < 1 &&
        t.clipped === 0,
      `telemetry peak ${t.masterPeak.toFixed(4)} vs analyser ${result.full.peak.toFixed(4)}, ${t.clipped} clipped frames`,
    );
  }
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
    'a lo-fi track with every stem cut falls silent too',
    result.lofiMuted.peak < 1e-6 && result.lofiMuted.nonFinite === 0,
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
    const d = result.fxDefault;
    const differs = (name, r, threshold = 0.05) => {
      const change = Math.abs(r.rms - d.rms) / d.rms;
      check(
        `${name} changes the sound`,
        change > threshold && r.errors.length === 0 && r.nonFinite === 0,
        `rms ${d.rms.toFixed(4)} -> ${r.rms.toFixed(4)} (${(change * 100).toFixed(1)}%)${r.errors.length ? ` errors: ${r.errors.join('; ')}` : ''}`,
      );
    };
    check(
      'width 0 folds the output to mono',
      result.fxMono.maxDiff < 1e-4 && d.maxDiff > 0.01 && result.fxMono.errors.length === 0,
      `max |L-R| ${result.fxMono.maxDiff.toExponential(2)} (default ${d.maxDiff.toFixed(3)})`,
    );
    // Measured after the settle time: the balance glides in from center over 20 ms,
    // and the first kick lands inside that glide.
    for (const [side, r, kept, gone] of [
      ['left', result.fxBalanceLeft, 'settledL', 'settledR'],
      ['right', result.fxBalanceRight, 'settledR', 'settledL'],
    ]) {
      check(
        `balance hard ${side} silences the other speaker`,
        r[gone] < 1e-3 && r[kept] > 0.5 * d[kept] && r.errors.length === 0,
        `L ${r.settledL.toFixed(4)} R ${r.settledR.toFixed(4)} (default L ${d.settledL.toFixed(4)} R ${d.settledR.toFixed(4)})`,
      );
    }
    {
      const band = (r, lo, hi) => {
        let sum = 0;
        r.power.forEach((p, i) => {
          const f = i * r.binHz;
          if (f >= lo && f <= hi) sum += p;
        });
        return sum;
      };
      const cutoff = 240 * 75 ** 0.3;
      const flat = band(result.fxDark, cutoff * 0.85, cutoff * 1.15);
      const peaked = band(result.fxResonance, cutoff * 0.85, cutoff * 1.15);
      const db = 10 * Math.log10(peaked / flat);
      check(
        'filter resonance lifts the band at the cutoff',
        db > 3 && result.fxResonance.errors.length === 0,
        `${db.toFixed(1)} dB around ${Math.round(cutoff)} Hz`,
      );
    }
    {
      const before = result.fxRoomDefault.windowPeak.tail;
      const after = result.fxRoom.windowPeak.tail;
      check(
        'room mix and decay ring on after the music stops',
        after > before * 3 && after > 1e-3 && result.fxRoom.errors.length === 0,
        `tail peak ${before.toExponential(2)} -> ${after.toExponential(2)}`,
      );
      check(
        'cutting every stem fades to silence, the room tail included',
        result.fxAllCut.windowPeak.tail < 1e-4 && result.fxAllCut.errors.length === 0,
        `tail peak ${result.fxAllCut.windowPeak.tail.toExponential(2)} (room left ringing: ${after.toExponential(2)})`,
      );
    }
    differs('echo feedback, return and stem sends', result.fxEcho);
  }

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