// The native-shell audio probe. See probe.html for what it is for.
//
// Everything is measured, nothing assumed: the page reports what the shell gave it
// (origin, secure context, AudioWorklet, the context's rate and latency) and then
// what the engine produced (peak, stereo, telemetry, errors). "pass" means the engine
// ran and produced sound in this shell. It cannot prove a speaker played it, because
// the analyser taps the signal before the output device, the same limit as
// tools/verify-audio.mjs.

const out = document.getElementById('out');
const result = { checks: {}, facts: {} };

function row(name, value, ok) {
  const tr = document.createElement('tr');
  const a = document.createElement('td');
  const b = document.createElement('td');
  a.textContent = name;
  b.textContent = typeof value === 'string' ? value : JSON.stringify(value);
  if (ok === true) b.className = 'ok';
  if (ok === false) b.className = 'fail';
  tr.append(a, b);
  out.append(tr);
}

function fact(name, value) {
  result.facts[name] = value;
  row(name, value);
}

function check(name, ok, detail) {
  result.checks[name] = { ok, detail };
  row(name, `${ok ? 'ok' : 'FAIL'}${detail ? ` — ${detail}` : ''}`, ok);
  return ok;
}

async function run() {
  out.replaceChildren();
  result.checks = {};
  result.facts = {};
  document.title = 'probe: running';

  fact('origin', location.origin);
  fact('user agent', navigator.userAgent);
  check('secure context', window.isSecureContext === true, String(window.isSecureContext));
  if (!check('AudioWorklet available', typeof AudioWorklet !== 'undefined')) return finish();

  let ctx;
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume();
    fact('context state', ctx.state);
    fact('sample rate', ctx.sampleRate);
    fact('base latency', ctx.baseLatency);
    fact('output latency', ctx.outputLatency ?? null);
    check('context running', ctx.state === 'running', ctx.state);
  } catch (e) {
    check('context created', false, e.message);
    return finish();
  }

  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    fact('audio outputs listed', devices ? devices.filter((d) => d.kind === 'audiooutput').length : 'unavailable');
  } catch {
    fact('audio outputs listed', 'refused');
  }

  try {
    await ctx.audioWorklet.addModule(`/build/engine-worklet.js?probe=${Date.now()}`);
    check('worklet module loads', true);
  } catch (e) {
    check('worklet module loads', false, e.message);
    return finish(ctx);
  }

  const node = new AudioWorkletNode(ctx, 'bckgrnd-msc-engine', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  const errors = [];
  let frames = 0;
  let masterPeak = 0;
  node.port.onmessage = (e) => {
    if (e.data.type === 'error') errors.push(`${e.data.command}: ${e.data.message}`);
    if (e.data.type === 'telemetry') {
      frames += 1;
      masterPeak = Math.max(masterPeak, e.data.frame[12] ?? 0, e.data.frame[13] ?? 0);
    }
  };

  const splitter = ctx.createChannelSplitter(2);
  const left = ctx.createAnalyser();
  const right = ctx.createAnalyser();
  left.fftSize = right.fftSize = 2048;
  node.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  // Quiet, not silent: the probe should be audible in a real shell so a person
  // running it hears that sound reaches the speaker, but not at full level.
  const level = ctx.createGain();
  level.gain.value = new URLSearchParams(location.search).has('mute') ? 0 : 0.25;
  node.connect(level);
  level.connect(ctx.destination);

  try {
    const wasm = await (await fetch('/wasm/bckgrnd_msc_engine_bg.wasm')).arrayBuffer();
    const { track } = await (await fetch('/library/warehouse.json')).json();
    node.port.postMessage({ type: 'init', wasm, sampleRate: ctx.sampleRate }, [wasm]);
    node.port.postMessage({ type: 'track', deck: 'a', json: JSON.stringify(track) });
    node.port.postMessage({ type: 'transport', deck: 'a', action: 'play' });
    check('engine and track load', true);
  } catch (e) {
    check('engine and track load', false, e.message);
    return finish(ctx);
  }

  const bufL = new Float32Array(left.fftSize);
  const bufR = new Float32Array(right.fftSize);
  let peakL = 0;
  let peakR = 0;
  let nonFinite = 0;
  const started = performance.now();
  const deadline = started + 8000;
  while (performance.now() < deadline && (frames < 30 || peakL <= 0.02 || peakR <= 0.02)) {
    left.getFloatTimeDomainData(bufL);
    right.getFloatTimeDomainData(bufR);
    for (let i = 0; i < bufL.length; i += 1) {
      if (!Number.isFinite(bufL[i]) || !Number.isFinite(bufR[i])) nonFinite += 1;
      peakL = Math.max(peakL, Math.abs(bufL[i]));
      peakR = Math.max(peakR, Math.abs(bufR[i]));
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  node.port.postMessage({ type: 'transport', deck: 'a', action: 'stop' });

  check('engine produces sound', Math.max(peakL, peakR) > 0.02 && nonFinite === 0, `peak L ${peakL.toFixed(4)} R ${peakR.toFixed(4)}`);
  check('output is stereo', peakL > 0 && peakR > 0 && peakL !== peakR);
  check('telemetry reaches the page', frames > 10, `${frames} frames in ${Math.round(performance.now() - started)} ms`);
  check('master meter agrees with the output', Math.abs(masterPeak - Math.max(peakL, peakR)) < 0.1, `telemetry ${masterPeak.toFixed(4)}`);
  check('no engine errors', errors.length === 0, errors.join('; '));
  return finish(ctx);
}

async function finish(ctx) {
  try {
    await ctx?.close();
  } catch {
    /* already closed */
  }
  const pass = Object.values(result.checks).every((c) => c.ok) && Object.keys(result.checks).length > 0;
  result.pass = pass;
  window.__PROBE_RESULT__ = result;
  document.title = pass ? 'probe: pass' : 'probe: fail';
  row('result', pass ? 'pass' : 'fail', pass);
}

document.getElementById('run').addEventListener('click', () => void run());
if (new URLSearchParams(location.search).has('auto')) void run();
