/**
 * Verify the static build.
 *
 * The app ships in two shapes and this checks the one most likely to rot silently:
 * the PHP-free build, where the frontend is served as plain files and the track
 * library comes from JSON exported at build time.
 *
 * If `public/library` is stale or the frontend's fallback logic is wrong, the page
 * still renders — it just has no tracks — so this asserts on the audio path rather
 * than on a screenshot.
 *
 * Usage: node tools/verify-static.mjs [baseUrl]
 */

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8090';

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
    return undefined;
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
  const consoleErrors = [];
  // Netlify's free plan injects /.netlify/scripts/hud (the "Powered by
  // Netlify" badge), and that can't be turned off. The script builds an
  // about:srcdoc iframe with an inline script, which our CSP blocks. The app
  // never uses srcdoc, so only that exact error is skipped, and only when the
  // badge script is on the page. Every other console error still fails.
  const netlifyBadgeErrors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.location().url === 'about:srcdoc' && m.text().includes('Content Security Policy')) {
      netlifyBadgeErrors.push(m.text());
      return;
    }
    consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('requestfailed', (r) => consoleErrors.push(`request failed: ${r.url()}`));

  // Record every URL the page asks for, so we can prove PHP was never involved.
  const requests = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));

  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

  // 1. The app rendered, from the static shell.
  const ui = await page.evaluate(() => ({
    h1: document.querySelector('h1')?.textContent?.trim() ?? null,
    stems: document.querySelectorAll('article.stem').length,
    tracks: document.querySelectorAll('.track-badge').length,
  }));
  check('static shell renders the app', ui.h1 === 'bckgrnd-msc' && ui.stems === 8,
    `h1 ${ui.h1}, ${ui.stems} stems, ${ui.tracks} tracks`);
  check('library loaded from JSON', ui.tracks === 18, `${ui.tracks} track buttons`);

  // 2. No PHP route was contacted — everything came from static files.
  const phpRequests = requests.filter((p) => p.startsWith('/api/'));
  check('no API calls — library came from static files', phpRequests.length === 0,
    phpRequests.join(', ') || 'none');

  // 2b. Variations come from the exported catalog: the track as written can be
  //     varied, and a phrase the user changed is reported as unavailable, never
  //     replaced with a variation of different notes.
  {
    await page.getByRole('button', { name: 'Inspect Hats' }).click();
    await page.getByRole('button', { name: 'Show the hats pattern' }).click();
    const editor = page.locator('#pattern-drawer');
    await editor.locator('.bar-button').nth(8).click();
    await editor.getByRole('button', { name: 'Vary', exact: true }).click();
    const vary = editor.getByRole('group', { name: 'Vary' });
    await vary.getByRole('button', { name: 'Preview variation' }).click();
    await editor.locator('.preview-bar').waitFor({ timeout: 8000 });
    check('static: the catalog varies the track as written', await editor.locator('.preview-bar').isVisible());
    await editor.getByRole('button', { name: 'Revert' }).click();
    await page.locator('[data-drum-cell][data-lane="hat"][data-step="129"]').click();
    await vary.getByRole('button', { name: 'Preview variation' }).click();
    const why = editor.getByTestId('vary-unavailable');
    await why.waitFor({ timeout: 8000 });
    const text = (await why.textContent()) ?? '';
    check('static: a changed phrase is unavailable, with the reason', /^Unavailable: This phrase has been changed/.test(text), text);
    check('static: and nothing is previewed in its place', (await editor.locator('.preview-bar').count()) === 0);
    const api = requests.filter((p) => p.startsWith('/api/'));
    check('static: still no API calls', api.length === 0, api.join(', ') || 'none');
  }

  // 3. Audio works on the static build, which is the thing most likely to differ.
  const audio = await page.evaluate(async () => {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/build/engine-worklet.js');
    const node = new AudioWorkletNode(ctx, 'bckgrnd-msc-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const errors = [];
    let frames = 0;
    let maxLevel = 0;
    let sawPlaying = false;
    node.port.onmessage = (e) => {
      if (e.data.type === 'error') errors.push(`${e.data.command}: ${e.data.message}`);
      if (e.data.type === 'telemetry') {
        frames += 1;
        sawPlaying ||= e.data.frame[9] === 1;
        for (let i = 0; i < 8; i += 1) maxLevel = Math.max(maxLevel, e.data.frame[i]);
      }
    };
    const splitter = ctx.createChannelSplitter(2);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    node.connect(splitter);
    splitter.connect(analyser, 0);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);

    const wasm = await (await fetch('/wasm/bckgrnd_msc_engine_bg.wasm')).arrayBuffer();
    const { track } = await (await fetch('/library/warehouse.json')).json();
    node.port.postMessage({ type: 'init', wasm, sampleRate: ctx.sampleRate }, [wasm]);
    node.port.postMessage({ type: 'track', deck: 'a', json: JSON.stringify(track) });
    node.port.postMessage({ type: 'transport', deck: 'a', action: 'play' });

    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline && (frames < 20 || peak <= 0.02 || !sawPlaying)) {
      analyser.getFloatTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      await new Promise((r) => setTimeout(r, 16));
    }
    node.disconnect();
    await ctx.close();
    return { peak, frames, maxLevel, sawPlaying, errors };
  });

  check('static build produces audio', audio.peak > 0.02,
    `peak ${audio.peak.toFixed(4)}`);
  check('telemetry flows on the static build',
    audio.frames > 10 && audio.sawPlaying,
    `${audio.frames} frames, playing ${audio.sawPlaying}`);
  check('meters show signal', audio.maxLevel > 0.001, `max level ${audio.maxLevel.toFixed(4)}`);
  check('no worklet errors', audio.errors.length === 0, audio.errors.join('; '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.join('; '));
  if (netlifyBadgeErrors.length) {
    const badgeOnPage = await page
      .locator('script[src^="/.netlify/scripts/hud"]')
      .count();
    check('skipped errors come only from the Netlify badge', badgeOnPage > 0,
      `${netlifyBadgeErrors.length} skipped, badge script ${badgeOnPage ? 'present' : 'MISSING'}`);
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nStatic build verified: renders, loads its library from JSON, and plays audio.');