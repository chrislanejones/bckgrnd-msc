/**
 * Rise (Night 7 timed builds, docs/NIGHT7_PROTOCOL.md) at the host and UI level.
 *
 * `verify-ui` walks one Rise through the scene strip; this pins the rest of the
 * contract the screen makes: 2, 4 and 8 bars each start on the next bar line, count
 * "Rising · k of n" while bar N+k-1 plays and land on bar N+n; a cancel halfway puts
 * every knob back; a knob the user moves stays theirs while the others still land; a
 * scene's captured lanes land on the end bar and not before; Stop, seek, Panic and a
 * track load each leave no stuck pad or stale progress; a tempo change mid-rise keeps
 * the count truthful; and stopped, a Rise only says it needs playback.
 *
 * Every pad, bar-readout and status change is logged in the page with its time, so the
 * checks read what the screen showed and for how long, not a poll that can miss a bar.
 *
 * Run by tools/verify-ui.mjs (riseChecks), or on its own:
 *   node tools/verify-ui-rise.mjs [baseUrl]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCENE_PARAMS = JSON.parse(readFileSync(join(root, 'contracts/scenes.json'), 'utf8')).sceneVector;

/** Long enough for an 8-bar rise at the slowest tempo the checks use (100 BPM). */
const RT = { timeout: 30000 };
/** How far apart the pad's landing and the transport's bar change may be seen (ms). */
const LAND_SLACK = 300;
/** How long a pad line may be seen next to some other bar than its own (ms). */
const BAR_SLACK = 250;

/** The bar readout wraps 16 -> 1. */
const wrapBar = (b) => ((((b - 1) % 16) + 16) % 16) + 1;

/** A mix as flat numbers, keyed `fx.filter`, `kick.volume`, `kick.muted`... */
function flat(mix) {
  const out = {};
  for (const id of Object.keys(mix.params)) out[id] = mix.params[id];
  for (const [id, s] of Object.entries(mix.stems)) {
    out[`${id}.volume`] = s.volume;
    out[`${id}.send`] = s.send;
    out[`${id}.muted`] = s.muted ? 1 : 0;
    out[`${id}.solo`] = s.solo ? 1 : 0;
  }
  return out;
}

/** The keys where two flat mixes differ by more than `tol`. */
function differ(a, b, tol = 1e-4, keys = Object.keys(a)) {
  return keys.filter((k) => !(Math.abs(a[k] - b[k]) <= tol));
}

const show = (m, keys) => keys.map((k) => `${k} ${Number(m[k]).toFixed(3)}`).join(', ');

/** The helpers one page needs. */
function kit(page) {
  const slot = (i) => page.locator('.scene-slot').nth(i);
  const pad = (i) => slot(i).locator('.scene-pad');
  const stateOf = (i) => slot(i).getAttribute('data-state');
  const lineOf = async (i) => (await slot(i).locator('.scene-line').textContent())?.trim();
  const statusText = async () => (await page.locator('.scene-status').textContent())?.trim();
  const waitLine = (i, re, opts = RT) =>
    page.waitForFunction(
      ([n, src]) => new RegExp(src).test(document.querySelectorAll('.scene-slot')[n]?.querySelector('.scene-line')?.textContent?.trim() ?? ''),
      [i, re.source],
      opts,
    );
  const waitState = (i, states, opts = RT) =>
    page.waitForFunction(
      ([n, list]) => list.includes(document.querySelectorAll('.scene-slot')[n]?.getAttribute('data-state')),
      [i, [].concat(states)],
      opts,
    );
  const waitStatus = (re, opts = RT) =>
    page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.scene-status')?.textContent?.trim() ?? ''), re.source, opts);
  const mix = async () =>
    flat(await page.evaluate((ids) => {
      const p = window.__BCKGRND_PROJECT__();
      return { params: Object.fromEntries(ids.map((id) => [id, p.params[id]])), stems: p.stems };
    }, SCENE_PARAMS));
  const sceneMix = async (i) =>
    flat(await page.evaluate(([n, ids]) => {
      const s = window.__BCKGRND_PROJECT__().scenes.slots[n];
      return { params: Object.fromEntries(ids.map((id) => [id, s.params[id]])), stems: s.stems };
    }, [i, SCENE_PARAMS]));
  const project = (fn) => page.evaluate(fn);
  const barNow = () => page.locator('.bar-readout .tabular-nums').textContent();
  const nextBar = async () => {
    const b = await barNow();
    await page.waitForFunction((was) => document.querySelector('.bar-readout .tabular-nums')?.textContent !== was, b, RT);
  };
  const playing = async () => (await page.locator('.app').getAttribute('data-playing')) === 'yes';
  const play = async () => {
    if (await playing()) return;
    await page.getByRole('button', { name: 'Play the track', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, RT);
  };
  const riseOver = async (n) => {
    const rise = page.getByRole('radio', { name: 'Rise into the scene over several bars' });
    if ((await rise.getAttribute('aria-checked')) !== 'true') await rise.click();
    await page.getByRole('radio', { name: `Rise over ${n} bars` }).click();
  };
  // A knob's range input takes only multiples of its step; Playwright refuses any other.
  const knobFill = async (name, value) => {
    const slider = page.getByRole('slider', { name, exact: true });
    // A stem's inspector does not hold the master knobs; its Master tab does.
    if ((await slider.count()) === 0) await page.locator('.inspector').getByText('Master', { exact: true }).click();
    const step = Number(await slider.getAttribute('step')) || 1;
    await slider.fill(String(Math.round(value / step) * step));
  };
  /** Tempo is linear over the control's 60-180 BPM. */
  const tempo = (bpm) => knobFill('Tempo', ((bpm - 60) / 120) * 1000);
  const busy = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.scene-slot')]
        .map((el, i) => ({
          i,
          state: el.getAttribute('data-state'),
          line: el.querySelector('.scene-line')?.textContent?.trim() ?? '',
          progress: el.style.getPropertyValue('--build-progress'),
        }))
        .filter((p) => ['sending', 'queued', 'building'].includes(p.state) || /Ris/.test(p.line) || p.progress !== ''),
    );

  // The timeline: one entry per change of any pad, the bar readout or the status line.
  const record = () =>
    page.evaluate(() => {
      window.__RISE_OBS__?.disconnect();
      const log = (window.__RISE_LOG__ = []);
      const hash = (s) => {
        let h = 0;
        for (let i = 0; i < s.length; i += 1) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
        return h;
      };
      let last = '';
      const snap = () => {
        const pads = [...document.querySelectorAll('.scene-slot')].map((el) => ({
          state: el.getAttribute('data-state'),
          line: el.querySelector('.scene-line')?.textContent?.trim() ?? '',
          progress: el.style.getPropertyValue('--build-progress'),
        }));
        const readout = document.querySelector('.bar-readout .tabular-nums')?.textContent;
        const status = document.querySelector('.scene-status')?.textContent?.trim() ?? '';
        const p = window.__BCKGRND_PROJECT__?.();
        const lanes = p ? hash(JSON.stringify(p.patterns)) : 0;
        const key = JSON.stringify([pads, readout, status, lanes]);
        if (key === last) return;
        last = key;
        log.push({ t: performance.now(), pads, bar: readout == null ? null : Number(readout), status, lanes });
      };
      const obs = new MutationObserver(snap);
      for (const sel of ['.scene-pads', '.bar-readout', '.scene-status']) {
        const el = document.querySelector(sel);
        if (el) obs.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
      }
      window.__RISE_OBS__ = obs;
      snap();
    });
  const log = () => page.evaluate(() => window.__RISE_LOG__);

  return { slot, pad, stateOf, lineOf, statusText, waitLine, waitState, waitStatus, mix, sceneMix, project, barNow, nextBar, play, playing, riseOver, knobFill, tempo, busy, record, log };
}

/**
 * Read one rise of pad `i` over `n` bars out of the timeline: the bar it announced,
 * the lines in order, which bar played for most of each "Rising · k of n", where the
 * progress rule stood, and how far apart Active and the end bar's readout came.
 */
function readRise(log, i, n) {
  const lines = [];
  for (const e of log) if (lines.at(-1) !== e.pads[i].line) lines.push(e.pads[i].line);
  const q = log.findIndex((e) => /^Rise · Bar \d+$/.test(e.pads[i].line));
  const N = q >= 0 ? Number(log[q].pads[i].line.replace(/\D+/g, '')) : null;
  const pressBar = log[0]?.bar ?? null;

  // Milliseconds each (line, bar) pair was on screen.
  const shown = {};
  for (let k = 0; k + 1 < log.length; k += 1) {
    const e = log[k];
    const line = e.pads[i].line;
    shown[line] ??= {};
    shown[line][e.bar] = (shown[line][e.bar] ?? 0) + (log[k + 1].t - e.t);
  }
  const bars = [];
  for (let k = 1; k <= n; k += 1) {
    const seen = shown[`Rising · ${k} of ${n}`] ?? {};
    const [bar, ms] = Object.entries(seen).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const other = Object.values(seen).reduce((s, x) => s + x, 0) - ms;
    bars.push({ k, bar: bar === null ? null : Number(bar), want: N === null ? null : wrapBar(N + k - 1), ms: Math.round(ms), other: Math.round(other) });
  }
  const progressOk = log.every((e) => {
    const m = /^Rising · (\d+) of (\d+)$/.exec(e.pads[i].line);
    if (!m) return e.pads[i].progress === '';
    return Math.abs(Number(e.pads[i].progress) - Number(m[1]) / Number(m[2])) < 1e-6;
  });
  const a = log.findIndex((e, k) => k > q && ['active', 'modified'].includes(e.pads[i].state));
  const landBar = N === null ? null : wrapBar(N + n);
  const b = log.findIndex((e, k) => k > q && e.bar === landBar);
  const landDelta = a >= 0 && b >= 0 ? Math.round(log[a].t - log[b].t) : null;
  const statuses = [];
  for (const e of log.slice(Math.max(0, q))) if (statuses.at(-1) !== e.status) statuses.push(e.status);
  return { N, pressBar, lines, bars, progressOk, landBar, landDelta, landed: a >= 0, statuses, q, a, log };
}

const summary = (r) =>
  `N=${r.N} pressed in bar ${r.pressBar}; ${r.bars.map((x) => `${x.k}:${x.bar}/${x.want} (${x.ms}ms, other ${x.other}ms)`).join(' ')}; land ${r.landBar} Δ${r.landDelta}ms`;

/** The checks one recorded rise of `n` bars into scene `name` (pad `i`) must pass. */
function checkRise(check, tag, r, i, n, name, end = 'Active') {
  const rising = Array.from({ length: n }, (_, k) => `Rising · ${k + 1} of ${n}`);
  const from = r.lines.findIndex((l) => /^Rise · Bar/.test(l));
  const seq = from >= 0 ? r.lines.slice(from) : r.lines;
  check(`${tag}: starts on the next bar line (Rise · Bar N, pressed in bar N-1)`,
    r.N !== null && r.pressBar !== null && r.N === wrapBar(r.pressBar + 1), `pressed in ${r.pressBar}, announced ${r.N}`);
  check(`${tag}: the pad reads Rise · Bar N, Rising · 1 … ${n} of ${n}, then ${end}, nothing skipped or repeated`,
    JSON.stringify(seq) === JSON.stringify([`Rise · Bar ${r.N}`, ...rising, end]), r.lines.join(' > '));
  check(`${tag}: each Rising · k of ${n} shows while bar N+k-1 plays`,
    r.bars.every((x) => x.bar === x.want && x.other < BAR_SLACK), summary(r));
  check(`${tag}: the progress rule stands at k/${n}, and is gone otherwise`, r.progressOk);
  check(`${tag}: it lands on bar N+${n}, as the transport counts it`,
    r.landed && r.landDelta !== null && Math.abs(r.landDelta) <= LAND_SLACK, summary(r));
  check(`${tag}: the status says rises from bar N, rising, then active, once each`,
    JSON.stringify(r.statuses) === JSON.stringify([`${name} rises over ${n} bars from bar ${r.N}`, `${name} rising over ${n} bars`, `${name} active`]),
    r.statuses.join(' | '));
}

/**
 * The Rise checks. `open(width, height, extra)` returns `{ page, errors }` on a fresh
 * app; `check(name, ok, detail)` records one result.
 */
export async function riseChecks({ open, check }) {
  // ---- 2, 4 and 8 bars; cancel halfway; a knob the user moves; tempo; stopped. ----
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-slot');

      // Stopped and never played: the engine has not booted, so nothing can rise.
      await k.riseOver(4);
      const cold = await k.mix();
      await k.record();
      await k.pad(3).click();
      await page.waitForTimeout(300);
      const coldLog = await k.log();
      check('rise stopped: before the first Play a Rise says it needs playback',
        (await k.statusText()) === 'Drop can rise only during playback: press Play, or switch on Now', await k.statusText());
      check('rise stopped: and queues nothing (the pad never leaves available)',
        coldLog.every((e) => e.pads[3].state === 'available') && (await k.stateOf(3)) === 'available',
        coldLog.map((e) => e.pads[3].state).join(' > '));
      check('rise stopped: the knobs do not move', differ(cold, await k.mix()).length === 0);
      check('rise stopped: playback stays stopped', !(await k.playing()));

      await k.play();
      await k.knobFill('Cutoff', 450);

      // 2, 4 and 8 bars, each into a different scene so every press starts a rise.
      for (const [n, i, name] of [[2, 3, 'Drop'], [4, 1, 'Sparse'], [8, 0, 'Full']]) {
        await k.riseOver(n);
        await k.nextBar();
        await k.record();
        await k.pad(i).click();
        await k.waitState(i, ['active', 'modified'], { timeout: (n + 3) * 2500 });
        await page.waitForTimeout(500);
        const r = readRise(await k.log(), i, n);
        checkRise(check, `rise ${n} bars`, r, i, n, name);
        const off = differ(await k.mix(), await k.sceneMix(i));
        check(`rise ${n} bars: every knob and fader lands on ${name}`, off.length === 0, show(await k.mix(), off));
      }

      // Stopped after playing: the engine is booted but there is nothing to rise over.
      await page.getByRole('button', { name: 'Stop the track', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'no', null, RT);
      await k.record();
      await k.pad(3).click();
      await page.waitForTimeout(300);
      check('rise stopped: after Stop a Rise also says it needs playback',
        (await k.statusText()) === 'Drop can rise only during playback: press Play, or switch on Now', await k.statusText());
      check('rise stopped: and the pad stays available', (await k.log()).every((e) => e.pads[3].state === 'available'));
      await k.play();

      // Cancel halfway: 4 bars into Drop, cancelled in bar 3 (half the way risen).
      const before = await k.mix();
      await k.riseOver(4);
      await k.nextBar();
      await k.record();
      await k.pad(3).click();
      await k.waitLine(3, /^Rising · 3 of 4$/);
      await page.waitForTimeout(300);
      const halfway = await k.mix();
      const moving = differ(before, halfway);
      await k.pad(3).click();
      const cancelled = await k.waitStatus(/rise cancelled/).then(() => true, () => false);
      await page.waitForTimeout(400);
      const back = await k.mix();
      check('rise cancel: halfway, the knobs had moved toward Drop', moving.length > 0, show(halfway, moving));
      check('rise cancel: the status reads "Drop rise cancelled"', cancelled && (await k.statusText()) === 'Drop rise cancelled', await k.statusText());
      check('rise cancel: every knob and fader is back at its pre-Rise value',
        differ(before, back).length === 0, show(back, differ(before, back)) || `${moving.length} had moved`);
      check('rise cancel: no pad is left rising and no progress rule remains', (await k.busy()).length === 0, JSON.stringify(await k.busy()));
      check('rise cancel: Full, active before the rise, still is', (await k.stateOf(0)) === 'active', await k.stateOf(0));
      // The bar it would have landed on goes by, and nothing lands.
      const cLog = await k.log();
      const cN = readRise(cLog, 3, 4).N;
      await page.waitForFunction((want) => Number(document.querySelector('.bar-readout .tabular-nums')?.textContent) === want, wrapBar(cN + 4), RT);
      await page.waitForTimeout(600);
      check('rise cancel: its end bar goes by and nothing lands',
        (await k.stateOf(3)) === 'available' && differ(before, await k.mix()).length === 0 && (await k.statusText()) === 'Drop rise cancelled',
        `${await k.stateOf(3)}; ${await k.statusText()}`);

      // A knob and a fader moved mid-rise are the user's; everything else still lands.
      const drop = await k.sceneMix(3);
      const start = await k.mix();
      await k.riseOver(4);
      await k.nextBar();
      await k.record();
      await k.pad(3).click();
      await k.waitLine(3, /^Rising · 2 of 4$/);
      await k.knobFill('Cutoff', 800);
      await page.getByRole('slider', { name: 'Lead volume', exact: true }).fill('300');
      const mine = await k.mix();
      const held = [];
      while (!['active', 'modified'].includes(await k.stateOf(3))) {
        const now = await k.mix();
        held.push([now['fx.filter'], now['lead.volume']]);
        await page.waitForTimeout(150);
        if (held.length > 200) break;
      }
      await page.waitForTimeout(400);
      const landed = await k.mix();
      const touched = ['fx.filter', 'lead.volume'];
      const untouched = Object.keys(drop).filter((key) => !touched.includes(key));
      const lands = untouched.filter((key) => Math.abs(start[key] - drop[key]) > 1e-4);
      check('rise ownership: the knob and fader stay where the user put them for the rest of the rise',
        held.length > 0 && held.every(([f, v]) => Math.abs(f - mine['fx.filter']) < 1e-4 && Math.abs(v - mine['lead.volume']) < 1e-4),
        `mine ${mine['fx.filter'].toFixed(3)}/${mine['lead.volume'].toFixed(3)}; seen ${held.map(([f, v]) => `${f.toFixed(3)}/${v.toFixed(3)}`).join(' ')}`);
      check("rise ownership: and keep the user's values after it lands",
        differ(mine, landed, 1e-4, touched).length === 0, show(landed, touched));
      check('rise ownership: every untouched control still lands on Drop',
        lands.length > 0 && differ(landed, drop, 1e-4, untouched).length === 0,
        `${lands.length} were moving; off: ${show(landed, differ(landed, drop, 1e-4, untouched))}`);
      check('rise ownership: the pad reads Active · Modified', (await k.lineOf(3)) === 'Active · Modified', await k.lineOf(3));
      const own = readRise(await k.log(), 3, 4);
      check('rise ownership: the count and landing are unaffected', own.bars.every((x) => x.bar === x.want) && Math.abs(own.landDelta ?? 1e9) <= LAND_SLACK, summary(own));

      // Tempo moved twice during a 4-bar rise: it still lands on its bar line, and every
      // Rising · k still shows while its own bar plays.
      await page.getByRole('button', { name: 'Cancel scene', exact: true }).click();
      await k.waitStatus(/^Scene cleared; previous mix restored$/);
      const bpm0 = await k.project(() => window.__BCKGRND_PROJECT__().params['transport.bpm']);
      await k.riseOver(4);
      await k.nextBar();
      await k.record();
      await k.pad(3).click();
      await k.waitLine(3, /^Rising · 2 of 4$/);
      await k.tempo(140);
      const bpmUp = await k.project(() => window.__BCKGRND_PROJECT__().params['transport.bpm']);
      await k.waitLine(3, /^Rising · 3 of 4$/);
      await k.tempo(100);
      const bpmDown = await k.project(() => window.__BCKGRND_PROJECT__().params['transport.bpm']);
      await k.waitState(3, ['active', 'modified']);
      await page.waitForTimeout(500);
      const tr = readRise(await k.log(), 3, 4);
      check('rise tempo: the tempo really moved mid-rise', Math.round(bpmUp) === 140 && Math.round(bpmDown) === 100, `${bpm0} -> ${bpmUp} -> ${bpmDown}`);
      checkRise(check, 'rise tempo', tr, 3, 4, 'Drop');
      const tl = await k.mix();
      const toff = differ(tl, await k.sceneMix(3));
      check('rise tempo: every knob still lands on Drop', toff.length === 0, show(tl, toff));
      await k.tempo(bpm0);
    } catch (e) {
      check('rise: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('rise: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- A loop set while a rise waits: the engine re-announces the bar it starts on,
  // and the pad must say that bar, not the one it said first. ------------------------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-slot');
      await k.play();
      await k.knobFill('Cutoff', 450);
      await k.riseOver(2);
      await k.nextBar();
      await k.record();
      await k.pad(3).click();
      await k.waitLine(3, /^Rise · Bar \d+$/);
      const first = await k.lineOf(3);
      await page.getByRole('button', { name: 'Loop 1 bar', exact: true }).click();
      await k.waitLine(3, /^Rising · 1 of 2$/);
      // A one-bar loop holds the readout on one bar, so read it while bar 1 of 2 plays
      // (a readout tick behind the event at most) instead of timing it from the log.
      await page.waitForTimeout(400);
      const startedIn = Number(await k.barNow());
      const stillFirst = (await k.lineOf(3)) === 'Rising · 1 of 2';
      const log = await k.log();
      const announced = [...new Set(log.map((e) => e.pads[3].line))].filter((l) => /^Rise · Bar \d+$/.test(l)).at(-1);
      const said = Number(announced?.replace(/\D+/g, ''));
      check('rise loop: setting a loop while it waits moves the bar it starts on', announced !== first, `${first} -> ${announced}`);
      check('rise loop: the pad shows the bar it really starts on', stillFirst && startedIn === said, `pad said ${announced}, Rising · 1 of 2 played in bar ${startedIn}`);
      check('rise loop: and the status line names that bar too',
        log.some((e) => e.status === `Drop rises over 2 bars from bar ${said}`), [...new Set(log.map((e) => e.status))].join(' | '));
      await page.getByRole('button', { name: 'Loop 1 bar', exact: true }).click();
      const landed = await k.waitState(3, ['active', 'modified']).then(() => true, () => false);
      check('rise loop: it still lands once the loop is off', landed, await k.lineOf(3));
    } catch (e) {
      check('rise loop: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('rise loop: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- A scene with captured lanes lands them on its end bar, not before. --------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-slot');
      const editor = page.locator('#pattern-drawer');
      const cell = (step) => page.locator(`[data-drum-cell][data-lane="hat"][data-step="${step}"]`);
      const pressed = async (step) => (await cell(step).getAttribute('aria-pressed')) === 'true';
      const lanes = () => page.evaluate(() => JSON.stringify(window.__BCKGRND_PROJECT__().patterns));
      // Paint one closed-hat step, capture it into Drop, then put the working pattern back,
      // so Drop's lanes differ from what plays.
      await page.getByRole('button', { name: 'Inspect Hats' }).click();
      await page.getByRole('button', { name: 'Show the hats pattern' }).click();
      await editor.waitFor();
      const had = await pressed(1);
      await cell(1).click();
      await page.keyboard.press('Escape');
      await k.slot(3).locator('.scene-menu-button').click();
      await page.getByRole('button', { name: 'Capture current mix' }).click();
      await page.locator('[aria-controls="pattern-drawer"]').click();
      await editor.waitFor();
      await cell(1).click();
      const reverted = (await pressed(1)) === had;
      await page.keyboard.press('Escape');
      const captured = await page.evaluate(() => Boolean(window.__BCKGRND_PROJECT__().scenes.slots[3].patterns.hat));
      check('rise lanes: Drop holds a captured hat lane that differs from the working one',
        captured && reverted, `captured ${captured}, working step back ${reverted}`);

      await k.play();
      await k.knobFill('Cutoff', 450);
      await k.riseOver(2);
      await k.nextBar();
      await k.record();
      await k.pad(3).click();
      await k.waitState(3, ['active', 'modified']);
      await page.waitForTimeout(400);
      const log = await k.log();
      const r = readRise(log, 3, 2);
      const rising = log.filter((e) => e.pads[3].state !== 'active' && e.pads[3].state !== 'modified');
      const after = log.slice(r.a);
      check('rise lanes: the working lanes do not change while it rises',
        rising.length > 0 && rising.every((e) => e.lanes === log[0].lanes), [...new Set(rising.map((e) => e.lanes))].join(','));
      check('rise lanes: they change on the render where Drop turns Active, on bar N+2',
        r.a > 0 && after.every((e) => e.lanes !== log[0].lanes) && Math.abs(r.landDelta ?? 1e9) <= LAND_SLACK, summary(r));
      await page.locator('[aria-controls="pattern-drawer"]').click();
      await editor.waitFor();
      check("rise lanes: the editor shows Drop's hat step", (await pressed(1)) !== had);
      await page.keyboard.press('Escape');

      // A rise with lanes, cancelled halfway, leaves the working lanes alone.
      await page.getByRole('button', { name: 'Cancel scene', exact: true }).click();
      await k.waitStatus(/^Scene cleared; previous mix restored$/);
      const restored = await lanes();
      await k.riseOver(4);
      await k.nextBar();
      await k.record();
      await k.pad(3).click();
      await k.waitLine(3, /^Rising · 3 of 4$/);
      await k.pad(3).click();
      await k.waitStatus(/^Drop rise cancelled$/);
      const cN = readRise(await k.log(), 3, 4).N;
      await page.waitForFunction((want) => Number(document.querySelector('.bar-readout .tabular-nums')?.textContent) === want, wrapBar(cN + 4), RT);
      await page.waitForTimeout(600);
      check('rise lanes: a cancelled rise never lands its lanes, even past its end bar',
        (await lanes()) === restored && (await k.stateOf(3)) === 'available', `${await k.stateOf(3)}`);
    } catch (e) {
      check('rise lanes: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('rise lanes: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Interrupting a rise: Stop, seek, Panic, a track load. ---------------------
  // Each on a fresh page: rise 4 bars into Drop from a closed filter, interrupt it in
  // bar 2, and check the screen is left sane, then that a new rise still runs.
  const interruptions = [
    {
      name: 'Stop',
      act: (page) => page.getByRole('button', { name: 'Stop the track', exact: true }).click(),
      status: /^Drop rise cancelled: playback stopped$/,
      knobs: 'restored',
    },
    {
      name: 'seek',
      act: async (page) => {
        const wave = page.locator('.deck-wave[data-live="yes"] .deck-wave-body');
        const box = await wave.boundingBox();
        await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
      },
      status: /^Drop rise cancelled: the playhead moved$/,
      knobs: 'restored',
    },
    {
      name: 'Panic',
      act: (page) => page.getByRole('button', { name: 'Panic', exact: true }).click(),
      status: /^Panic: stopped, nothing queued, effects released$/,
      knobs: 'restored',
    },
    {
      name: 'track load',
      act: (page) => page.getByRole('button', { name: /^Tunnel,/ }).click(),
      status: /^(?![\s\S]*[Rr]is)/,
      knobs: 'track',
    },
  ];
  for (const it of interruptions) {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    const tag = `rise ${it.name}`;
    try {
      await page.waitForSelector('.scene-slot');
      await k.play();
      await k.knobFill('Cutoff', 450);
      const before = await k.mix();
      const trackBefore = await k.project(() => window.__BCKGRND_PROJECT__().trackId);
      await k.riseOver(4);
      await k.nextBar();
      await k.pad(3).click();
      await k.waitLine(3, /^Rising · 2 of 4$/);
      await page.waitForTimeout(200);
      const moved = differ(before, await k.mix());
      await k.record();
      await it.act(page);
      if (it.knobs === 'track') {
        await page.waitForFunction((was) => window.__BCKGRND_PROJECT__().trackId !== was, trackBefore, RT);
      }
      await page.waitForTimeout(1200);
      const busy = await k.busy();
      const after = await k.mix();
      check(`${tag}: no pad is left rising, queued or sending, and no progress rule remains`, busy.length === 0, JSON.stringify(busy));
      check(`${tag}: Drop did not become active`, !['active', 'modified'].includes(await k.stateOf(3)), await k.stateOf(3));
      check(`${tag}: the status line says what happened`, it.status.test((await k.statusText()) ?? ''), await k.statusText());
      if (it.knobs === 'restored') {
        check(`${tag}: the knobs are back at their pre-Rise values`,
          moved.length > 0 && differ(before, after).length === 0, show(after, differ(before, after)) || `${moved.length} had moved`);
      } else {
        // The engine restores the base on the cancel (reason 2/4) and the load resets only
        // the faders and sends, so the effects should read their pre-Rise values again.
        const fx = SCENE_PARAMS;
        check(`${tag}: the effect knobs do not keep a half-risen value`,
          moved.some((key) => fx.includes(key)) && differ(before, after, 1e-4, fx).length === 0,
          `half-risen: ${show(after, differ(before, after, 1e-4, fx))}`);
      }
      // Nothing late arrives: the screen holds still over the next second.
      const settled = await k.mix();
      await page.waitForTimeout(1000);
      check(`${tag}: nothing late moves the knobs or brings a pad back`,
        differ(settled, await k.mix()).length === 0 && (await k.busy()).length === 0);
      // And the strip still works: a 2-bar rise from here runs and lands.
      await k.play();
      await k.riseOver(2);
      await k.nextBar();
      await k.pad(3).click();
      const again = await k.waitState(3, ['active', 'modified']).then(() => true, () => false);
      check(`${tag}: afterwards a new rise runs and lands`, again, `${await k.stateOf(3)} "${await k.lineOf(3)}"`);
    } catch (e) {
      check(`${tag}: the walk-through ran to the end`, false, String(e.message).split('\n')[0]);
    }
    check(`${tag}: no page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }
}

// ---- On its own: node tools/verify-ui-rise.mjs [baseUrl] -----------------------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
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
    await riseChecks({ open, check });
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`\n${failures.length} rise check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll Rise checks passed.');
}
