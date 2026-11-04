/**
 * The pattern editor in a real browser, against the real engine (Night 4).
 *
 * Walks the Night 4 demonstration and acceptance tests: edit bar 9 while an earlier
 * bar plays (the playhead never jumps; the change is queued, then in the music), one
 * gesture is one undo step, clear and undo restore exactly, duplicate to the next
 * bar, edit a bass note, preview a variation, revert it with a fader moved during
 * the preview (the fader stays), keep it and undo the keep, the same seed gives the
 * same candidate, a locked lane cannot be varied, a scene carries its lanes, a fill
 * plays over edited drums, the editor's keys are its own, a new track withdraws
 * pending edits, the project round-trips through the contract reader, and the phone
 * shows eight real steps at a time.
 *
 * Usage: node tools/verify-editor.mjs [baseUrl]
 * Set PLAYWRIGHT_CHROMIUM to a Chromium binary if Playwright's own is not installed.
 */

import { build } from 'esbuild';
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8080';
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)
    ? process.env.PLAYWRIGHT_CHROMIUM
    : undefined;

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// The contract reader, to round-trip the live project the way a reload will.
const bundled = await build({
  entryPoints: [join(root, 'frontend/lib/contract.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const contract = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const library = JSON.parse(readFileSync(join(root, 'public/library/index.json'), 'utf8'));
const lookup = (id) => library.tracks.find((t) => t.id === id);

const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

async function open(width, height, extra = {}) {
  const page = await browser.newPage({ viewport: { width, height }, ...extra });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('article.stem');
  return { page, errors };
}

const T = { timeout: 10000 };

try {
  const { page, errors } = await open(1440, 1000);
  const editor = page.locator('#pattern-drawer');
  const cell = (lane, step) => page.locator(`[data-drum-cell][data-lane="${lane}"][data-step="${step}"]`);
  const pressed = async (lane, step) => (await cell(lane, step).getAttribute('aria-pressed')) === 'true';
  const onSteps = (lane) =>
    page.evaluate(
      (l) =>
        [...document.querySelectorAll(`[data-drum-cell][data-lane="${l}"]`)]
          .filter((e) => e.getAttribute('aria-pressed') === 'true')
          .map((e) => Number(e.dataset.step)),
      lane,
    );
  const grid = () =>
    page.evaluate(() => [...document.querySelectorAll('[data-drum-cell]')].map((e) => e.getAttribute('aria-label')));
  const editingLine = async () => (await page.getByTestId('editing-line').textContent())?.trim();
  const playingLine = async () => (await page.getByTestId('playing-line').textContent())?.trim();
  const changeState = () => page.getByTestId('change-line').getAttribute('data-state');
  const undo = editor.locator('.editor-actions').getByRole('button', { name: /^Undo/ });
  const redo = editor.locator('.editor-actions').getByRole('button', { name: /^Redo/ });
  const undoLabel = () => undo.getAttribute('aria-label');
  const barButton = (n) => editor.locator('.bar-button').nth(n - 1);
  const playingBar = async () => {
    const m = /^Bar (\d+)/.exec((await playingLine()) ?? '');
    return m ? Number(m[1]) : 0;
  };
  const drag = async (from, to, steps = 6) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
    await page.mouse.up();
  };
  // Every change state the header passes through.
  const watchChange = async () => {
    await page.evaluate(() => {
      window.__CHANGES__ = [];
      const el = document.querySelector('[data-testid="change-line"]');
      const record = () => {
        const t = `${el.getAttribute('data-state')}|${el.textContent}`;
        if (window.__CHANGES__.at(-1) !== t) window.__CHANGES__.push(t);
      };
      record();
      window.__CHANGE_OBS__?.disconnect();
      window.__CHANGE_OBS__ = new MutationObserver(record);
      window.__CHANGE_OBS__.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
    });
  };
  const changes = () => page.evaluate(() => window.__CHANGES__);

  // ---- Opening and the stopped edit ----------------------------------------------
  await page.getByRole('button', { name: 'Inspect Hats' }).click();
  await page.getByRole('button', { name: 'Show the hats pattern' }).click();
  await editor.waitFor();
  check('editor: four drum lanes of sixteen steps', (await page.locator('[data-drum-cell]').count()) === 64);
  check('editor: steps grouped in beats of four', (await page.locator('.drum-row').first().locator('.step-group').count()) === 4);
  check('editor: says what is edited and what is playing',
    (await editingLine()) === 'Closed hat · Bar 1 · Intro' && (await playingLine()) === 'Stopped', `${await editingLine()} / ${await playingLine()}`);
  check('editor: nothing to undo yet', await undo.isDisabled());

  const wasOn = await pressed('hat', 1);
  await cell('hat', 1).click();
  check('stopped: a click paints at once', (await pressed('hat', 1)) !== wasOn);
  check('stopped: the change is in the music (nothing to wait for)', (await changeState()) === 'audible', await changeState());
  check('stopped: one click is one undo step', /^Undo (Paint|Erase) closed hat$/.test((await undoLabel()) ?? ''), await undoLabel());
  await undo.click();
  check('stopped: undo puts it back', (await pressed('hat', 1)) === wasOn);
  await redo.click();
  check('stopped: redo applies it again', (await pressed('hat', 1)) !== wasOn);
  await undo.click();

  // ---- Edit bar 9 while an earlier bar plays ------------------------------------
  await page.getByRole('button', { name: 'Play the track' }).click();
  await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, T);
  check('boot: an edit made before the first Play is in the music, not refused',
    (await changeState()) === 'audible', await changeState());
  // The stopped edit pinned the view; Follow Playback brings it back to the playhead.
  await editor.getByRole('button', { name: 'Follow playback' }).click();
  await page.waitForFunction(() => /^Bar [2-9]/.test(document.querySelector('[data-testid="playing-line"]')?.textContent ?? ''), null, T);
  check('follow: the editor follows the playing bar',
    (await editingLine())?.split(' · ')[1] === (await playingLine())?.split(' · ')[0], `${await editingLine()} / ${await playingLine()}`);
  await barButton(9).click();
  check('follow: picking a bar turns Follow Playback off',
    (await editor.getByRole('button', { name: 'Follow playback' }).getAttribute('aria-pressed')) === 'false');
  check('editing: Bar 9 · Break while an earlier bar plays',
    (await editingLine()) === 'Closed hat · Bar 9 · Break' && (await playingBar()) < 9, `${await editingLine()} / ${await playingLine()}`);

  const before9 = await onSteps('hat');
  const empty = [129, 130, 131].filter((s) => !before9.includes(s));
  await watchChange();
  const barAtEdit = await playingBar();
  await drag(cell('hat', 129), cell('hat', 131));
  const after9 = await onSteps('hat');
  check('paint: a drag along a row paints every step it crosses', [129, 130, 131].every((s) => after9.includes(s)), JSON.stringify(after9));
  await page.waitForFunction(() => document.querySelector('[data-testid="change-line"]')?.getAttribute('data-state') === 'audible', null, T);
  const seen = await changes();
  check('change: queued for the next bar, then in the music',
    seen.some((t) => /^queued\|Queued for bar \d+$/.test(t)) && seen.at(-1).startsWith('audible'), seen.join(' → '));
  const queuedFor = Number(/Queued for bar (\d+)/.exec(seen.join(' '))?.[1]);
  check('change: queued for the bar after the one playing', queuedFor === barAtEdit + 1 || queuedFor === barAtEdit + 2, `edit in bar ${barAtEdit}, queued for ${queuedFor}`);
  const nowBar = await playingBar();
  check('playhead: never jumps to the edited bar', nowBar >= barAtEdit && nowBar < 9, `was ${barAtEdit}, now ${nowBar}`);
  check('paint: the drag is one undo step', (await undoLabel()) === 'Undo Paint closed hat');
  await undo.click();
  const undone = await onSteps('hat');
  check('paint: one undo removes the whole row it painted', isDeepStrictEqual(undone, before9), `${empty.length} painted`);
  await redo.click();

  // ---- Velocity: one drag, one undo; lowering never deletes ----------------------
  const vbar = editor.locator('.velocity-bar').first();
  const v0 = Number(await vbar.getAttribute('aria-valuenow'));
  const vb = await vbar.boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height - 4);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height - 30, { steps: 8 });
  await page.mouse.up();
  const v1 = Number(await vbar.getAttribute('aria-valuenow'));
  check('velocity: a drag changes the level', v1 !== v0, `${v0} → ${v1}`);
  check('velocity: the drag is one undo step', (await undoLabel()) === 'Undo Velocity closed hat', await undoLabel());
  await undo.click();
  check('velocity: one undo returns the exact level', Number(await vbar.getAttribute('aria-valuenow')) === v0);
  const hitsBefore = (await onSteps('hat')).length;
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height - 4);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height + 300, { steps: 8 });
  await page.mouse.up();
  check('velocity: dragged to the floor, the hit stays',
    Number(await vbar.getAttribute('aria-valuenow')) === 2 && (await onSteps('hat')).length === hitsBefore, await vbar.getAttribute('aria-valuenow'));
  await undo.click();

  // ---- Several hits together ------------------------------------------------------
  await editor.getByRole('button', { name: 'Select bar' }).click();
  const selected = await editor.locator('.velocity-bar.is-selected').count();
  check('select: Select Bar selects the lane’s hits in the bar', selected >= 2, `${selected}`);
  check('select: a selected hit is outlined, not filled differently',
    (await editor.locator('.drum-cell.is-selected').count()) === selected);
  await editor.getByRole('button', { name: 'Velocity: set every selected hit to the same value' }).click();
  const field = editor.locator('.editor-inspector input[type="number"]').first();
  await field.fill('50');
  await field.press('Enter');
  const levels = await editor.locator('.velocity-bar.is-selected').evaluateAll((els) => els.map((e) => e.getAttribute('aria-valuenow')));
  check('select: Set Together gives every selected hit the typed value', levels.every((v) => v === '50'), levels.join(','));
  await undo.click();
  await editor.getByRole('button', { name: 'Select none' }).click();

  // ---- Clear and undo, duplicate --------------------------------------------------
  const snapshot = await grid();
  await editor.getByRole('button', { name: 'Scope: all four drum lanes' }).click();
  await editor.getByRole('button', { name: 'Clear Drums · Bar 9' }).click();
  check('clear: All Drums · Bar 9 empties all four lanes',
    (await page.locator('[data-drum-cell][aria-pressed="true"]').count()) === 0);
  await undo.click();
  check('clear: undo restores every hit and level exactly', isDeepStrictEqual(await grid(), snapshot));
  await editor.getByRole('button', { name: 'Scope: Closed hat only' }).click();

  const bar9 = (await onSteps('hat')).map((s) => s - 128);
  await editor.locator('#dup-dest').selectOption('9');
  await editor.getByRole('button', { name: 'Duplicate Closed hat · Bar 9 to bar 10' }).click();
  await barButton(10).click();
  const bar10 = (await onSteps('hat')).map((s) => s - 144);
  check('duplicate: bar 10 now plays bar 9’s hats', isDeepStrictEqual(bar10, bar9), `${bar9} / ${bar10}`);
  check('duplicate: never wraps (no bar 17 on offer)', (await editor.locator('#dup-dest option').count()) === 16);
  await barButton(9).click();

  // ---- Humanize: preview, keep, undo ----------------------------------------------
  await editor.getByRole('button', { name: 'Humanize', exact: true }).click();
  const source = await grid();
  await editor.getByRole('group', { name: 'Humanize' }).getByRole('button', { name: 'Preview' }).click();
  await editor.locator('.preview-bar').waitFor();
  check('humanize: previews with its seed in the title', /Humanize closed hat · seed \d+/.test((await editor.locator('.preview-title').textContent()) ?? ''));
  check('humanize: composition edits wait during a preview', (await cell('hat', 140).getAttribute('aria-disabled')) === 'true');
  await editor.getByRole('button', { name: 'Keep' }).click();
  check('humanize: Keep is one undoable edit', /^Undo Humanize closed hat · seed \d+$/.test((await undoLabel()) ?? ''), await undoLabel());
  await undo.click();
  check('humanize: undoing the keep restores the source', isDeepStrictEqual(await grid(), source));
  await editor.getByRole('button', { name: 'Humanize', exact: true }).click();

  // ---- Variation: scope, preview, a fader during it, revert, same seed, keep ---------
  await editor.getByRole('button', { name: 'Vary', exact: true }).click();
  check('vary: says what it varies', (await page.getByTestId('vary-scope').textContent()) === 'Closed hat · Bars 9–12 (Break)',
    await page.getByTestId('vary-scope').textContent());
  const vary = editor.getByRole('group', { name: 'Vary' });
  await vary.locator('input[type="number"]').fill('2');
  await vary.getByRole('button', { name: 'Preview variation' }).click();
  await editor.locator('.preview-bar').waitFor(T);
  const candidate = await grid();
  check('vary: the candidate differs from the source', !isDeepStrictEqual(candidate, source));
  // A fader moved during the preview is part of the mix, not of the preview.
  const hatsFader = page.locator('article.stem[aria-labelledby="stem-hats"] input[type="range"]');
  const faderBefore = await hatsFader.inputValue();
  await hatsFader.focus();
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowUp');
  const faderMoved = await hatsFader.inputValue();
  await editor.getByRole('button', { name: 'Revert' }).click();
  check('vary: Revert puts the source back', isDeepStrictEqual(await grid(), source));
  check('vary: Revert leaves the fader where it was moved', (await hatsFader.inputValue()) === faderMoved && faderMoved !== faderBefore,
    `${faderBefore} → ${faderMoved} → ${await hatsFader.inputValue()}`);
  await vary.getByRole('button', { name: 'Preview variation' }).click();
  await editor.locator('.preview-bar').waitFor(T);
  check('vary: the same seed gives the same candidate', isDeepStrictEqual(await grid(), candidate));
  await editor.getByRole('button', { name: 'Keep' }).click();
  check('vary: Keep is one undoable edit', (await undoLabel()) === 'Undo Moderate variation · seed 2', await undoLabel());
  await undo.click();
  check('vary: undoing the keep restores the source', isDeepStrictEqual(await grid(), source));
  await editor.getByRole('button', { name: 'Lock Closed hat against Humanize and Vary' }).click();
  check('vary: a locked lane cannot be varied', await vary.getByRole('button', { name: 'Preview variation' }).isDisabled());
  await editor.getByRole('button', { name: 'Unlock Closed hat against Humanize and Vary' }).click();
  await editor.getByRole('button', { name: 'Vary', exact: true }).click();

  // ---- A bass note --------------------------------------------------------------
  await editor.getByRole('button', { name: 'Bass', exact: true }).click();
  check('bass: the editor stays on bar 9', (await editingLine()) === 'Bass · Bar 9 · Break', await editingLine());
  const notes = () => editor.locator('.roll-note').count();
  const n0 = await notes();
  const body = editor.locator('.roll-body');
  await body.scrollIntoViewIfNeeded();
  await editor.locator('.roll-scroll').evaluate((el) => {
    el.scrollTop = 0;
  });
  const rb = await body.boundingBox();
  const sc = await editor.locator('.roll-scroll').boundingBox();
  // Top row (the lane's highest pitch), column 15: well clear of the bass line.
  await page.mouse.click(rb.x + (rb.width / 16) * 14.5, sc.y + 7);
  check('bass: a click adds a note', (await notes()) === n0 + 1, `${n0} → ${await notes()}`);
  check('bass: adding is one undo step', /^Undo Add [A-G]♯?\d$/.test((await undoLabel()) ?? ''), await undoLabel());
  const added = editor.locator('.roll-note.is-selected');
  await added.focus();
  await page.keyboard.press('ArrowLeft');
  check('bass: Left moves the note a step', (await undoLabel()) === 'Undo Move note' && /step 14/.test((await added.getAttribute('aria-label')) ?? ''),
    await added.getAttribute('aria-label'));
  const len = editor.getByRole('group', { name: 'Selection' }).locator('label', { hasText: 'Length' }).locator('input');
  await len.fill('3');
  await len.press('Enter');
  check('bass: the inspector sets an exact length', /3 steps/.test((await editor.locator('.roll-note.is-selected').getAttribute('aria-label')) ?? ''));
  for (let i = 0; i < 3; i += 1) await undo.click();
  check('bass: three undos remove the note again', (await notes()) === n0);

  // ---- Scenes carry their lanes ------------------------------------------------------
  await editor.getByRole('button', { name: 'Drums', exact: true }).click();
  const target = 135;
  const had = await pressed('hat', target);
  await cell('hat', target).click();
  // The drawer sits over the scene strip; close it to reach the pads, as a hand would.
  const openEditor = async () => {
    await page.locator('[aria-controls="pattern-drawer"]').click();
    await editor.waitFor();
  };
  await page.keyboard.press('Escape');
  await page.locator('.scene-slot').nth(3).locator('.scene-menu-button').click();
  await page.getByRole('button', { name: 'Capture current mix' }).click();
  await openEditor();
  check('editor: reopening keeps the bar being edited', (await editingLine()) === 'Closed hat · Bar 9 · Break', await editingLine());
  await undo.click();
  check('scene: after undo the edit is gone', (await pressed('hat', target)) === had);
  await page.keyboard.press('Escape');
  await page.locator('.scene-slot').nth(3).locator('.scene-pad').click();
  await page.waitForFunction(() => document.querySelectorAll('.scene-slot')[3]?.getAttribute('data-state') === 'active', null, T);
  await page.waitForFunction(
    ([s, h]) => (document.querySelector(`[data-drum-cell][data-lane="hat"][data-step="${s}"]`)?.getAttribute('aria-pressed') === 'true') !== h,
    [target, had],
    T,
  );
  await openEditor();
  check('scene: launching it brings its captured lanes back', (await pressed('hat', target)) !== had);
  check('scene: the launch is one undo step', (await undoLabel()) === 'Undo Launch Drop', await undoLabel());

  // ---- A fill over edited drums -----------------------------------------------------
  const fill = page.locator('.fill-button');
  await page.keyboard.press('Escape');
  check('fill: available while playing', !(await fill.isDisabled()));
  await fill.click();
  await page.waitForFunction(() => document.querySelector('.fill-button')?.classList.contains('is-on'), null, T);
  await page.waitForFunction(() => !document.querySelector('.fill-button')?.classList.contains('is-on'), null, T);
  await openEditor();
  check('fill: plays and ends with the edited lanes still in place', (await pressed('hat', target)) !== had);

  // ---- The editor's keys are its own ------------------------------------------------
  const kickBefore = await page.locator('article.stem[aria-labelledby="stem-kick"]').getAttribute('data-state');
  await cell('hat', 140).focus();
  await page.keyboard.press('1');
  check('keys: a digit in the editor does not cut a stem',
    (await page.locator('article.stem[aria-labelledby="stem-kick"]').getAttribute('data-state')) === kickBefore);
  const on140 = await pressed('hat', 140);
  await page.keyboard.press('Space');
  check('keys: Space on a step toggles the step and keeps playing',
    (await pressed('hat', 140)) !== on140 && (await page.locator('.app').getAttribute('data-playing')) === 'yes');
  await page.keyboard.press('Control+z');
  check('keys: Ctrl+Z undoes in the editor', (await pressed('hat', 140)) === on140);

  // ---- The project round-trips -------------------------------------------------------
  const project = await page.evaluate(() => JSON.parse(JSON.stringify(window.__BCKGRND_PROJECT__())));
  let read;
  try {
    read = contract.migrateProject(JSON.parse(JSON.stringify(project)), lookup);
  } catch (e) {
    read = { error: e.message };
  }
  check('project: version 3 with the edited lanes', project.version === 3 && Object.keys(project.patterns).includes('hat'));
  check('project: serializes and reads back unchanged', isDeepStrictEqual(read, project), read.error ?? '');
  check('project: the captured scene keeps its lanes', Boolean(project.scenes.slots[3].patterns.hat));

  // ---- A new track withdraws pending edits -------------------------------------------
  await cell('hat', 141).click();
  await page.getByRole('button', { name: /^Basement,/ }).click();
  await page.waitForFunction(() => /Basement/.test(document.querySelector('.transport')?.textContent ?? ''), null, T);
  await page.waitForTimeout(400);
  check('track: a new track starts with nothing to undo', await undo.isDisabled());
  check('track: and no edits', (await changeState()) === 'none' && Object.keys((await page.evaluate(() => window.__BCKGRND_PROJECT__())).patterns).length === 0);

  check('editor: no console errors', errors.length === 0, errors.join(' | '));
  await page.close();

  // ---- Phone: eight real steps at a time ------------------------------------------------
  {
    const { page: phone, errors: phoneErrors } = await open(390, 844, { hasTouch: true, isMobile: true });
    await phone.getByRole('button', { name: 'Edit', exact: true }).click();
    await phone.locator('#pattern-drawer').waitFor();
    const steps = () =>
      phone.evaluate(() => [...document.querySelectorAll('[data-drum-cell][data-lane="kick"]')].map((e) => Number(e.dataset.step)));
    check('phone: eight steps per lane', JSON.stringify(await steps()) === '[0,1,2,3,4,5,6,7]', JSON.stringify(await steps()));
    await phone.getByRole('button', { name: 'Next steps' }).click();
    check('phone: next shows steps 9–16 of the bar', JSON.stringify(await steps()) === '[8,9,10,11,12,13,14,15]');
    const labels = await phone.locator('.step-number').allTextContents();
    check('phone: real step numbers', labels.join(',') === '9,10,11,12,13,14,15,16', labels.join(','));
    await phone.getByRole('button', { name: 'Next steps' }).click();
    check('phone: next again moves to bar 2', (await phone.getByTestId('editing-line').textContent())?.includes('Bar 2 · Intro · steps 1–8'));
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check('phone: no sideways scroll', wide);
    check('phone: no console errors', phoneErrors.length === 0, phoneErrors.join(' | '));
    await phone.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll editor checks passed.');
