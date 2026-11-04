/**
 * Layout and interaction checks for the instrument's interface.
 *
 * `verify-audio` proves the engine sounds; this proves the layout described in
 * docs/DESIGN_PHILOSOPHY.md works: every width is usable without sideways scrolling,
 * focus is visible, every silent stem says why, the inspector and the pattern drawer
 * open and close, and the phone views show one view at a time.
 *
 * Usage: node tools/verify-ui.mjs [baseUrl]
 * Set PLAYWRIGHT_CHROMIUM to a Chromium binary if Playwright's own is not installed.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

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

const stemState = (page, id) =>
  page.evaluate((stem) => {
    const el = document.querySelector(`article.stem[aria-labelledby="stem-${stem}"]`);
    return { state: el?.dataset.state, text: el?.querySelector('.status-text')?.textContent };
  }, id);

const visible = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }, selector);

try {
  // ---- Every width: no sideways scroll, the transport is on screen. ----------
  for (const [name, w, h] of [
    ['desktop', 1440, 900],
    ['laptop', 1280, 800],
    ['tablet', 1024, 768],
    ['phone', 390, 844],
    ['small phone', 320, 640],
  ]) {
    const { page, errors } = await open(w, h);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
    check(`${name}: no horizontal scroll`, scroll <= w, `${scroll}px wide at ${w}px`);
    const play = await page.getByRole('button', { name: 'Play the track' }).boundingBox();
    check(`${name}: play is in the first screen`, Boolean(play && play.y >= 0 && play.y + play.height <= h));
    check(`${name}: no page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Desktop: focus, state vocabulary, inspector, drawer. ---------------------
  {
    const { page } = await open(1440, 900);

    // Every button has a name a screen reader can say.
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button, [role="button"], input, select')]
        .filter((el) => {
          const label =
            el.getAttribute('aria-label') ||
            el.getAttribute('aria-labelledby') ||
            el.textContent?.trim() ||
            (el.id && document.querySelector(`label[for="${el.id}"]`)) ||
            el.closest('label');
          return !label;
        })
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    check('every control has an accessible name', unnamed.length === 0, unnamed.join(' | '));

    // Focus is visible: tab to the play button and read its outline.
    await page.keyboard.press('Tab');
    let outline = '';
    for (let i = 0; i < 6; i += 1) {
      outline = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return '';
        const s = getComputedStyle(el);
        return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 ? s.outlineColor : '';
      });
      if (outline) break;
      await page.keyboard.press('Tab');
    }
    check('keyboard focus draws a 2px outline', Boolean(outline), outline);

    // Stopped, every stem is Ready.
    check('stopped stems read Ready', (await stemState(page, 'kick')).text === 'Ready');

    await page.getByRole('button', { name: 'Play the track' }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes');
    await page.waitForTimeout(400);

    // Bar 1 of the intro: kick plays, the stab rests (it waits for bar 5).
    check('a stem with notes this bar reads Playing', (await stemState(page, 'kick')).state === 'playing');
    const stab = await stemState(page, 'stab');
    check('a stem the intro leaves out reads Rests this bar', stab.state === 'resting', stab.text);

    // Key 1 cuts the kick.
    await page.locator('body').click({ position: { x: 5, y: 600 } });
    await page.keyboard.press('1');
    const cut = await stemState(page, 'kick');
    check('key 1 cuts the kick, and it says Cut', cut.state === 'cut' && cut.text === 'Cut', cut.text);
    await page.keyboard.press('1');

    // A solo explains the silence it causes elsewhere.
    await page.getByRole('button', { name: 'Solo Bass' }).click();
    const off = await stemState(page, 'clap');
    check(
      'a stem silenced by another solo says whose',
      off.state === 'offBySolo' && off.text === 'Off: solo on Bass',
      off.text,
    );
    check('the soloed stem says Solo', (await stemState(page, 'bass')).state === 'soloed');
    check(
      'the save status says the mix is edited',
      (await page.locator('.save-status').textContent())?.includes('not saved') === true,
    );
    await page.getByRole('button', { name: 'Solo Bass' }).click();

    // Space stays play/stop after a mouse click on a badge, rather than pressing the
    // badge again.
    await page.getByRole('button', { name: 'Cut Clap' }).click();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'no');
    const clap = await stemState(page, 'clap');
    check('Space after clicking Cut stops playback and leaves the cut alone', clap.state === 'cut', clap.text);
    await page.getByRole('button', { name: 'Bring in Clap' }).click();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes');

    // Selecting a stem's spine opens it in the inspector.
    await page.getByRole('button', { name: 'Inspect Lead' }).click();
    check(
      'a stem opens in the inspector',
      (await page.locator('.inspector-stem-name').textContent()) === 'Lead',
    );

    // The pattern drawer opens on purpose and Escape closes it.
    check('the pattern drawer starts closed', !(await visible(page, '#pattern-drawer')));
    await page.getByRole('button', { name: 'Show the lead pattern' }).click();
    check('the pattern drawer opens', await visible(page, '#pattern-drawer'));
    const cells = await page.locator('.pattern-cell').count();
    check('the drawer shows all 16 bars of 16 steps', cells === 256, `${cells} cells`);
    await page.keyboard.press('Escape');
    check('Escape closes the drawer', !(await visible(page, '#pattern-drawer')));

    // Master controls: set the cutoff directly (as a screen reader would) and reset it.
    await page.getByRole('button', { name: 'Master', exact: true }).click();
    const filter = page.getByRole('slider', { name: 'Cutoff' });
    await filter.fill('500');
    check('a knob set directly moves off its default and offers Reset', await page.getByRole('button', { name: 'Reset cutoff' }).isEnabled());
    await page.getByRole('button', { name: 'Reset cutoff' }).click();
    check('Reset returns it home', (await filter.inputValue()) === '1000');

    await page.close();
  }

  // ---- Knobs: mouse, keyboard, typed values, reset, touch, circular drag. ------
  {
    const { page, errors } = await open(1440, 1000, { hasTouch: true });
    const knob = (label) =>
      page.locator('.knob').filter({ has: page.locator('label.knob-label', { hasText: new RegExp(`^${label}$`) }) });
    const edits = () => page.evaluate(() => window.__BCKGRND_EDITS__().length);
    const lastEdit = () => page.evaluate(() => window.__BCKGRND_EDITS__().at(-1));
    const sent = (key) => page.evaluate((k) => window.__BCKGRND_SENT__()[k], key);
    const shown = async (label) => (await knob(label).locator('.knob-value').textContent())?.replace(/\s+/g, ' ').trim();
    const norm = async (label) => Number(await knob(label).getAttribute('data-norm'));
    const exact = async (label) => Number(await knob(label).getAttribute('data-value'));
    // Let the per-frame coalescing flush before reading what was sent.
    const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const dialCenter = async (label) => {
      const dial = knob(label).locator('.knob-dial');
      await dial.scrollIntoViewIfNeeded();
      const b = await dial.boundingBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width / 2 };
    };
    const dragBy = async (label, dy, { shift = false, steps = 12 } = {}) => {
      const c = await dialCenter(label);
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.move(c.x, c.y);
      await page.mouse.down();
      for (let i = 1; i <= steps; i += 1) await page.mouse.move(c.x, c.y - (dy * i) / steps);
      await page.mouse.up();
      if (shift) await page.keyboard.up('Shift');
      await frame();
    };

    await page.getByRole('button', { name: 'Play the track' }).click();
    const count = await page.locator('.inspector .knob').count();
    check('the master rack is knobs', count === 14, `${count} knobs`);
    const named = await knob('Cutoff').locator('input[type="range"]').getAttribute('aria-valuetext');
    check('a knob speaks its value in words', named === 'Open, 18 kilohertz', named);
    const label = await page.getByRole('slider', { name: 'Cutoff' }).count();
    check('a knob is a slider named by its label', label === 1);

    // Mouse: drag down closes the filter, and the engine gets exactly the knob's value.
    let before = await edits();
    await dragBy('Cutoff', -60);
    const cutoff = await norm('Cutoff');
    const filterSent = await sent('filter');
    check('dragging down turns the cutoff down', cutoff < 0.75 && cutoff > 0.5, `${await shown('Cutoff')}, position ${cutoff.toFixed(3)}`);
    check(
      'the engine got the value the knob shows',
      filterSent && filterSent.value === (await exact('Cutoff')),
      `sent ${filterSent?.value?.toFixed(6)} vs knob ${(await exact('Cutoff')).toFixed(6)}`,
    );
    check('a whole drag is one edit', (await edits()) === before + 1, JSON.stringify(await lastEdit()));
    check('the readout is in hertz', /^\d+(\.\d)? k?Hz$/.test(await shown('Cutoff')), await shown('Cutoff'));

    // Shift: the same drag moves a tenth as far.
    const a0 = await norm('Swing');
    await dragBy('Swing', 36);
    const coarse = (await norm('Swing')) - a0;
    const a1 = await norm('Swing');
    await dragBy('Swing', 36, { shift: true });
    const fine = (await norm('Swing')) - a1;
    check('Shift drags ten times finer', coarse > 0.15 && Math.abs(coarse / fine - 10) < 2, `coarse ${coarse.toFixed(3)} fine ${fine.toFixed(4)}`);

    // Reset: the badge appears once moved, and double-click goes home.
    check('a moved knob offers Reset', await knob('Cutoff').getByRole('button', { name: 'Reset cutoff' }).isEnabled());
    const c = await dialCenter('Cutoff');
    before = await edits();
    await page.mouse.dblclick(c.x, c.y);
    await frame();
    check('double-click resets the knob', (await shown('Cutoff')) === 'Open' && (await sent('filter'))?.value === 1);
    check('a reset is one edit', (await edits()) === before + 1);
    check('Reset hides again at the default', await knob('Cutoff').locator('.knob-reset').isDisabled());

    // Keyboard: arrows step, a held key is one edit, Home/End, Delete resets.
    const res = knob('Resonance').locator('input[type="range"]');
    await res.focus();
    const ring = await page.evaluate(() => {
      const dial = document.activeElement?.closest('.knob-dial');
      return dial ? getComputedStyle(dial).outlineStyle : 'none';
    });
    check('a focused knob draws its focus ring', ring !== 'none', ring);
    const r0 = await norm('Resonance');
    before = await edits();
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ArrowUp');
    await page.keyboard.down('ArrowUp');
    await page.keyboard.up('ArrowUp');
    await frame();
    const r1 = await norm('Resonance');
    check('arrow keys step the knob', Math.abs(r1 - r0 - 0.03) < 0.002, `${r0.toFixed(3)} -> ${r1.toFixed(3)}`);
    check('a held arrow key is one edit', (await edits()) === before + 1);
    await page.keyboard.press('Shift+ArrowUp');
    check('Shift+arrow steps a tenth as far', Math.abs((await norm('Resonance')) - r1 - 0.001) < 0.0006);
    await page.keyboard.press('End');
    check('End goes to the top', (await shown('Resonance')) === '6.0 Q', await shown('Resonance'));
    await page.keyboard.press('Delete');
    await frame();
    check('Delete resets', (await shown('Resonance')) === '0.85 Q' && (await sent('filterQ'))?.value === 0.85, await shown('Resonance'));

    // Typed values: a frequency with a unit, then nonsense.
    await knob('Cutoff').locator('.knob-value').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('1.2k');
    await page.keyboard.press('Enter');
    await frame();
    const typed = (await sent('filter'))?.value;
    const expected = Math.log(1200 / 240) / Math.log(75);
    check('typing 1.2k sets 1.2 kHz', (await shown('Cutoff')) === '1.2 kHz' && Math.abs(typed - expected) < 1e-6, `${await shown('Cutoff')}, sent ${typed}`);
    await knob('Cutoff').locator('.knob-value').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('loud');
    await page.keyboard.press('Enter');
    const invalid = await knob('Cutoff').locator('.knob-edit').getAttribute('aria-invalid');
    check('a value that cannot be read is refused', invalid === 'true');
    await page.keyboard.press('Escape');
    check('Escape leaves the value alone', (await shown('Cutoff')) === '1.2 kHz');
    check('Escape in the field does not close anything else', await page.locator('.inspector').isVisible());
    await knob('Low').locator('.knob-value').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('kill');
    await page.keyboard.press('Enter');
    await frame();
    check('the isolator reads Kill at the bottom', (await shown('Low')) === 'Kill' && (await sent('bands'))?.low === 0, await shown('Low'));

    // Touch: a real touch drag (CDP touch events, so the browser makes pointer events of
    // type touch), then one cancelled mid-drag. Neither may leave the knob held.
    const cdp = await page.context().newCDPSession(page);
    const touch = async (type, x, y) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y }] });
    const w = await dialCenter('Width');
    const w0 = await norm('Width');
    before = await edits();
    await touch('touchStart', w.x, w.y);
    for (let i = 1; i <= 10; i += 1) await touch('touchMove', w.x, w.y + i * 5);
    await touch('touchEnd', w.x, w.y + 50);
    await frame();
    const w1 = await norm('Width');
    check('a touch drag turns the knob', w1 < w0 - 0.1, `${w0.toFixed(3)} -> ${w1.toFixed(3)}`);
    check('a touch drag lets go and is one edit',
      (await knob('Width').getAttribute('data-dragging')) === null && (await edits()) === before + 1);
    before = await edits();
    await touch('touchStart', w.x, w.y);
    for (let i = 1; i <= 6; i += 1) await touch('touchMove', w.x, w.y - i * 5);
    await touch('touchCancel', w.x, w.y - 30);
    await frame();
    check('a cancelled touch never leaves the knob held',
      (await knob('Width').getAttribute('data-dragging')) === null && (await edits()) === before + 1);

    // Circular drag: crossing straight down (the gap between the stops, where the angle
    // wraps from +180 to -180) must not jump the value.
    await page.getByRole('button', { name: 'Round', exact: true }).click();
    const b = await dialCenter('Decay');
    const d0 = await norm('Decay');
    const around = async (fromDeg, toDeg) => {
      const at = (deg, radius = 1.4) => ({
        x: b.x + b.r * radius * Math.sin((deg * Math.PI) / 180),
        y: b.y - b.r * radius * Math.cos((deg * Math.PI) / 180),
      });
      // Grab the knob itself, then move round outside it: capture keeps the drag.
      const grab = at(fromDeg, 0.7);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      const p0 = at(fromDeg);
      await page.mouse.move(p0.x, p0.y);
      const steps = 24;
      for (let i = 1; i <= steps; i += 1) {
        const p = at(fromDeg + ((toDeg - fromDeg) * i) / steps);
        await page.mouse.move(p.x, p.y);
      }
      await page.mouse.up();
      await frame();
    };
    await around(-90, 0);
    const d1 = await norm('Decay');
    check('circular drag turns with the hand', Math.abs(d1 - d0 - 90 / 270) < 0.03, `${d0.toFixed(3)} -> ${d1.toFixed(3)}`);
    await around(160, 200);
    const d2 = await norm('Decay');
    check('crossing the bottom does not jump', Math.abs(d2 - d1 - 40 / 270) < 0.03, `${d1.toFixed(3)} -> ${d2.toFixed(3)}`);
    await page.getByRole('button', { name: 'Up and down', exact: true }).click();

    // Disabled: with the echo off, its feedback and return have nothing to act on.
    await page.getByRole('button', { name: 'Echo every dotted eighth' }).click();
    const fbDisabled = await knob('Feedback').locator('input[type="range"]').isDisabled();
    // The reason is said once for the group (the Time label), and on each knob for
    // screen readers through its description.
    const fbNote = await knob('Feedback')
      .locator('input[type="range"]')
      .evaluate((el) => (el.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim());
    const timeLabel = await page.locator('.inspector-group', { hasText: 'Echo' }).locator('.segmented-block .control-label').textContent();
    check('with the echo off, feedback is disabled and says why', fbDisabled && fbNote === 'Echo is off' && timeLabel === 'Time · off', `${fbNote} / ${timeLabel}`);
    await page.getByRole('button', { name: 'Echo every dotted eighth' }).click();
    check('turning the echo back on enables it', !(await knob('Feedback').locator('input[type="range"]').isDisabled()));

    // Externally updated: picking another track moves Tempo and Swing without a hand.
    await page.getByRole('button', { name: /^Tunnel,/ }).click();
    await page.waitForFunction(() => document.querySelector('.knob[data-updated="yes"]'));
    check('a knob moved from outside highlights', (await knob('Tempo').getAttribute('data-updated')) === 'yes');
    check('and shows the new value', (await shown('Tempo')) === '128 BPM', await shown('Tempo'));

    // A stem's echo send, in the stem inspector, reaches that stem's send.
    await page.getByRole('button', { name: 'Inspect Lead' }).click();
    await dragBy('Echo send', 40);
    const leadSend = await sent('send:5');
    check('a stem echo send knob reaches the engine', leadSend && leadSend.value === (await exact('Echo send')),
      `sent ${leadSend?.value} for ${await shown('Echo send')}`);

    // A stem fader drag is one edit too.
    before = await edits();
    const fader = page.locator('article.stem[aria-labelledby="stem-kick"] input[type="range"]');
    const home = await fader.inputValue();
    const fb = await fader.boundingBox();
    await page.mouse.move(fb.x + fb.width * 0.9, fb.y + fb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(fb.x + fb.width * (0.9 - i * 0.04), fb.y + fb.height / 2);
    await page.mouse.up();
    await frame();
    await frame();
    check('a stem fader drag is one edit', (await edits()) === before + 1, JSON.stringify(await lastEdit()));
    await fader.dblclick();
    await frame();
    check("double-clicking a stem fader returns it to the track's level",
      (await fader.inputValue()) === home && Number((await sent('volume:0'))?.value) === Number(home),
      `${await fader.inputValue()} vs ${home}`);

    check('knobs: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Tablet: the library is an overlay opened from the transport. -----------
  {
    const { page } = await open(1024, 768);
    check('tablet: the library starts hidden', !(await visible(page, '#library')));
    await page.getByRole('button', { name: 'Open the library' }).click();
    await page.waitForTimeout(300);
    check('tablet: the transport opens the library', await visible(page, '#library'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    check('tablet: Escape closes the library', !(await visible(page, '#library')));
    await page.close();
  }

  // ---- Phone: one view at a time. --------------------------------------------
  {
    const { page } = await open(390, 844, { hasTouch: true, isMobile: true });
    const panels = async () => ({
      decks: await visible(page, '.deck-panel'),
      stems: await visible(page, '.stems-panel'),
      inspector: await visible(page, '.inspector'),
      drawer: await visible(page, '#pattern-drawer'),
    });
    let p = await panels();
    check('phone Perform: deck and stems, no inspector', p.decks && p.stems && !p.inspector && !p.drawer, JSON.stringify(p));
    await page.getByRole('button', { name: 'Mix', exact: true }).click();
    p = await panels();
    check('phone Mix: stems and inspector, no deck', !p.decks && p.stems && p.inspector && !p.drawer, JSON.stringify(p));
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    p = await panels();
    check('phone Edit: inspector and pattern', !p.decks && !p.stems && p.inspector && p.drawer, JSON.stringify(p));
    const tabs = await page.locator('.view-tabs').boundingBox();
    check('phone: the view tabs sit at the bottom of the screen', Boolean(tabs && tabs.y + tabs.height <= 844 && tabs.y > 700));
    await page.close();
  }
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll interface checks passed.');
