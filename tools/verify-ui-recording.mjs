/**
 * The performance recording in the app (docs/PERFORMANCE_EVENTS.md).
 *
 * tools/check-recording.mjs holds the pure module to its rules; this plays a short
 * take in the browser through `window.__BCKGRND_RECORDING__`: start, a scene on the next
 * bar, a fill, a queued scene canceled, a 2-bar Rise, stop. Then the take must hold
 * exactly the applied three, in order, on bar lines, and the canceled one only in the
 * log. A transport Stop ends a take by itself.
 *
 * Run by tools/verify-ui.mjs (recordingChecks), or on its own:
 *   node tools/verify-ui-recording.mjs [baseUrl]
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RT = { timeout: 30000 };
const SPARSE = 1;
const BUILD = 2;
const DROP = 3;

function kit(page) {
  const slot = (i) => page.locator('.scene-slot').nth(i);
  const pad = (i) => slot(i).locator('.scene-pad');
  const waitState = (i, states, opts = RT) =>
    page.waitForFunction(([n, list]) => list.includes(document.querySelectorAll('.scene-slot')[n]?.getAttribute('data-state')), [i, [].concat(states)], opts);
  const waitStatus = (re, opts = RT) =>
    page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.scene-status')?.textContent?.trim() ?? ''), re.source, opts);
  const play = async () => {
    if ((await page.locator('.app').getAttribute('data-playing')) === 'yes') return;
    await page.getByRole('button', { name: 'Play the track', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, RT);
  };
  const rec = (method) => page.evaluate((m) => window.__BCKGRND_RECORDING__[m](), method);
  const waitCount = (n, opts = RT) =>
    page.waitForFunction((want) => (window.__BCKGRND_RECORDING__.recording()?.events.length ?? 0) >= want, n, opts);
  /** Until an event of `kind` is in the take with its outcome settled (no eval: the page's CSP forbids it). */
  const waitClosed = (kind, opts = RT) =>
    page.waitForFunction((want) => (window.__BCKGRND_RECORDING__.recording()?.events ?? []).some((e) => e.kind === want && e.outcome !== 'open'), kind, opts);
  return { slot, pad, waitState, waitStatus, play, rec, waitCount, waitClosed };
}

export async function recordingChecks({ open, check }) {
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    let at = 'open';
    try {
      check('recording: the host exposes the recording hook, idle at first',
        await page.evaluate(() => typeof window.__BCKGRND_RECORDING__?.start === 'function' && window.__BCKGRND_RECORDING__.state() === 'idle'));
      await k.play();
      await k.rec('start');
      check('recording: Start records', (await k.rec('state')) === 'recording');

      // A scene on the next bar.
      at = 'scene on the next bar';
      await k.pad(SPARSE).click();
      await k.waitState(SPARSE, ['active', 'modified']);
      await k.waitCount(1);

      // A fill: kept once it starts, closed once it ends.
      at = 'fill';
      await page.locator('.fill-button').click();
      await k.waitClosed('fill');

      // A queued scene, canceled by pressing it again: never in the take.
      at = 'cancel a queued scene';
      await k.pad(BUILD).click();
      await k.waitStatus(/^Build queued/);
      await k.pad(BUILD).click();
      await k.waitStatus(/^Build cancelled/);

      // A 2-bar Rise into Drop.
      at = '2-bar Rise';
      const rise = page.getByRole('radio', { name: 'Rise into the scene over several bars' });
      if ((await rise.getAttribute('aria-checked')) !== 'true') await rise.click();
      await page.getByRole('radio', { name: 'Rise over 2 bars' }).click();
      await k.pad(DROP).click();
      await k.waitClosed('rise');
      await k.rec('stop');

      const doc = await k.rec('recording');
      const log = await k.rec('log');
      const events = doc?.events ?? [];
      const said = events.map((e) => `${e.kind}:${e.slot ?? e.style}@${e.step}`).join(' ');
      check('recording: Stop stops, by the user', (await k.rec('state')) === 'stopped' && doc?.stoppedBy === 'user');
      check('recording: the take holds the scene, the fill and the Rise, in that order',
        events.map((e) => e.kind).join(' ') === 'scene fill rise' && events[0].slot === 'sparse' && events[2].slot === 'drop', said);
      check('recording: seq counts 1, 2, 3', events.every((e, i) => e.seq === i + 1), said);
      check('recording: each lands on a bar line, at engine steps, none off grid',
        events.every((e) => e.step % 16 === 0 && e.beat === 1 && e.sixteenth === 1 && !e.offGrid && e.bar === e.step / 16 + 1), said);
      const ahead = (from, to) => (to - from + 256) % 256;
      check('recording: steps move forward through the take',
        events.length === 3 && ahead(events[0].step, events[1].step) > 0 && ahead(events[1].step, events[2].step) > 0, said);
      check('recording: the scene names Sparse, launched on the bar', events[0]?.name === 'Sparse' && events[0]?.timing === 'bar', JSON.stringify(events[0]));
      check('recording: the fill ran its bar', events[1]?.outcome === 'played' && events[1]?.endStep === (events[1]?.step + 16) % 256, JSON.stringify(events[1]));
      check('recording: the Rise ran 2 bars and landed Drop',
        events[2]?.bars === 2 && events[2]?.outcome === 'landed' && events[2]?.endStep === (events[2]?.step + 32) % 256, JSON.stringify(events[2]));
      const build = log.filter((l) => l.kind === 'scene' && l.status !== 'session');
      const canceled = build.find((l) => l.status === 'canceled');
      check('recording: the canceled Build is absent from the take', !events.some((e) => e.slot === 'build' || e.requestId === canceled?.requestId));
      check('recording: and in the log, queued then canceled, never recorded',
        canceled !== undefined && log.some((l) => l.requestId === canceled.requestId && l.status === 'queued') && log.filter((l) => l.requestId === canceled.requestId).every((l) => !l.recorded),
        log.map((l) => `${l.requestId}:${l.status}`).join(' '));
      check('recording: the header names the track, 16 steps a bar',
        doc?.format === 'bckgrnd-msc/performance' && doc.version === 1 && typeof doc.track === 'string' && doc.stepsPerBar === 16 && doc.startedAtStep >= 0);

      // A transport Stop ends a take by itself; Clear empties it.
      at = 'transport Stop';
      await k.rec('start');
      await page.getByRole('button', { name: 'Stop the track', exact: true }).click();
      await page.waitForFunction(() => window.__BCKGRND_RECORDING__.state() === 'stopped', null, RT);
      check('recording: a transport Stop ends the take', (await k.rec('recording'))?.stoppedBy === 'stop');
      await k.rec('clear');
      check('recording: Clear leaves it idle and empty', (await k.rec('state')) === 'idle' && (await k.rec('recording')) === null);
    } catch (e) {
      const seen = await page.evaluate(() => ({
        state: window.__BCKGRND_RECORDING__?.state(),
        status: document.querySelector('.scene-status')?.textContent?.trim(),
        log: (window.__BCKGRND_RECORDING__?.log() ?? []).slice(-8).map((l) => `${l.requestId}:${l.kind}:${l.status}`).join(' '),
      })).catch(() => ({}));
      check('recording: the walk-through ran to the end', false, `at ${at}: ${String(e.message).split('\n')[0]} | ${JSON.stringify(seen)}`);
    }
    check('recording: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { chromium } = await import('playwright');
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8080';
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM) ? process.env.PLAYWRIGHT_CHROMIUM : undefined;
  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(name);
  };
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const open = async (width, height, extra = {}) => {
    const page = await browser.newPage({ viewport: { width, height }, ...extra });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('article.stem');
    return { page, errors };
  };
  try {
    await recordingChecks({ open, check });
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`\n${failures.length} recording check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll recording checks passed.');
}
