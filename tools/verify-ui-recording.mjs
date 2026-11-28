/**
 * The performance recording in the app (docs/PERFORMANCE_EVENTS.md).
 *
 * tools/check-recording.mjs holds the pure module to its rules; this plays a short
 * take in the browser through `window.__BCKGRND_RECORDING__`: start, a scene on the next
 * bar, a fill, a queued scene canceled, a 2-bar Rise, a held Beat Repeat, stop. Then the
 * take must hold exactly the applied four, in order, the three requests on bar lines,
 * the canceled one only in the log, and its export must validate against
 * contracts/performance.json (v2). A transport Stop ends a take by itself.
 *
 * The repeat and the onsets need the engine's Night 11 events (61/62 and `s` on every
 * event); on an engine without them those checks fail.
 *
 * Take files (Night 11B): record a scene, a fill, a Beat-length fill and a repeat,
 * export, then Open that file in the events drawer and see the same events and the
 * state at Record; a file that is not a take says so on the status line; Close goes
 * back to the live take, which opening never touched.
 *
 * Run by tools/verify-ui.mjs (recordingChecks), or on its own:
 *   node tools/verify-ui-recording.mjs [baseUrl]
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performanceValidator } from './performance-schema.mjs';

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

      // A Beat Repeat, held past a grid line, then let go: kept from engage to end.
      at = 'Beat Repeat';
      const repeatPad = page.getByRole('button', { name: 'Beat repeat, while held', exact: true });
      await repeatPad.scrollIntoViewIfNeeded();
      const rb = await repeatPad.boundingBox();
      await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
      await page.mouse.down();
      await page.waitForFunction(() => (window.__BCKGRND_RECORDING__.recording()?.events ?? []).some((e) => e.kind === 'repeat'), null, RT);
      await page.waitForTimeout(600);
      await page.mouse.up();
      await page.waitForFunction(() => (window.__BCKGRND_RECORDING__.recording()?.events ?? []).some((e) => e.kind === 'repeat' && e.endedBy !== 'open'), null, RT);
      await k.rec('stop');

      const doc = await k.rec('recording');
      const log = await k.rec('log');
      const all = doc?.events ?? [];
      const repeat = all.find((e) => e.kind === 'repeat');
      const events = all.filter((e) => e.kind !== 'repeat');
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
        doc?.format === 'bckgrnd-msc/performance' && doc.version === 2 && typeof doc.track === 'string' && doc.stepsPerBar === 16 && Number.isInteger(doc.startedAtStep) && doc.startedAtStep >= -1 && doc.startedAtStep <= 255, JSON.stringify({ track: doc?.track, startedAtStep: doc?.startedAtStep }));

      // v2: the repeat, onsets, and the export.
      check('recording: the repeat is in the take, after the Rise',
        repeat !== undefined && all.indexOf(repeat) === 3 && all.length === 4, all.map((e) => e.kind).join(' '));
      check('recording: the repeat engaged on an eighth grid line, and ended after it',
        repeat?.division === 8 && repeat.step % 2 === 0 && repeat.endedBy === 'engine' && repeat.endOnset > repeat.onset, JSON.stringify(repeat));
      check('recording: every event has an onset, the first 0, never going back, seq order',
        all.length > 0 && all[0].onset === 0 && all.every((e, i) => Number.isInteger(e.onset) && Number.isInteger(e.pass) && (i === 0 || e.onset >= all[i - 1].onset)),
        all.map((e) => `${e.kind}@${e.step}/${e.onset}`).join(' '));
      check('recording: onsets agree with steps while the song runs straight',
        events.length === 3 && [1, 2].every((i) => events[i].onset - events[i - 1].onset === ahead(events[i - 1].step, events[i].step)), said);
      check('recording: the fill says the length it played', events[1]?.length === 'bar' || events[1]?.length === 'beat', JSON.stringify(events[1]));
      at = 'export';
      const exported = await k.rec('exportTake');
      const parsed = exported ? JSON.parse(exported.json) : null;
      check('recording: export names the file bckgrnd-take-<track>-<YYYY-MM-DD-HHmm>.json',
        /^bckgrnd-take-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-\d{4}\.json$/.test(exported?.filename ?? '') && exported.filename.includes(doc.track.toLowerCase()), exported?.filename);
      const errs = parsed ? performanceValidator()(parsed) : ['no export'];
      check('recording: the export validates against contracts/performance.json (v2)', errs.length === 0, errs.slice(0, 4).join('; '));
      check('recording: the export is the take', JSON.stringify(parsed) === JSON.stringify(doc));
      const download = await Promise.all([
        page.waitForEvent('download', { timeout: 5000 }),
        page.evaluate(() => window.__BCKGRND_RECORDING__.download()),
      ]).then(([d]) => d.suggestedFilename()).catch((e) => `no download: ${String(e.message).split('\n')[0]}`);
      check('recording: the download helper saves it under that name', download === exported?.filename, download);

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
        log: (window.__BCKGRND_RECORDING__?.log() ?? []).slice(-8).map((l) => `${l.requestId}:${l.kind}:${l.status}${l.detail ? `(${l.detail})` : ''}`).join(' '),
      })).catch(() => ({}));
      check('recording: the walk-through ran to the end', false, `at ${at}: ${String(e.message).split('\n')[0]} | ${JSON.stringify(seen)}`);
    }
    check('recording: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // Take files (Night 11B): export a take, open it again in the events drawer, close it.
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    let at = 'open';
    try {
      await k.play();
      await k.rec('start');
      at = 'scene';
      await k.pad(SPARSE).click();
      await k.waitCount(1);
      at = 'bar fill';
      await page.locator('.fill-button').click();
      await k.waitClosed('fill');
      at = 'beat fill';
      const lengths = page.getByRole('radiogroup', { name: 'Fill length', exact: true });
      await lengths.getByRole('radio', { name: 'Beat', exact: true }).click();
      await page.locator('.fill-button').click();
      await page.waitForFunction(() => (window.__BCKGRND_RECORDING__.recording()?.events ?? []).some((e) => e.kind === 'fill' && e.length === 'beat' && e.outcome !== 'open'), null, RT);
      await lengths.getByRole('radio', { name: 'Bar', exact: true }).click();
      at = 'repeat';
      const repeatPad = page.getByRole('button', { name: 'Beat repeat, while held', exact: true });
      await repeatPad.scrollIntoViewIfNeeded();
      const rb = await repeatPad.boundingBox();
      await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
      await page.mouse.down();
      await page.waitForFunction(() => (window.__BCKGRND_RECORDING__.recording()?.events ?? []).some((e) => e.kind === 'repeat'), null, RT);
      await page.waitForTimeout(500);
      await page.mouse.up();
      await page.waitForFunction(() => (window.__BCKGRND_RECORDING__.recording()?.events ?? []).some((e) => e.kind === 'repeat' && e.endedBy !== 'open'), null, RT);
      await k.rec('stop');
      const live = await k.rec('recording');
      const kinds = live.events.map((e) => `${e.kind}${e.length ? `:${e.length}` : ''}`).join(' ');
      check('take files: the take holds a scene, a bar fill, a beat fill and a repeat', kinds === 'scene fill:bar fill:beat repeat', kinds);
      const init = live.initial;
      check('take files: the take has the state at Record: track, tempo, scene, the whole mix, fill, division, loop',
        init?.track === live.track && init.bpm === live.bpm && typeof init.swing === 'number' && 'slot' in (init.scene ?? {})
          && Object.keys(init.mix?.params ?? {}).length === 17 && Object.keys(init.mix?.stems ?? {}).length === 8
          && init.fill?.length === 'bar' && init.repeatDivision === 8 && init.loopBars === 0, JSON.stringify(init).slice(0, 160));

      // Export: the drawer's Export downloads it; save that file.
      at = 'export';
      await page.getByRole('button', { name: 'Take events', exact: true }).click();
      const drawer = page.getByRole('region', { name: 'Take events', exact: true });
      await drawer.waitFor();
      const [download] = await Promise.all([page.waitForEvent('download', RT), drawer.getByRole('button', { name: 'Export' }).click()]);
      const dir = mkdtempSync(join(tmpdir(), 'bckgrnd-take-'));
      const file = join(dir, download.suggestedFilename());
      await download.saveAs(file);
      const liveRows = await page.locator('.events-row').allInnerTexts();
      check('take files: the drawer lists the live take', liveRows.length === 4, liveRows.join(' | '));

      // A file that is not a take: the status line says why, nothing opens.
      at = 'open a bad file';
      const bad = join(dir, 'not-a-take.json');
      writeFileSync(bad, JSON.stringify({ format: 'bckgrnd-msc/project', version: 4 }));
      await page.locator('.events-file').setInputFiles(bad);
      await page.waitForFunction(() => /Couldn't open not-a-take\.json/.test(document.querySelector('.events-summary')?.textContent ?? ''), null, RT);
      check('take files: a project file is refused on the status line, in plain English',
        /Not a performance take/.test(await page.locator('.events-summary').innerText()) && (await page.evaluate(() => window.__BCKGRND_RECORDING__.opened())) === null,
        await page.locator('.events-summary').innerText());

      // Open the exported take.
      at = 'open the export';
      await page.locator('.events-file').setInputFiles(file);
      await page.waitForFunction(() => /^Opened: /.test(document.querySelector('.events-summary')?.textContent ?? ''), null, RT);
      const opened = await page.evaluate(() => window.__BCKGRND_RECORDING__.opened());
      check('take files: Open reads the file: the same events and the same state at Record',
        JSON.stringify(opened?.events) === JSON.stringify(live.events) && JSON.stringify(opened?.initial) === JSON.stringify(live.initial));
      const head = await page.locator('.events-summary').innerText();
      check('take files: the drawer says Opened: <file> and the count', head === `Opened: ${download.suggestedFilename()} · 4 events`, head);
      const openedRows = await page.locator('.events-row').allInnerTexts();
      check('take files: the opened take lists the same rows', JSON.stringify(openedRows) === JSON.stringify(liveRows), openedRows.join(' | '));
      check('take files: opening left the live take alone',
        JSON.stringify(await k.rec('recording')) === JSON.stringify(live) && (await k.rec('state')) === 'stopped'
          && (await page.locator('.app').getAttribute('data-playing')) === 'yes');
      const exportBtn = drawer.getByRole('button', { name: 'Export' });
      check('take files: Export (the live take) steps aside while an opened take shows', (await exportBtn.count()) === 0);
      const fits = await page.evaluate(() => {
        const d = document.querySelector('.events-drawer').getBoundingClientRect();
        return [...document.querySelectorAll('.events-head button')].every((b) => {
          const r = b.getBoundingClientRect();
          return r.left >= d.left && r.right <= d.right + 0.5;
        });
      });
      check('take files: the header buttons stay inside the drawer with a long file name', fits);
      const openBtn = drawer.getByRole('button', { name: 'Open a take file', exact: true });
      const closeBtn = drawer.getByRole('button', { name: 'Close the opened take, back to the live take', exact: true });
      check('take files: Open and Close are in the drawer', (await openBtn.count()) === 1 && (await closeBtn.count()) === 1);

      // Close: back to the live take.
      at = 'close';
      await closeBtn.click();
      await page.waitForFunction(() => /^Stopped · /.test(document.querySelector('.events-summary')?.textContent ?? ''), null, RT);
      check('take files: Close goes back to the live take',
        (await page.evaluate(() => window.__BCKGRND_RECORDING__.opened())) === null && (await page.locator('.events-row').count()) === 4
          && (await exportBtn.count()) === 1 && (await exportBtn.getAttribute('aria-disabled')) === null, await page.locator('.events-summary').innerText());
    } catch (e) {
      check('take files: the walk-through ran to the end', false, `at ${at}: ${String(e.message).split('\n')[0]}`);
    }
    check('take files: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }
  {
    const { page } = await open(390, 844, { hasTouch: true, isMobile: true });
    await page.locator('.events-toggle').click();
    const sizes = await page.locator('.events-drawer .events-action').evaluateAll((els) => els.map((el) => {
      const b = el.getBoundingClientRect();
      return { name: el.textContent?.trim(), w: Math.round(b.width), h: Math.round(b.height) };
    }));
    check('take files: on a phone Open and Export are at least 44px', sizes.length >= 2 && sizes.every((b) => b.w >= 44 && b.h >= 44), JSON.stringify(sizes));
    await page.close();
  }

  // The Record indicator in the transport (Night 10, round 3): the same take through the UI.
  {
    const { page, errors } = await open(1280, 800);
    const k = kit(page);
    const toggle = page.locator('.record-toggle');
    const name = () => toggle.getAttribute('aria-label');
    try {
      const word = await page.locator('.record-word').isVisible();
      check('record ui: idle, a hollow dot alone at 1280, not pressed',
        (await page.locator('.record').getAttribute('data-state')) === 'idle' && (await toggle.getAttribute('aria-pressed')) === 'false'
          && (await name()) === 'Record the performance' && !word, `${await name()}, word ${word}`);
      await k.play();
      await toggle.click();
      await page.waitForFunction(() => window.__BCKGRND_RECORDING__.state() === 'recording', null, RT);
      check('record ui: pressing it records, pressed, and says so', (await toggle.getAttribute('aria-pressed')) === 'true'
        && /^Recording · 0 events$/.test((await name()) ?? ''), await name());
      await k.pad(SPARSE).click();
      await k.waitCount(1);
      await page.waitForFunction(() => /^Recording · 1 event$/.test(document.querySelector('.record-toggle')?.getAttribute('aria-label') ?? ''), null, RT);
      check('record ui: the count is in its name and tooltip', /1 event/.test((await toggle.getAttribute('title')) ?? ''), await toggle.getAttribute('title'));
      // Keyboard: Enter on the focused toggle stops the take.
      await toggle.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__BCKGRND_RECORDING__.state() === 'stopped', null, RT);
      const clear = page.getByRole('button', { name: /^Clear the take/ });
      check('record ui: Enter stops it; stopped shows the take and a Clear button',
        (await toggle.getAttribute('aria-pressed')) === 'false' && (await page.locator('.record').getAttribute('data-state')) === 'stopped'
          && /last take 1 event/.test((await name()) ?? '') && (await clear.count()) === 1, await name());
      await clear.click();
      check('record ui: Clear empties it back to idle',
        (await k.rec('state')) === 'idle' && (await k.rec('recording')) === null && (await page.getByRole('button', { name: /^Clear the take/ }).count()) === 0
          && (await name()) === 'Record the performance');
    } catch (e) {
      check('record ui: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('record ui: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }
  {
    const { page } = await open(1440, 900);
    check('record ui: 1440 has room for the word Rec', await page.locator('.record-word').isVisible());
    await page.close();
  }
  {
    const { page } = await open(390, 844, { hasTouch: true, isMobile: true });
    const b = await page.locator('.record-toggle').boundingBox();
    check('record ui: on a phone the toggle is at least 44px', b !== null && b.width >= 44 && b.height >= 44, b ? `${Math.round(b.width)}x${Math.round(b.height)}` : 'missing');
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
