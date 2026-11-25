/**
 * Night 8 fills at the host and UI level (docs/NIGHT8_PROTOCOL.md, NIGHT8_DECISIONS.md):
 * Fill at (Next bar, Phrase end with 2 · 4 · 8 · 16 bars), Fill → Drop, Rise + Fill, and
 * the preferences that remember them.
 *
 * What the screen promises: Fill at Next bar is the Night 3 fill, unchanged; a Phrase
 * end fill plays the phrase's last bar and ends on the phrase line, and a late press
 * says "Fill · Next phrase"; Fill → Drop reads Fill in · Bar N, Filling into Drop, then
 * Active on bar N, and a cancel at any stage leaves nothing half queued; a plain fill
 * still waiting is upgraded, not refused; a Rise that finishes with a fill plays it on
 * its last bar and lands on the next downbeat, with Fill and Fill → Drop disabled
 * meanwhile; the choices survive a reload; every control has a full name; and the
 * scenes toolbar adds no row as the options and the widest labels come and go.
 *
 * Fill style (Night 9): Classic by default; the choice is remembered; Fill, Fill → Drop
 * and Rise + Fill send the chosen style's index, which the engine accepts because the
 * track it was loaded with carries the four styles as its fills; a queued fill keeps
 * the style it was sent with.
 *
 * Every change of the pads, the fill buttons, the bar readout and the status line is
 * logged in the page with its time, so the checks read what the screen showed and for
 * how long, not a poll that can miss a bar.
 *
 * Run by tools/verify-ui.mjs (fillChecks), or on its own:
 *   node tools/verify-ui-fills.mjs [baseUrl]
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCENE_PARAMS = JSON.parse(readFileSync(join(root, 'contracts/scenes.json'), 'utf8')).sceneVector;

/** Long enough for an 8-bar wait at the tempo these checks use. */
const RT = { timeout: 30000 };
/** How far apart a landing and the transport's bar change may be seen (ms). */
const LAND_SLACK = 300;
/** The tempo the checks play at, so phrase waits stay short. */
const BPM = 160;

/** The bar readout wraps 16 -> 1. */
const wrapBar = (b) => ((((b - 1) % 16) + 16) % 16) + 1;

const DROP = 3;
const RISE_FILL_NAME = "Finish with Fill: the fill plays the Rise's last bar";

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
const differ = (a, b, tol = 1e-4) => Object.keys(a).filter((k) => !(Math.abs(a[k] - b[k]) <= tol));

/** The helpers one page needs. */
function kit(page) {
  const slot = (i) => page.locator('.scene-slot').nth(i);
  const pad = (i) => slot(i).locator('.scene-pad');
  const stateOf = (i) => slot(i).getAttribute('data-state');
  const lineOf = async (i) => (await slot(i).locator('.scene-line').textContent())?.trim();
  const statusText = async () => (await page.locator('.scene-status').textContent())?.trim();
  const fillBtn = page.locator('.fill-button');
  const intoBtn = page.locator('.fill-into-button');
  const text = async (loc) => (await loc.textContent())?.trim();
  const waitText = (sel, re, opts = RT) =>
    page.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s)?.textContent?.trim() ?? ''), [sel, re.source], opts);
  const waitStatus = (re, opts = RT) => waitText('.scene-status', re, opts);
  const waitLine = (i, re, opts = RT) =>
    page.waitForFunction(
      ([n, src]) => new RegExp(src).test(document.querySelectorAll('.scene-slot')[n]?.querySelector('.scene-line')?.textContent?.trim() ?? ''),
      [i, re.source],
      opts,
    );
  const waitState = (i, states, opts = RT) =>
    page.waitForFunction(([n, list]) => list.includes(document.querySelectorAll('.scene-slot')[n]?.getAttribute('data-state')), [i, [].concat(states)], opts);
  const waitFill = (state, opts = RT) =>
    page.waitForFunction((s) => document.querySelector('.fill-button')?.getAttribute('data-state') === s, state, opts);
  const barNow = async () => Number(await page.locator('.bar-readout .tabular-nums').textContent());
  const waitBar = (bar, opts = RT) =>
    page.waitForFunction((want) => Number(document.querySelector('.bar-readout .tabular-nums')?.textContent) === want, bar, opts);
  const nextBar = async () => {
    const b = await barNow();
    await page.waitForFunction((was) => Number(document.querySelector('.bar-readout .tabular-nums')?.textContent) !== was, b, RT);
  };
  const playing = async () => (await page.locator('.app').getAttribute('data-playing')) === 'yes';
  const play = async () => {
    if (await playing()) return;
    await page.getByRole('button', { name: 'Play the track', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, RT);
  };
  const knobFill = async (name, value) => {
    const slider = page.getByRole('slider', { name, exact: true });
    if ((await slider.count()) === 0) await page.locator('.inspector').getByText('Master', { exact: true }).click();
    const step = Number(await slider.getAttribute('step')) || 1;
    await slider.fill(String(Math.round(value / step) * step));
  };
  /** Tempo is linear over the control's 60-180 BPM. */
  const tempo = (bpm) => knobFill('Tempo', ((bpm - 60) / 120) * 1000);
  /** Jump to the first step of `bar` (1-16) with a tap on the live waveform. */
  const seekTo = async (bar) => {
    const wave = page.locator('.deck-wave[data-live="yes"] .deck-wave-body');
    const box = await wave.boundingBox();
    await page.mouse.click(box.x + (box.width * ((bar - 1) * 16 + 0.5)) / 256, box.y + box.height / 2);
    await waitBar(bar);
  };
  const fillAt = (at) =>
    page.getByRole('radio', { name: at === 'phrase' ? 'Fill at the phrase end' : 'Fill on the next bar', exact: true }).click();
  const phrase = (n) => page.getByRole('radio', { name: `Phrases of ${n} bars`, exact: true }).click();
  const riseOver = async (n) => {
    const rise = page.getByRole('radio', { name: 'Rise into the scene over several bars' });
    if ((await rise.getAttribute('aria-checked')) !== 'true') await rise.click();
    await page.getByRole('radio', { name: `Rise over ${n} bars` }).click();
  };
  const finishWithFill = async (on) => {
    const b = page.getByRole('switch', { name: RISE_FILL_NAME, exact: true });
    if (((await b.getAttribute('aria-checked')) === 'true') !== on) await b.click();
  };
  // Switch on is a radio group (Night 8 accessibility pass).
  const switchOn = (name) => page.getByRole('radio', { name, exact: true }).click();
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

  // The timeline: one entry per change of a pad, a fill button, the bar or the status.
  const record = () =>
    page.evaluate(() => {
      window.__FILL_OBS__?.disconnect();
      const log = (window.__FILL_LOG__ = []);
      let last = '';
      const btn = (sel) => {
        const el = document.querySelector(sel);
        // Unavailable fill buttons are aria-disabled (they keep focus), not disabled.
        return el ? { text: el.textContent.trim(), state: el.getAttribute('data-state'), disabled: el.disabled || el.getAttribute('aria-disabled') === 'true', title: el.title } : null;
      };
      const snap = () => {
        const pads = [...document.querySelectorAll('.scene-slot')].map((el) => ({
          state: el.getAttribute('data-state'),
          line: el.querySelector('.scene-line')?.textContent?.trim() ?? '',
        }));
        const readout = document.querySelector('.bar-readout .tabular-nums')?.textContent;
        const status = document.querySelector('.scene-status')?.textContent?.trim() ?? '';
        const entry = { pads, bar: readout == null ? null : Number(readout), status, fill: btn('.fill-button'), into: btn('.fill-into-button') };
        const key = JSON.stringify(entry);
        if (key === last) return;
        last = key;
        log.push({ t: performance.now(), ...entry });
      };
      const obs = new MutationObserver(snap);
      for (const sel of ['.scene-pads', '.bar-readout', '.scene-status', '.scene-toolbar']) {
        const el = document.querySelector(sel);
        if (el) obs.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
      }
      window.__FILL_OBS__ = obs;
      snap();
    });
  const log = () => page.evaluate(() => window.__FILL_LOG__);

  return {
    slot, pad, stateOf, lineOf, statusText, fillBtn, intoBtn, text, waitText, waitStatus, waitLine, waitState, waitFill,
    barNow, waitBar, nextBar, play, playing, tempo, knobFill, seekTo, fillAt, phrase, riseOver, finishWithFill, switchOn,
    mix, sceneMix, record, log,
  };
}

/** Milliseconds each bar was on screen while `pred(entry)` held, and the bar seen most. */
function barsWhile(log, pred) {
  const ms = {};
  for (let k = 0; k + 1 < log.length; k += 1) {
    if (!pred(log[k])) continue;
    ms[log[k].bar] = (ms[log[k].bar] ?? 0) + (log[k + 1].t - log[k].t);
  }
  const [bar, most] = Object.entries(ms).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const total = Object.values(ms).reduce((s, x) => s + x, 0);
  return { bar: bar === null ? null : Number(bar), most: Math.round(most), other: Math.round(total - most), ms };
}

/** The distinct values of `pick(entry)` in order. */
function seq(log, pick) {
  const out = [];
  for (const e of log) {
    const v = pick(e);
    if (out.at(-1) !== v) out.push(v);
  }
  return out;
}

/** Time from the first entry matching `a` (after `from`) to the first matching `b`. */
function gap(log, a, b, from = 0) {
  const i = log.findIndex((e, k) => k >= from && a(e));
  const j = log.findIndex((e, k) => k >= from && b(e));
  return i >= 0 && j >= 0 ? Math.round(log[i].t - log[j].t) : null;
}

const fillPlaying = (e) => e.fill?.state === 'playing';
const padActive = (i) => (e) => ['active', 'modified'].includes(e.pads[i].state);

/** Measure the scenes toolbar: its height and whether each of its two rows is one row. */
async function toolbar(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.scene-toolbar');
    // Rows are compared by their middles: the pills, the buttons and the word "bars"
    // are not all one height.
    const top = (el) => {
      const b = el.getBoundingClientRect();
      return b.top + b.height / 2;
    };
    const sameRow = (els) => {
      const tops = els.filter(Boolean).map(top);
      return tops.every((t) => Math.abs(t - tops[0]) < 3);
    };
    const row1 = [':scope > .segmented-block', ':scope > .scene-build-bars', ':scope > .scene-rise-fill', ':scope > .scene-strip-actions'].map((s) => bar.querySelector(s));
    const tools = bar.querySelector('.scene-fill-tools');
    const row2 = tools ? [...tools.children] : [];
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return Math.round(b.width);
    };
    return {
      h: Math.round(bar.getBoundingClientRect().height * 10) / 10,
      w: Math.round(bar.getBoundingClientRect().width),
      row1: sameRow(row1),
      row2: sameRow(row2),
      // Inside the build group too: Finish with Fill may not wrap under the bar count.
      build: sameRow([...(bar.querySelector('.scene-build-bars')?.children ?? [])].filter((c) => c.getClientRects().length)),
      used1: row1.filter(Boolean).reduce((s, el) => s + r(el), 0),
      used2: row2.filter((c) => c.getClientRects().length).reduce((s, el) => s + r(el), 0),
      tools: tools ? r(tools) : 0,
      scroll: document.documentElement.scrollWidth,
    };
  });
}

/**
 * The fill checks. `open(width, height, extra)` returns `{ page, errors }` on a fresh
 * app; `check(name, ok, detail)` records one result.
 */
export async function fillChecks({ open, check }) {
  // ---- Defaults, names, and stopped: nothing changed until the new options are used. --
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools');
      // Fill at is a radio group since the Night 8 accessibility pass.
      const fillAtGroup = page.getByRole('radiogroup', { name: 'Fill at' });
      check('fill names: the fill row is a group named Fill, with a Fill at radio group in it',
        (await page.getByRole('group', { name: 'Fill', exact: true }).count()) === 1 && (await fillAtGroup.count()) === 1);
      check('fill defaults: Fill at is Next bar, and no phrase picker shows',
        (await page.getByRole('radio', { name: 'Fill on the next bar', exact: true }).getAttribute('aria-checked')) === 'true'
        && (await page.getByRole('radio', { name: 'Fill at the phrase end', exact: true }).getAttribute('aria-checked')) === 'false'
        && (await page.locator('.scene-phrase-bars').count()) === 0);
      check('fill defaults: the Fill button reads Drum fill', (await k.text(k.fillBtn)) === 'Drum fill', await k.text(k.fillBtn));
      const fillName = (await k.fillBtn.getAttribute('aria-label'))?.replace(/ for one bar, from the next bar$/, '');
      check('fill names: Fill at Next bar keeps the Night 3 name', /^.+ for one bar, from the next bar$/.test((await k.fillBtn.getAttribute('aria-label')) ?? ''),
        await k.fillBtn.getAttribute('aria-label'));
      check('fill names: Fill → Drop names the fourth scene, at the next bar',
        (await k.text(k.intoBtn)) === 'Fill → Drop' && (await k.intoBtn.getAttribute('aria-label')) === 'Fill into Drop: a fill on the next bar, then Drop',
        `${await k.text(k.intoBtn)} / ${await k.intoBtn.getAttribute('aria-label')}`);
      check('fill stopped: Fill → Drop is disabled before Play, and its title says why',
        (await k.intoBtn.isDisabled()) && /play/i.test((await k.intoBtn.getAttribute('title')) ?? ''), await k.intoBtn.getAttribute('title'));
      await k.fillAt('phrase');
      check('fill names: Phrase end shows 2 · 4 · 8 · 16 bars, 4 picked',
        (await page.locator('.scene-phrase-bars').count()) === 1
        && (await page.getByRole('radio', { name: 'Phrases of 4 bars', exact: true }).getAttribute('aria-checked')) === 'true'
        && (await Promise.all([2, 8, 16].map((n) => page.getByRole('radio', { name: `Phrases of ${n} bars`, exact: true }).count()))).every((c) => c === 1));
      check('fill names: with Phrase end, Fill and Fill → Drop name the phrase',
        (await k.fillBtn.getAttribute('aria-label')) === `${fillName} for one bar, ending on the next 4-bar phrase line`
        && (await k.intoBtn.getAttribute('aria-label')) === 'Fill into Drop at the end of the 4-bar phrase',
        `${await k.fillBtn.getAttribute('aria-label')} / ${await k.intoBtn.getAttribute('aria-label')}`);
      await k.fillAt('bar');
      await k.switchOn('Rise into the scene over several bars');
      const toggle = page.getByRole('switch', { name: RISE_FILL_NAME, exact: true });
      check('rise fill: Finish with Fill shows beside the Rise bars, off', (await toggle.count()) === 1 && (await toggle.getAttribute('aria-checked')) === 'false'
        && (await page.locator('.scene-build-bars + .scene-rise-fill').count()) === 1
        && (await page.locator('.scene-build-bars .segment').count()) === 3);
      check('rise fill: Rise bars still default to 4', (await page.getByRole('radio', { name: 'Rise over 4 bars' }).getAttribute('aria-checked')) === 'true');
      check('rise fill: the pads say Rise into Drop over 4 bars, with no fill yet',
        (await k.pad(DROP).getAttribute('aria-label')) === 'Rise into Drop over 4 bars', await k.pad(DROP).getAttribute('aria-label'));
      await k.finishWithFill(true);
      check('rise fill: with Finish with Fill on, the pads say so',
        (await k.pad(DROP).getAttribute('aria-label')) === 'Rise into Drop over 4 bars, ending with a fill', await k.pad(DROP).getAttribute('aria-label'));
      await k.finishWithFill(false);
      await k.switchOn('Launch on the next bar');
      // A renamed fourth slot renames the button.
      await k.slot(DROP).locator('.scene-menu-button').click();
      await page.getByRole('button', { name: 'Rename…' }).click();
      await page.getByLabel('Scene name').fill('Peak');
      await page.getByRole('button', { name: 'Save name' }).click();
      check('fill names: Fill → Drop follows the fourth slot\'s name', (await k.text(k.intoBtn)) === 'Fill → Peak', await k.text(k.intoBtn));
      await k.slot(DROP).locator('.scene-menu-button').click();
      await page.getByRole('button', { name: 'Rename…' }).click();
      await page.getByLabel('Scene name').fill('Drop');
      await page.getByRole('button', { name: 'Save name' }).click();
    } catch (e) {
      check('fill names: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill names: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Fill at Next bar (unchanged), Phrase end at 2/4/8/16, and late presses. -------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools');
      await k.play();
      await k.tempo(BPM);

      // One press at the start of `from`, expecting the fill to play `want`.
      const onePress = async (tag, from, want, label, status) => {
        await k.seekTo(from);
        await k.record();
        await k.fillBtn.click();
        await k.waitText('.fill-button', /^Fill · /);
        const shown = await k.text(k.fillBtn);
        const said = await k.statusText();
        await k.waitFill('playing');
        await k.waitFill('idle');
        await page.waitForTimeout(300);
        const log = await k.log();
        const played = barsWhile(log, fillPlaying);
        const endDelta = gap(log, (e) => e.fill?.state === 'idle' && log.indexOf(e) > log.findIndex(fillPlaying), (e) => e.bar === wrapBar(want + 1));
        check(`${tag}: pressed in bar ${from}, the button reads "${label}"`, shown === label, shown);
        check(`${tag}: the status says "${status}"`, said === status, said);
        check(`${tag}: it plays bar ${want}`, played.bar === want && played.other < 250, JSON.stringify(played.ms));
        check(`${tag}: it ends on the line into bar ${wrapBar(want + 1)}`, endDelta !== null && Math.abs(endDelta) <= LAND_SLACK, `Δ${endDelta}ms`);
      };

      // Next bar: the Night 3 fill, words and all.
      await onePress('fill next bar', 5, 6, 'Fill · Bar 6', 'Fill queued for bar 6');
      check('fill next bar: its queued name is the Night 3 one', true);

      await k.fillAt('phrase');
      for (const [n, from, want] of [[2, 3, 4], [4, 5, 8], [8, 11, 16], [16, 13, 16]]) {
        await k.phrase(n);
        await onePress(`fill phrase ${n}`, from, want, `Fill · Bar ${want}`, `Fill queued for bar ${want}, the end of the phrase`);
      }

      // Late: pressed in the phrase's last bar, it goes to the next phrase, never refused.
      for (const [n, from, want] of [[4, 8, 12], [2, 6, 8]]) {
        await k.phrase(n);
        await onePress(`fill late ${n}`, from, want, 'Fill · Next phrase', `Fill queued for bar ${want}, the end of the next phrase`);
      }

      // The aria while queued, and a second press cancels it (the Night 3 rule).
      await k.phrase(4);
      await k.seekTo(5);
      await k.fillBtn.click();
      await k.waitText('.fill-button', /^Fill · Bar 8$/);
      check('fill phrase: the queued name says where it plays',
        / at the end of bar 8$/.test((await k.fillBtn.getAttribute('aria-label')) ?? ''), await k.fillBtn.getAttribute('aria-label'));
      await k.fillBtn.click();
      await k.waitFill('idle');
      check('fill phrase: a second press cancels it, with the Night 3 words', (await k.statusText()) === 'Fill cancelled', await k.statusText());
    } catch (e) {
      check('fill timing: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill timing: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Fill → Drop: queued, filling, active; and the upgrade from a plain Fill. -------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools');
      await k.play();
      await k.tempo(BPM);
      await k.knobFill('Cutoff', 450);
      await k.fillAt('phrase');
      await k.phrase(2);

      await k.seekTo(3);
      await k.record();
      await k.intoBtn.click();
      await k.waitLine(DROP, /^Fill in · Bar \d+$/);
      const queued = { line: await k.lineOf(DROP), button: await k.text(k.intoBtn), status: await k.statusText(),
        aria: await k.intoBtn.getAttribute('aria-label'), pad: await k.pad(DROP).getAttribute('aria-label'),
        fill: await k.text(k.fillBtn), fillOff: await k.fillBtn.isDisabled(), fillTitle: await k.fillBtn.getAttribute('title') };
      await k.waitState(DROP, ['active', 'modified']);
      await page.waitForTimeout(500);
      const log = await k.log();
      check('fill into: queued, the pad reads "Fill in · Bar 5"', queued.line === 'Fill in · Bar 5', queued.line);
      check('fill into: the button reads "Fill · Bar 4 → Drop"', queued.button === 'Fill · Bar 4 → Drop', queued.button);
      check('fill into: the status reads "Drop lands on bar 5 after a fill"', queued.status === 'Drop lands on bar 5 after a fill', queued.status);
      check('fill into: the button is named for the bar and how to cancel',
        queued.aria === 'Fill into Drop at the end of bar 4. Press again to cancel.', queued.aria);
      check('fill into: the pad is named for the cancel', queued.pad === 'Cancel Fill into Drop', queued.pad);
      check('fill into: Fill is disabled meanwhile, and says why',
        queued.fill === 'Drum fill' && queued.fillOff && queued.fillTitle === 'Fill → Drop is queued: press it again to cancel', `${queued.fill} ${queued.fillOff} ${queued.fillTitle}`);
      const lines = seq(log, (e) => e.pads[DROP].line).filter((l) => l !== '');
      check('fill into: the pad reads Fill in · Bar 5, Filling into Drop, then Active',
        JSON.stringify(lines.slice(lines.indexOf('Fill in · Bar 5'))) === JSON.stringify(['Fill in · Bar 5', 'Filling into Drop', 'Active']), lines.join(' > '));
      const filling = barsWhile(log, (e) => e.pads[DROP].line === 'Filling into Drop');
      check('fill into: Filling into Drop shows while bar 4 plays', filling.bar === 4 && filling.other < 250, JSON.stringify(filling.ms));
      const played = barsWhile(log, fillPlaying);
      check('fill into: the fill plays bar 4 (the Fill button reads Fill playing)', played.bar === 4 && played.other < 250, JSON.stringify(played.ms));
      check('fill into: meanwhile the button reads "Filling → Drop"', log.some((e) => e.into?.text === 'Filling → Drop' && e.bar === 4));
      const land = gap(log, padActive(DROP), (e) => e.bar === 5);
      check('fill into: Drop turns Active on bar 5, as the transport counts it', land !== null && Math.abs(land) <= LAND_SLACK, `Δ${land}ms`);
      const statuses = seq(log, (e) => e.status);
      check('fill into: the status says lands, filling, then active, once each',
        JSON.stringify(statuses.slice(statuses.indexOf('Drop lands on bar 5 after a fill'))) === JSON.stringify(['Drop lands on bar 5 after a fill', 'Filling into Drop', 'Drop active']),
        statuses.join(' | '));
      const off = differ(await k.mix(), await k.sceneMix(DROP));
      check("fill into: every knob and fader lands on Drop", off.length === 0, off.join(', '));
      check('fill into: afterwards Fill and Fill → Drop are free again',
        (await k.text(k.intoBtn)) === 'Fill → Drop' && !(await k.intoBtn.isDisabled()) && !(await k.fillBtn.isDisabled()));

      // Active: Cancel clears the scene as for any launch.
      await page.getByRole('button', { name: 'Cancel scene', exact: true }).click();
      await k.waitStatus(/^Scene cleared; previous mix restored$/);
      check('fill into cancel, active: Cancel clears Drop', !['active', 'modified'].includes(await k.stateOf(DROP)), await k.stateOf(DROP));

      // The upgrade: a plain Phrase end fill waiting, then Fill → Drop.
      await k.phrase(4);
      await k.seekTo(5);
      await k.record();
      await k.fillBtn.click();
      await k.waitText('.fill-button', /^Fill · Bar 8$/);
      await k.intoBtn.click();
      await k.waitLine(DROP, /^Fill in · Bar 9$/);
      const up = { fill: await k.text(k.fillBtn), off: await k.fillBtn.isDisabled(), into: await k.text(k.intoBtn), status: await k.statusText() };
      await k.waitState(DROP, ['active', 'modified']);
      await page.waitForTimeout(400);
      const ulog = await k.log();
      check('fill upgrade: Fill → Drop takes over the waiting fill',
        up.into === 'Fill · Bar 8 → Drop' && up.fill === 'Drum fill' && up.off && up.status === 'Drop lands on bar 9 after a fill', JSON.stringify(up));
      check('fill upgrade: nothing is refused along the way', !ulog.some((e) => /not started|not launched/.test(e.status)), seq(ulog, (e) => e.status).join(' | '));
      check('fill upgrade: one fill plays, in bar 8', barsWhile(ulog, fillPlaying).bar === 8, JSON.stringify(barsWhile(ulog, fillPlaying).ms));
      const uland = gap(ulog, padActive(DROP), (e) => e.bar === 9);
      check('fill upgrade: Drop lands on bar 9', uland !== null && Math.abs(uland) <= LAND_SLACK, `Δ${uland}ms`);
    } catch (e) {
      check('fill into: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill into: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Fill → Drop canceled at each stage: queued (button, pad, Cancel), filling. ----
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools');
      await k.play();
      await k.tempo(BPM);
      await k.fillAt('phrase');
      await k.phrase(2);
      const ways = [
        ['the button again', () => k.intoBtn.click(), /^Fill → Drop canceled$/],
        ['the Drop pad', () => k.pad(DROP).click(), /^Fill → Drop canceled$/],
        ['Cancel', () => page.getByRole('button', { name: 'Cancel scene', exact: true }).click(), /^Scene cleared; previous mix restored$/],
      ];
      for (const [how, act, status] of ways) {
        await k.seekTo(3);
        await k.record();
        await k.intoBtn.click();
        await k.waitLine(DROP, /^Fill in · Bar 5$/);
        await act();
        const said = await k.waitStatus(status).then(() => true, () => false);
        await k.waitBar(6);
        await page.waitForTimeout(300);
        const log = await k.log();
        const after = log.slice(log.findIndex((e) => status.test(e.status)));
        check(`fill into cancel, queued, by ${how}: the status says so`, said, await k.statusText());
        check(`fill into cancel, queued, by ${how}: the fill never plays`, !log.some(fillPlaying), seq(log, (e) => e.fill?.state).join(' > '));
        check(`fill into cancel, queued, by ${how}: Drop never lands`, !after.some(padActive(DROP)) && !['active', 'modified'].includes(await k.stateOf(DROP)),
          seq(log, (e) => e.pads[DROP].state).join(' > '));
        check(`fill into cancel, queued, by ${how}: both buttons are free again`,
          (await k.text(k.intoBtn)) === 'Fill → Drop' && (await k.text(k.fillBtn)) === 'Drum fill' && !(await k.fillBtn.isDisabled()) && !(await k.intoBtn.isDisabled()));
      }

      // Filling: the scene goes, the fill plays out its bar.
      await k.seekTo(3);
      await k.record();
      await k.intoBtn.click();
      await k.waitLine(DROP, /^Filling into Drop$/);
      await k.intoBtn.click();
      const said = await k.waitStatus(/^Drop canceled; the fill plays out its bar$/).then(() => true, () => false);
      const still = await k.fillBtn.getAttribute('data-state');
      await k.waitBar(6);
      await page.waitForTimeout(300);
      const log = await k.log();
      const played = barsWhile(log, fillPlaying);
      check('fill into cancel, filling: the status says the fill plays out its bar', said, await k.statusText());
      check('fill into cancel, filling: the fill is still playing just after', still === 'playing', still);
      check('fill into cancel, filling: it plays out bar 4 and ends on the line', played.bar === 4 && played.other < 250 && !log.slice(-1)[0].fill.state.includes('play'),
        JSON.stringify(played.ms));
      check('fill into cancel, filling: Drop never lands', !log.some(padActive(DROP)), seq(log, (e) => e.pads[DROP].state).join(' > '));
    } catch (e) {
      check('fill into cancel: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill into cancel: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Rise + Fill: the fill on the Rise's last bar, the landing, and cancel. ---------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools');
      await k.play();
      await k.tempo(BPM);
      await k.knobFill('Cutoff', 450);
      await k.riseOver(2);
      await k.finishWithFill(true);
      await k.nextBar();
      const pressed = await k.barNow();
      const N = wrapBar(pressed + 1);
      await k.record();
      await k.pad(DROP).click();
      await k.waitLine(DROP, /^Rise · Bar \d+$/);
      const waiting = { fill: await k.fillBtn.isDisabled(), fillTitle: await k.fillBtn.getAttribute('title'),
        into: await k.intoBtn.isDisabled(), intoTitle: await k.intoBtn.getAttribute('title'), status: await k.statusText() };
      // Unavailable, not gone: still in the tab order, the reason read as a description.
      const why = await page.evaluate(() => ['.fill-button', '.fill-into-button'].map((sel) => {
        const el = document.querySelector(sel);
        const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        return { native: el.disabled, aria: el.getAttribute('aria-disabled'), tab: el.tabIndex,
          described: ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' ') };
      }));
      await k.waitState(DROP, ['active', 'modified']);
      await page.waitForTimeout(500);
      const log = await k.log();
      check('rise fill: the status says it ends with a fill', waiting.status === `Drop rises over 2 bars from bar ${N}, ending with a fill`, waiting.status);
      check('rise fill: Fill is disabled meanwhile, titled "The Rise ends with a fill"', waiting.fill && waiting.fillTitle === 'The Rise ends with a fill', `${waiting.fill} ${waiting.fillTitle}`);
      check('rise fill: Fill → Drop too', waiting.into && waiting.intoTitle === 'The Rise ends with a fill', `${waiting.into} ${waiting.intoTitle}`);
      check('a11y: while the Rise ends with a fill, Fill and Fill → Drop stay focusable (aria-disabled, not disabled)',
        why.every((b) => !b.native && b.aria === 'true' && b.tab === 0), JSON.stringify(why));
      check('a11y: and each is described by its reason, "Unavailable: The Rise ends with a fill"',
        why.every((b) => b.described === 'Unavailable: The Rise ends with a fill'), why.map((b) => b.described).join(' / '));
      const lines = seq(log, (e) => e.pads[DROP].line).filter((l) => l !== '');
      check('rise fill: the pad reads Rise · Bar N, Rising · 1 of 2, Filling into Drop, then Active',
        JSON.stringify(lines.slice(lines.indexOf(`Rise · Bar ${N}`))) === JSON.stringify([`Rise · Bar ${N}`, 'Rising · 1 of 2', 'Filling into Drop', 'Active']), lines.join(' > '));
      const played = barsWhile(log, fillPlaying);
      check("rise fill: the fill plays the Rise's last bar, N+1", played.bar === wrapBar(N + 1) && played.other < 250, `N=${N}; ${JSON.stringify(played.ms)}`);
      const land = gap(log, padActive(DROP), (e) => e.bar === wrapBar(N + 2));
      check('rise fill: Drop lands on the next downbeat, N+2', land !== null && Math.abs(land) <= LAND_SLACK, `Δ${land}ms`);
      const statuses = seq(log, (e) => e.status);
      // The polite live region speaks once per state change, never per bar: four
      // changes while the bar readout moved on at least three times.
      const bars = seq(log, (e) => e.bar).length;
      check('a11y: the status line is a polite live region that changed once per state, not per bar',
        (await page.locator('.scene-status').getAttribute('role')) === 'status'
        && (await page.locator('.scene-status').getAttribute('aria-live')) === 'polite'
        && statuses.slice(statuses.indexOf(waiting.status)).length === 4 && bars >= 4,
        `${statuses.slice(statuses.indexOf(waiting.status)).length} status changes over ${bars} bar changes`);
      check('rise fill: the status says rises, rising, filling, then active',
        JSON.stringify(statuses.slice(statuses.indexOf(waiting.status))) === JSON.stringify([waiting.status, 'Drop rising over 2 bars', 'Filling into Drop', 'Drop active']),
        statuses.join(' | '));
      const disabledUntil = log.filter((e) => !padActive(DROP)(e) && log.indexOf(e) > 0 && e.fill?.state !== 'playing');
      check('rise fill: Fill stays disabled until the fill has played', disabledUntil.every((e) => e.fill.disabled), seq(disabledUntil, (e) => e.fill.disabled).join(' > '));
      check('rise fill: then Fill is free again', !(await k.fillBtn.isDisabled()) && (await k.text(k.fillBtn)) === 'Drum fill');
      const off = differ(await k.mix(), await k.sceneMix(DROP));
      check('rise fill: every knob lands on Drop', off.length === 0, off.join(', '));

      // Cancel halfway through a 4-bar Rise + Fill: both go, the knobs come back.
      await page.getByRole('button', { name: 'Cancel scene', exact: true }).click();
      await k.waitStatus(/^Scene cleared; previous mix restored$/);
      const before = await k.mix();
      await k.riseOver(4);
      await k.nextBar();
      const cN = wrapBar((await k.barNow()) + 1);
      await k.record();
      await k.pad(DROP).click();
      await k.waitLine(DROP, /^Rising · 2 of 4$/);
      await k.pad(DROP).click();
      const said = await k.waitStatus(/^Drop rise cancelled$/).then(() => true, () => false);
      await page.waitForTimeout(300);
      const free = !(await k.fillBtn.isDisabled()) && !(await k.intoBtn.isDisabled());
      await k.waitBar(wrapBar(cN + 4));
      await page.waitForTimeout(500);
      const clog = await k.log();
      check('rise fill cancel: the pad cancels the Rise', said, await k.statusText());
      check('rise fill cancel: and its fill: Fill and Fill → Drop are free at once', free);
      check('rise fill cancel: the fill never plays', !clog.some(fillPlaying), seq(clog, (e) => e.fill?.state).join(' > '));
      check('rise fill cancel: Drop never lands, and the knobs are back', !clog.some(padActive(DROP)) && differ(before, await k.mix()).length === 0,
        differ(before, await k.mix()).join(', '));
    } catch (e) {
      check('rise fill: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('rise fill: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Fill style (Night 9): Classic by default, remembered, and sent with all three. --
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      // Every message the page posts to the worklet that loads a track or asks for a fill.
      await page.addInitScript(() => {
        const sent = (window.__FILL_SENT__ = []);
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (message, ...rest) {
          if (message && typeof message === 'object' && ['track', 'mix', 'fill', 'fillInto', 'build'].includes(message.type)) {
            const { type, index, fillIndex, json } = message;
            const fills = json ? JSON.parse(json).fills : undefined;
            sent.push({ type, index, fillIndex, fills: fills?.map((f) => f.style ?? null) });
          }
          return post.call(this, message, ...rest);
        };
      });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.scene-fill-tools');
      const select = page.getByRole('combobox', { name: 'Fill style', exact: true });
      const sent = () => page.evaluate(() => window.__FILL_SENT__);
      const options = await select.locator('option').evaluateAll((os) => os.map((o) => `${o.value}:${o.textContent.trim()}`));
      check('fill style: a menu named Fill style in the scenes header (not the toolbar), the four styles, Random and Rotate',
        (await page.locator('.scenes-panel .panel-actions .fill-style-select').count()) === 1
        && (await page.locator('.scene-toolbar select').count()) === 0
        && options.join() === 'classic:Classic,simple:Simple,busy:Busy,syncopated:Syncopated,random:Random · next Syncopated,rotate:Rotate · next Classic', options.join());
      check('fill style: Classic by default, and the Fill button names it',
        (await select.inputValue()) === 'classic' && (await k.fillBtn.getAttribute('aria-label')) === 'Classic fill for one bar, from the next bar',
        `${await select.inputValue()} / ${await k.fillBtn.getAttribute('aria-label')}`);
      check('fill style: the default is not stored until it is chosen',
        await page.evaluate(() => localStorage.getItem('bckgrnd-msc:fill-style')) === null);
      // The track the UI keeps (a saved project's hashed source) still has its one fill.
      const own = await page.evaluate(async () => (await (await fetch('/library/warehouse.json')).json()).track.fills.length);
      check("fill style: the library's track keeps its one fill", own === 1, String(own));

      await select.selectOption('busy');
      check('fill style: choosing Busy is stored, and the Fill button names it',
        await page.evaluate(() => localStorage.getItem('bckgrnd-msc:fill-style')) === 'busy'
        && (await k.fillBtn.getAttribute('aria-label')) === 'Busy fill for one bar, from the next bar');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.scene-fill-tools');
      check('fill style: after a reload it is still Busy', (await select.inputValue()) === 'busy', await select.inputValue());

      await k.play();
      await k.tempo(BPM);
      // Messages queued before the first Play reach the worklet once it boots.
      const loads = (await sent()).filter((m) => m.type === 'track');
      check('fill style: the engine is loaded with the four styles as its fills',
        loads.length > 0 && loads.every((m) => m.fills?.join() === 'classic,simple,busy,syncopated'), JSON.stringify(loads.map((m) => m.fills)));
      check('fill style: with a mouse the Fill button\'s tooltip names the style',
        /^Busy fill: /.test((await k.fillBtn.getAttribute('title')) ?? ''), await k.fillBtn.getAttribute('title'));
      // Fill: index 2. Switched to Simple while it waits, it keeps Busy.
      let from = (await sent()).length;
      await k.fillBtn.click();
      await page.waitForFunction((n) => window.__FILL_SENT__.slice(n).some((m) => m.type === 'fill'), from, RT);
      await select.selectOption('simple');
      const keptAria = await k.fillBtn.getAttribute('aria-label');
      await k.waitFill('playing');
      const playingAria = await k.fillBtn.getAttribute('aria-label');
      await k.waitFill('idle');
      const fillMsg = (await sent()).slice(from).find((m) => m.type === 'fill');
      check('fill style: Fill sends Busy\'s index, 2, and the engine plays it', fillMsg?.index === 2, JSON.stringify(fillMsg));
      check('fill style: a queued fill keeps the style it was sent with',
        /Busy fill/.test(keptAria ?? '') && playingAria === 'Busy fill is playing', `${keptAria} / ${playingAria}`);
      check('fill style: once it has played, the button names the new choice',
        (await k.fillBtn.getAttribute('aria-label')) === 'Simple fill for one bar, from the next bar', await k.fillBtn.getAttribute('aria-label'));

      // Fill → Drop: index 3 (Syncopated).
      await select.selectOption('syncopated');
      from = (await sent()).length;
      await k.intoBtn.click();
      await k.waitState(DROP, ['active', 'modified']);
      const intoMsg = (await sent()).slice(from).find((m) => m.type === 'fillInto');
      check('fill style: Fill → Drop sends Syncopated\'s index, 3, and Drop lands', intoMsg?.index === 3, JSON.stringify(intoMsg));

      // Rise + Fill: index 1 (Simple), into the first scene.
      await select.selectOption('simple');
      await k.switchOn('Rise into the scene over several bars');
      await k.riseOver(2);
      await k.finishWithFill(true);
      from = (await sent()).length;
      await k.pad(0).click();
      await page.waitForFunction((n) => window.__FILL_SENT__.slice(n).some((m) => m.type === 'build'), from, RT);
      await k.waitFill('playing');
      const riseAria = await k.fillBtn.getAttribute('aria-label');
      await k.waitState(0, ['active', 'modified']);
      const buildMsg = (await sent()).slice(from).find((m) => m.type === 'build');
      check('fill style: Rise + Fill sends Simple\'s index, 1, and the fill plays the last bar',
        buildMsg?.fillIndex === 1 && riseAria === 'Simple fill is playing', `${JSON.stringify(buildMsg)} / ${riseAria}`);

      // Back to Classic: index 0, as before Night 9.
      await select.selectOption('classic');
      await k.switchOn('Launch on the next bar');
      from = (await sent()).length;
      await k.fillBtn.click();
      await k.waitFill('playing');
      await k.waitFill('idle');
      const classicMsg = (await sent()).slice(from).find((m) => m.type === 'fill');
      check('fill style: Classic sends index 0, the Night 3 fill', classicMsg?.index === 0, JSON.stringify(classicMsg));
    } catch (e) {
      check('fill style: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill style: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Random and Rotate (Night 9): resolved when queued, shown before the press, moved
  // on only when a fill plays. Observed as the index each request sends. ---------------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.addInitScript(() => {
        const sent = (window.__FILL_SENT__ = []);
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (message, ...rest) {
          if (message && typeof message === 'object' && ['fill', 'fillInto', 'build'].includes(message.type)) {
            sent.push({ type: message.type, index: message.type === 'build' ? message.fillIndex : message.index });
          }
          return post.call(this, message, ...rest);
        };
      });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.scene-fill-tools');
      const NAMES = ['Classic', 'Simple', 'Busy', 'Syncopated'];
      const select = page.getByRole('combobox', { name: 'Fill style', exact: true });
      const sent = () => page.evaluate(() => window.__FILL_SENT__);
      const menuNext = async (mode) => {
        const text = await select.locator(`option[value="${mode}"]`).textContent();
        return NAMES.indexOf(text.replace(/^.* · next /, '').trim());
      };
      // One fill on the Fill button, played through; the index it sent and the words.
      const fillOnce = async () => {
        const from = (await sent()).length;
        await k.fillBtn.click();
        await k.waitFill('playing');
        const playingText = await k.text(k.fillBtn);
        await k.waitFill('idle');
        return { index: (await sent()).slice(from).find((m) => m.type === 'fill')?.index, playingText };
      };
      await select.selectOption('rotate');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.scene-fill-tools');
      check('fill modes: Rotate is remembered across a reload, and says Classic plays next',
        (await select.inputValue()) === 'rotate' && await page.evaluate(() => localStorage.getItem('bckgrnd-msc:fill-style')) === 'rotate'
        && (await menuNext('rotate')) === 0);
      check('fill modes: at rest the Fill button names what the next press plays',
        (await k.fillBtn.getAttribute('aria-label')) === 'Classic fill, by Rotate for one bar, from the next bar', await k.fillBtn.getAttribute('aria-label'));
      await k.play();
      await k.tempo(BPM);
      const r1 = await fillOnce();
      const shown2 = await menuNext('rotate');
      const r2 = await fillOnce();
      const r3 = await fillOnce();
      check('rotate: three fills play Classic, Simple, Busy (indexes 0, 1, 2)', [r1.index, r2.index, r3.index].join() === '0,1,2' && shown2 === 1,
        `${r1.index},${r2.index},${r3.index}; shown next ${shown2}`);
      check('rotate: the playing words name the style ("Fill playing", "Simple playing", "Busy playing")',
        [r1.playingText, r2.playingText, r3.playingText].join() === 'Fill playing,Simple playing,Busy playing', [r1.playingText, r2.playingText, r3.playingText].join());
      check('rotate: the menu then says Syncopated is next, and so does the Fill button',
        (await menuNext('rotate')) === 3 && /^Syncopated fill, by Rotate /.test((await k.fillBtn.getAttribute('aria-label')) ?? ''));

      // A canceled Rotate fill: it sent Syncopated, and the next press sends Syncopated again.
      await k.fillAt('phrase');
      await k.phrase(4);
      let from = (await sent()).length;
      await k.fillBtn.click();
      await k.waitText('.fill-button', /^Synco · /);
      const queuedText = await k.text(k.fillBtn);
      await k.fillBtn.click();
      await page.waitForFunction(() => document.querySelector('.fill-button')?.textContent?.trim() === 'Drum fill', null, RT);
      await page.waitForTimeout(300);
      const canceledIndex = (await sent()).slice(from).find((m) => m.type === 'fill')?.index;
      check('rotate: a canceled fill does not move on: the menu still says Syncopated',
        canceledIndex === 3 && /^Synco · (Bar \d+|Next phrase)$/.test(queuedText ?? '') && (await menuNext('rotate')) === 3,
        `sent ${canceledIndex}, read ${queuedText}, next ${await menuNext('rotate')}`);
      await k.fillAt('bar');
      const r4 = await fillOnce();
      check('rotate: the next press plays Syncopated (3), then Classic is next', r4.index === 3 && (await menuNext('rotate')) === 0, `${r4.index}`);

      // Fill → Drop and Rise + Fill resolve too, in Rotate and in Random.
      from = (await sent()).length;
      await k.intoBtn.click();
      await k.waitState(DROP, ['active', 'modified']);
      const intoRot = (await sent()).slice(from).find((m) => m.type === 'fillInto')?.index;
      await select.selectOption('random');
      const randomNext = await menuNext('random');
      await k.switchOn('Rise into the scene over several bars');
      await k.riseOver(2);
      await k.finishWithFill(true);
      from = (await sent()).length;
      await k.pad(0).click();
      await k.waitState(0, ['active', 'modified']);
      const riseRand = (await sent()).slice(from).find((m) => m.type === 'build')?.index;
      const randomNext2 = await menuNext('random');
      await k.switchOn('Launch on the next bar');
      from = (await sent()).length;
      await k.intoBtn.click();
      await k.waitState(DROP, ['active', 'modified']);
      const intoRand = (await sent()).slice(from).find((m) => m.type === 'fillInto')?.index;
      check('modes: Fill → Drop in Rotate plays the shown Classic (0)', intoRot === 0, String(intoRot));
      check('modes: Rise + Fill in Random plays the style the menu showed', riseRand === randomNext, `${riseRand} vs ${randomNext}`);
      check('modes: Fill → Drop in Random plays the next shown, never the one just played',
        intoRand === randomNext2 && intoRand !== riseRand, `${intoRand} vs ${randomNext2}, after ${riseRand}`);
      await select.selectOption('rotate');
      await k.switchOn('Rise into the scene over several bars');
      from = (await sent()).length;
      await k.pad(1).click();
      await k.waitState(1, ['active', 'modified']);
      const riseRot = (await sent()).slice(from).find((m) => m.type === 'build')?.index;
      check('modes: Rise + Fill in Rotate plays Simple (1), the next after Classic', riseRot === 1, String(riseRot));
      await k.switchOn('Launch on the next bar');

      // A loop: Phrase end at 2 bars inside a 2-bar loop puts the fill on the loop's last
      // bar, at the wrap. One press, one style, and the cursor moves on exactly once.
      await page.getByRole('button', { name: 'Loop 2 bars', exact: true }).click();
      await k.fillAt('phrase');
      await k.phrase(2);
      const before = await menuNext('rotate');
      from = (await sent()).length;
      await k.fillBtn.click();
      await k.waitFill('playing');
      await k.waitFill('idle');
      // Two more passes of the loop: the fill doesn't come round again, nothing moves.
      await k.nextBar();
      await k.nextBar();
      await k.nextBar();
      const loopSent = (await sent()).slice(from).filter((m) => m.type === 'fill');
      const after = await menuNext('rotate');
      check('loop: one press sends one fill, Busy (2), at the loop wrap', loopSent.length === 1 && loopSent[0].index === 2 && before === 2,
        `${JSON.stringify(loopSent)}, shown ${before}`);
      check('loop: the cursor moved on exactly once (Syncopated next) over three more bars', after === 3, String(after));
      check('loop: the Fill button is free again, not replaying', (await k.fillBtn.getAttribute('data-state')) === 'idle');
      await page.getByRole('button', { name: 'Loop 2 bars', exact: true }).click();
    } catch (e) {
      check('fill modes: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill modes: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Preferences survive a reload. -------------------------------------------------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools');
      await k.fillAt('phrase');
      await k.phrase(8);
      await k.riseOver(2);
      await k.finishWithFill(true);
      const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((x) => x.startsWith('bckgrnd-msc:')).map((x) => [x, localStorage.getItem(x)])));
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.scene-fill-tools');
      // The pickers are radios and Finish with Fill a switch: both say aria-checked.
      const pressedName = (name) => page.getByRole(name === RISE_FILL_NAME ? 'switch' : 'radio', { name, exact: true }).getAttribute('aria-checked');
      check('fill prefs: stored under bckgrnd-msc: keys',
        stored['bckgrnd-msc:fill-at'] === 'phrase' && stored['bckgrnd-msc:fill-phrase-bars'] === '8'
        && stored['bckgrnd-msc:rise-bars'] === '2' && stored['bckgrnd-msc:rise-fill'] === 'on', JSON.stringify(stored));
      check('fill prefs: after a reload Fill at is still Phrase end, 8 bars',
        (await pressedName('Fill at the phrase end')) === 'true' && (await pressedName('Phrases of 8 bars')) === 'true');
      check('fill prefs: Switch on itself is not remembered (Rise is off)', (await page.locator('.scene-build-bars').count()) === 0);
      await k.switchOn('Rise into the scene over several bars');
      check('fill prefs: choosing Rise brings back 2 bars and Finish with Fill on',
        (await pressedName('Rise over 2 bars')) === 'true' && (await pressedName(RISE_FILL_NAME)) === 'true');
      check('fill prefs: the Fill button reads the remembered phrase', / 8-bar phrase line$/.test((await k.fillBtn.getAttribute('aria-label')) ?? ''));
    } catch (e) {
      check('fill prefs: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill prefs: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- The toolbar with a mouse at 1440, 1280 and 1180 (and the other compact widths
  // Lacey's checks use): no row added, and two rows of one 32px control (Switch on;
  // Fill), 70px, with Compare A/B folded into the header (Night 9B, the default). Unfolded,
  // Compare adds exactly its own row: 108px. One row can't hold the scene and
  // fill controls: squeezed as far as they go they need about 950px, and the panel is
  // 798px wide at 1440. At 375 and 320 (touch) the toolbar stacks a row per control by
  // design, so there it is measured, and held to 44px targets, labels that are never
  // cut short, and no sideways scroll. -------------------------------------------
  const MOUSE_TOOLBAR_MAX = 70.5;
  const MOUSE_TOOLBAR_COMPARING = 108.5;
  const widths = [[1440, 900], [1280, 800], [1279, 800], [1200, 800], [1180, 800], [1100, 800], [1024, 768], [960, 800], [900, 800],
    [375, 812, { hasTouch: true, isMobile: true }], [320, 640, { hasTouch: true, isMobile: true }]];
  for (const [w, h, extra] of widths) {
    const { page, errors } = await open(w, h, extra ?? {});
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools', { state: 'attached' });
      const base = await toolbar(page);
      await k.switchOn('Rise into the scene over several bars');
      const rise = await toolbar(page);
      await k.finishWithFill(true);
      const riseFill = await toolbar(page);
      await k.fillAt('phrase');
      const phrase = await toolbar(page);
      await k.phrase(16);
      // The widest words the two buttons show together. They never both wait: while a
      // Fill → Drop waits, Fill reads Drum fill (or Fill playing once its fill plays).
      const widest = await page.evaluate(() => {
        const bar = document.querySelector('.scene-toolbar');
        const fill = document.querySelector('.fill-button');
        const into = document.querySelector('.fill-into-button');
        const was = [fill.textContent, into.textContent];
        const out = { h: 0, cut: false, each: [], lines: 1, cutWords: [] };
        // Lines of text a button shows: its text's line boxes, by their tops.
        const linesOf = (el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size;
        };
        // Night 9: a style other than Classic names itself in place of the word Fill.
        for (const [a, b] of [['Fill · Next phrase', 'Fill → Drop'], ['Drum fill', 'Fill · Next phrase → Drop'], ['Drum fill', 'Fill · Bar 16 → Drop'], ['Fill playing', 'Filling → Drop'],
          ['Simple · Next phrase', 'Fill → Drop'], ['Synco · Next phrase', 'Fill → Drop'], ['Simple · Bar 16', 'Fill → Drop'], ['Simple playing', 'Filling → Drop']]) {
          fill.textContent = a;
          into.textContent = b;
          const h = Math.round(bar.getBoundingClientRect().height * 10) / 10;
          out.each.push(h);
          out.h = Math.max(out.h, h);
          for (const el of [fill, into]) {
            const cut = el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > bar.getBoundingClientRect().right + 0.5;
            if (cut) out.cutWords.push(el.textContent);
            out.cut ||= cut;
            out.lines = Math.max(out.lines, linesOf(el));
          }
        }
        [fill.textContent, into.textContent] = was;
        return out;
      });
      const all = { base, rise, riseFill, phrase };
      console.log(`      toolbar ${w}px: ${Object.entries(all).map(([n, m]) => `${n} ${m.h}px (row 1 ${m.used1}px, row 2 ${m.used2}px of ${m.w}px)`).join('; ')}; widest labels ${widest.h}px${widest.cut ? ', Fill → Drop ellipsized' : ''}`);
      if (w >= 900) {
        check(`${w}px: Switch on, Rise bars, Finish with Fill and Cancel share one row`,
          Object.values(all).every((m) => m.row1 && m.build), Object.entries(all).map(([n, m]) => `${n} ${m.row1}/${m.build}`).join(', '));
        check(`${w}px: Fill at, the phrase bars, Fill and Fill → Drop share one row`,
          Object.values(all).every((m) => m.row2), Object.entries(all).map(([n, m]) => `${n} ${m.row2}`).join(', '));
      }
      if (w >= 900) {
        check(`${w}px: Rise, Finish with Fill, Phrase end and the widest labels add no row to the toolbar`,
          [rise.h, riseFill.h, phrase.h, widest.h].every((x) => x === base.h), `${base.h} / ${rise.h} / ${riseFill.h} / ${phrase.h} / ${widest.each.join(',')}px`);
        check(`${w}px: with Compare folded the toolbar is two rows of 32px (${MOUSE_TOOLBAR_MAX}px), every option on`,
          [base.h, phrase.h, widest.h].every((x) => x <= MOUSE_TOOLBAR_MAX), `${base.h} / ${phrase.h} / ${widest.h}px`);
      }
      // Unfold Compare A/B from the header: one row more, never two.
      await page.getByRole('button', { name: 'Compare A/B' }).click();
      const comparing = await toolbar(page);
      if (w >= 900) {
        check(`${w}px: Compare A/B unfolded adds its one row (${MOUSE_TOOLBAR_COMPARING}px at most)`,
          comparing.h <= MOUSE_TOOLBAR_COMPARING && comparing.h > phrase.h, `${phrase.h} -> ${comparing.h}px`);
      }
      check(`${w}px: the fill buttons' widest words are not cut short`, !widest.cut, widest.cutWords.join(', '));
      if (w >= 375) {
        check(`${w}px: and each stays on one line`, widest.lines === 1, `${widest.lines} lines`);
      } else {
        check(`${w}px: and the longest wraps to two lines at most`, widest.lines <= 2, `${widest.lines} lines`);
      }
      const menu = await page.evaluate(() => {
        const b = document.querySelector('.fill-style-select')?.getBoundingClientRect();
        return b ? { h: Math.round(b.height), w: Math.round(b.width), right: Math.round(b.right) } : null;
      });
      check(`${w}px: the Fill style menu is on screen, ${extra?.hasTouch ? '44' : '24'}px tall or more`,
        menu !== null && menu.h >= (extra?.hasTouch ? 44 : 24) && menu.right <= w, JSON.stringify(menu));
      check(`${w}px: the page doesn't scroll sideways`, Object.values(all).every((m) => m.scroll <= w), Object.values(all).map((m) => m.scroll).join(','));
      if (extra?.hasTouch) {
        const small = await page.evaluate(() => [...document.querySelectorAll('.scene-toolbar button, .scenes-panel .panel-head button, .scenes-panel .panel-head select')]
          .filter((b) => b.getClientRects().length && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().width < 44))
          .map((b) => `${b.getAttribute('aria-label') ?? b.textContent.trim()} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`));
        check(`${w}px touch: every scenes toolbar and header control is at least 44 x 44px, Compare unfolded`, small.length === 0, small.join(', '));
      }
      if (w === 375) {
        const shared = await page.evaluate(() => {
          const mid = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return b.top + b.height / 2; };
          return Math.abs(mid('.scene-toolbar > .scene-build-bars') - mid('.scene-toolbar > .scene-rise-fill')) < 3;
        });
        check(`${w}px: Rise's bars and Finish with Fill share one row`, shared);
        // One stacked row is a 44px control and a 12px gap.
        check(`${w}px: Rise adds one row and Phrase end one more`, rise.h - base.h <= 57 && phrase.h - riseFill.h <= 57 && riseFill.h === rise.h,
          `${base.h} > ${rise.h} > ${riseFill.h} > ${phrase.h}px`);
      }
    } catch (e) {
      check(`${w}px toolbar: the walk-through ran to the end`, false, String(e.message).split('\n')[0]);
    }
    check(`${w}px toolbar: no page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- The crash mark at every pad size: a bolt and the word, never color alone, with
  // air between the bolt, the word, the dot and the summary (Outfit's narrow word space
  // once made it read "Crash·Kick"), and never cut short itself. ---------------------
  for (const [w, h, extra] of [[1440, 900], [1280, 800], [1180, 800], [1024, 768],
    [375, 812, { hasTouch: true, isMobile: true }], [320, 640, { hasTouch: true, isMobile: true }]]) {
    const { page, errors } = await open(w, h, extra ?? {});
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-pads');
      for (const i of [0, DROP]) {
        await k.slot(i).locator('.scene-menu-button').click();
        await page.getByRole('checkbox', { name: 'Crash on launch', exact: true }).check();
        await page.keyboard.press('Escape');
      }
      const marks = await page.evaluate(() => [...document.querySelectorAll('.scene-summary')].filter((s) => s.querySelector('.scene-crash-mark')).map((s) => {
        const mark = s.querySelector('.scene-crash-mark');
        const svg = mark.querySelector('svg').getBoundingClientRect();
        const word = document.createRange();
        word.selectNodeContents([...mark.childNodes].find((n) => n.nodeType === 3));
        const wordBox = word.getBoundingClientRect();
        const sep = s.querySelector('.scene-crash-sep').getBoundingClientRect();
        const rest = document.createRange();
        rest.selectNodeContents(s.lastChild);
        const restBox = rest.getClientRects()[0];
        const box = s.getBoundingClientRect();
        const m = mark.getBoundingClientRect();
        return {
          text: mark.textContent,
          inside: m.left >= box.left - 0.5 && m.right <= box.right + 0.5,
          icon: Math.round(svg.width),
          iconGap: Math.round((wordBox.left - svg.right) * 10) / 10,
          sepBefore: Math.round((sep.left - m.right) * 10) / 10,
          // The summary after the dot may be cut short on a small pad; only measured when shown.
          sepAfter: restBox && restBox.left < box.right ? Math.round((restBox.left - sep.right) * 10) / 10 : null,
          pad: Math.round(s.closest('.scene-pad').getBoundingClientRect().width),
        };
      }));
      const detail = marks.map((m) => `pad ${m.pad}px: icon ${m.icon}, gaps ${m.iconGap}/${m.sepBefore}/${m.sepAfter ?? '-'}`).join('; ');
      check(`${w}px crash mark: two pads show it, as a bolt and the words "Crash on launch"`,
        marks.length === 2 && marks.every((m) => m.text === 'Crash on launch' && m.icon >= 10), detail);
      check(`${w}px crash mark: never cut short itself`, marks.every((m) => m.inside), detail);
      check(`${w}px crash mark: at least 3px from bolt to word, and 4px either side of the dot`,
        marks.every((m) => m.iconGap >= 3 && m.sepBefore >= 4 && (m.sepAfter === null || m.sepAfter >= 4)), detail);
    } catch (e) {
      check(`${w}px crash mark: the walk-through ran to the end`, false, String(e.message).split('\n')[0]);
    }
    check(`${w}px crash mark: no page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Accessibility: roles, keyboard, focus and reasons for the Night 8 controls. ----
  {
    const { page, errors } = await open(1440, 900);
    const k = kit(page);
    try {
      await page.waitForSelector('.scene-fill-tools');
      await k.switchOn('Rise into the scene over several bars');
      await k.fillAt('phrase');
      for (const [name, n, picked] of [['Switch on', 4, 'Rise into the scene over several bars'], ['Rise over', 3, 'Rise over 4 bars'],
        ['Fill at', 2, 'Fill at the phrase end'], ['Phrase length', 4, 'Phrases of 4 bars']]) {
        const group = page.getByRole('radiogroup', { name, exact: true });
        const radios = group.getByRole('radio');
        const st = await radios.evaluateAll((els) => els.map((e) => ({ name: e.getAttribute('aria-label'), on: e.getAttribute('aria-checked'), tab: e.tabIndex })));
        const on = st.filter((r) => r.on === 'true');
        const stops = st.filter((r) => r.tab === 0);
        check(`a11y: ${name} is a radio group of ${n}, one checked, and one tab stop on it`,
          (await group.count()) === 1 && st.length === n && on.length === 1 && on[0].name === picked && stops.length === 1 && stops[0].name === picked,
          JSON.stringify(st));
      }
      // Arrow keys move and pick, wrapping; Home and End go to the ends.
      await page.getByRole('radio', { name: 'Phrases of 4 bars', exact: true }).focus();
      const focused = () => page.evaluate(() => [document.activeElement?.getAttribute('aria-label'), document.activeElement?.getAttribute('aria-checked')].join(':'));
      const walk = [];
      for (const key of ['ArrowRight', 'End', 'ArrowRight', 'ArrowLeft', 'Home']) {
        await page.keyboard.press(key);
        walk.push(await focused());
      }
      check('a11y: in a radio group, arrows move and pick (wrapping), Home and End go to the ends',
        JSON.stringify(walk) === JSON.stringify(['Phrases of 8 bars:true', 'Phrases of 16 bars:true', 'Phrases of 2 bars:true', 'Phrases of 16 bars:true', 'Phrases of 2 bars:true']),
        walk.join(' > '));
      const ring = await page.evaluate(() => {
        const cs = getComputedStyle(document.activeElement);
        return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor };
      });
      check('a11y: a radio reached by keyboard shows the 2px focus ring', ring.style === 'solid' && ring.width >= 2, JSON.stringify(ring));
      const toggle = page.getByRole('switch', { name: RISE_FILL_NAME, exact: true });
      const before = await toggle.getAttribute('aria-checked');
      await toggle.click();
      check('a11y: Finish with Fill is a switch whose aria-checked follows it', before === 'false' && (await toggle.getAttribute('aria-checked')) === 'true');
      // Before Play the fill buttons can't be pressed: they say why and keep focus.
      const why = await page.evaluate(() => ['.fill-button', '.fill-into-button'].map((sel) => {
        const el = document.querySelector(sel);
        const id = el.getAttribute('aria-describedby');
        return { native: el.disabled, aria: el.getAttribute('aria-disabled'), tab: el.tabIndex, title: el.title,
          described: id ? document.getElementById(id)?.textContent?.trim() : null };
      }));
      check('a11y: before Play, Fill and Fill → Drop are aria-disabled, focusable, and described by their reason',
        why.every((b) => !b.native && b.aria === 'true' && b.tab === 0 && b.described === `Unavailable: ${b.title}`), JSON.stringify(why));
      // Pressing them starts nothing, but says why in the status line (Night 9B): a touch
      // user gets no tooltip, so that line is where the reason shows.
      const was = { fill: await k.fillBtn.getAttribute('data-state') };
      await k.fillBtn.click({ force: true });
      await page.waitForTimeout(100);
      const fillWhy = await k.statusText();
      await k.intoBtn.click({ force: true });
      await page.waitForTimeout(200);
      const intoWhy = await k.statusText();
      check('a11y: and pressing them starts nothing', (await k.fillBtn.getAttribute('data-state')) === was.fill
        && (await k.intoBtn.getAttribute('data-state')) === 'idle');
      check('a11y: but each press shows its reason in the status line',
        fillWhy === `Fill: ${why[0].title}` && intoWhy?.endsWith(`: ${why[1].title}`) && intoWhy.startsWith('Fill → '), `${fillWhy} / ${intoWhy}`);
      // The notice goes at the first real status change, and stays gone when the status
      // comes back to the line it was shown over (CodeRabbit, PR #12).
      await k.pad(1).click();
      await page.waitForTimeout(150);
      const over = await k.statusText();
      await k.fillBtn.click({ force: true });
      await page.waitForTimeout(100);
      const shown = await k.statusText();
      await k.pad(2).click();
      await page.waitForTimeout(150);
      const moved = await k.statusText();
      await k.pad(1).click();
      await page.waitForTimeout(150);
      const back = await k.statusText();
      check('a11y: a reason notice does not come back when the status returns to its line',
        shown.startsWith('Fill: ') && moved !== shown && back === over, `${over} / ${shown} / ${moved} / ${back}`);
      // Crash on launch: a real checkbox in the pad's menu, with a visible focus ring.
      await k.slot(DROP).locator('.scene-menu-button').click();
      const box = page.getByRole('checkbox', { name: 'Crash on launch', exact: true });
      for (let i = 0; i < 8 && !(await box.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
      const boxRing = await box.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { focused: el === document.activeElement, style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
      });
      check('a11y: Crash on launch is a checkbox reached by Tab, with the focus ring', boxRing.focused && boxRing.style === 'solid' && boxRing.width >= 2,
        JSON.stringify(boxRing));
    } catch (e) {
      check('a11y: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('a11y: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }
}

// ---- On its own: node tools/verify-ui-fills.mjs [baseUrl] ----------------------
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
    await fillChecks({ open, check });
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`\n${failures.length} fill check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll fill checks passed.');
}
