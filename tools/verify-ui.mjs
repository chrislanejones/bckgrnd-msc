/**
 * Layout and interaction checks for the instrument's interface.
 *
 * `verify-audio` proves the engine sounds; this proves the layout described in
 * docs/DESIGN_PHILOSOPHY.md works: every width is usable without sideways scrolling,
 * focus is visible, every silent stem says why, the inspector and the pattern drawer
 * open and close, and the phone views show one view at a time. The Night 3 section holds
 * the scene strip, Fill, held effects, Compare A/B and Panic to docs/NIGHT3_PROTOCOL.md.
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

  // ---- Half a screen and every step around it: the transport bar holds together. --
  for (const width of [1920, 1600, 1380, 1280, 1180, 1179, 1100, 1040, 1039, 1024, 960, 900, 899, 720, 390, 320]) {
    const { page } = await open(width, 900);
    const bar = await page.evaluate(() => {
      const transport = document.querySelector('.transport');
      const title = document.querySelector('.now-title .truncate');
      const items = [...transport.children].map((el) => ({ name: el.className, box: el.getBoundingClientRect() }));
      const overlaps = items.flatMap((a, i) => items.slice(i + 1).filter((b) => {
        const across = a.box.left < b.box.right - 1 && b.box.left < a.box.right - 1;
        const down = a.box.top < b.box.bottom - 1 && b.box.top < a.box.bottom - 1;
        return across && down;
      }).map((b) => `${a.name}/${b.name}`));
      const save = document.querySelector('.save-status').getBoundingClientRect();
      return {
        pageWidth: document.documentElement.scrollWidth,
        past: items.filter((i) => i.box.right > innerWidth + 0.5 || i.box.left < 0).map((i) => i.name),
        overlaps,
        titleCut: title.scrollWidth - title.clientWidth,
        saveHeight: save.height,
      };
    });
    check(`${width}px: the page doesn't scroll sideways`, bar.pageWidth <= width, `${bar.pageWidth}px`);
    check(`${width}px: nothing in the bar is past the window edge`, bar.past.length === 0, bar.past.join(', '));
    check(`${width}px: nothing in the bar overlaps`, bar.overlaps.length === 0, bar.overlaps.join(', '));
    // The longest stock names are 11 characters; 320px is the one width that may ellipsize.
    if (width > 320) check(`${width}px: the track name isn't cut off`, bar.titleCut <= 0, `${bar.titleCut}px cut`);
    check(`${width}px: the save status stays on one line`, bar.saveHeight < 50, `${bar.saveHeight}px tall`);
    const toggle = page.getByRole('button', { name: 'Hide the inspector' });
    const expected = width < 1180 && width >= 900;
    check(`${width}px: the inspector toggle is ${expected ? 'there' : 'not needed'}`, (await toggle.count()) === (expected ? 1 : 0));
    await page.close();
  }

  // ---- Half screen: the right panel closes like the left, and comes back. ------
  {
    const { page } = await open(960, 900);
    const width = (sel) => page.evaluate((s) => document.querySelector(s).getBoundingClientRect().width, sel);
    const before = await width('.perform-area');
    await page.getByRole('button', { name: 'Hide the inspector' }).click();
    check('hiding the inspector removes it', !(await visible(page, '.inspector')));
    const after = await width('.perform-area');
    check('the decks take the inspector\'s room', after > before + 200, `${before}px to ${after}px`);
    await page.getByRole('button', { name: 'Show the inspector' }).click();
    check('showing the inspector brings it back', await visible(page, '.inspector'));
    await page.getByRole('button', { name: 'Hide the inspector' }).click();
    await page.getByRole('button', { name: 'Inspect Kick' }).click();
    check('Inspect reopens a hidden inspector', await visible(page, '.inspector'));
    // Hidden at half screen must not stay hidden once there is room for it.
    await page.getByRole('button', { name: 'Hide the inspector' }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    check('a wide window always shows the inspector', await visible(page, '.inspector'));
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
      (await page.locator('.save-status').textContent()) === 'Unsaved',
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
    // The drawer is the pattern editor now (tools/verify-editor.mjs covers editing).
    const notes = await page.locator('.piano-roll').count();
    check('the drawer opens on the lead lane', notes === 1 && (await page.getByTestId('editing-line').textContent()).startsWith('Lead · Bar'));
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

    // The vertical stem faders: grab without a jump, one edit per drag, Shift fine,
    // keys, typed values, Reset and double-click, and a cut that leaves the cap alone.
    const channel = page.locator('article.stem[aria-labelledby="stem-kick"]');
    const fader = channel.locator('.vfader');
    const level = async () => Number(await fader.getAttribute('data-value'));
    const home = await level();
    const body = channel.locator('.vfader-body');
    await body.scrollIntoViewIfNeeded();
    const fb = await body.boundingBox();
    // Grab low on the rail, far from the cap: nothing moves until the hand does.
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height - 6);
    await page.mouse.down();
    await frame();
    check('grabbing the rail away from the cap does not jump the fader', Math.abs((await level()) - home) < 1e-9);
    before = await edits();
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height - 6 + i * 4);
    await page.mouse.up();
    await frame();
    const dropped = await level();
    check('dragging a stem fader down lowers it from where it was', dropped < home - 0.15, `${home} -> ${dropped}`);
    check('a stem fader drag is one edit', (await edits()) === before + 1, JSON.stringify(await lastEdit()));
    check('the engine got the fader value', Number((await sent('volume:0'))?.value) === dropped);
    // Shift: ten times finer.
    const f0 = await level();
    await page.mouse.move(fb.x + fb.width / 2, fb.y + 20);
    await page.keyboard.down('Shift');
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) await page.mouse.move(fb.x + fb.width / 2, fb.y + 20 - i * 4);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await frame();
    const fineMove = (await level()) - f0;
    check('Shift drags a fader ten times finer', fineMove > 0 && fineMove < 0.04, fineMove.toFixed(4));
    // Keyboard on the accessible slider.
    const slider = page.getByRole('slider', { name: 'Kick volume' });
    check('the fader is a vertical slider named for its stem',
      (await slider.getAttribute('aria-orientation')) === 'vertical' && /percent$/.test((await slider.getAttribute('aria-valuetext')) ?? ''));
    await slider.focus();
    const k0 = await level();
    await page.keyboard.press('ArrowUp');
    await frame();
    check('ArrowUp raises the fader 1%', Math.abs((await level()) - k0 - 0.01) < 1e-6, `${k0} -> ${await level()}`);
    await page.keyboard.press('End');
    check('End takes it to the top', (await level()) === 1);
    await page.keyboard.press('Home');
    check('Home takes it to the bottom', (await level()) === 0);
    // Typed value: the single-pointer alternative to dragging.
    await channel.locator('.vfader-readout').click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('64');
    await page.keyboard.press('Enter');
    await frame();
    check('typing 64 sets 64%', Math.abs((await level()) - 0.64) < 1e-9 && (await channel.locator('.vfader-readout').textContent()) === '64%');
    // Cutting the stem dims it but leaves the cap at the stored level.
    // Measure against the rail, not the viewport: clicking Cut may scroll it into view.
    const capPosition = () => fader.evaluate((el) =>
      el.querySelector('.vfader-cap').getBoundingClientRect().y -
      el.querySelector('.vfader-rail').getBoundingClientRect().y);
    const capBefore = await capPosition();
    await page.getByRole('button', { name: 'Cut Kick' }).click();
    await frame();
    const capAfter = await capPosition();
    check('a cut leaves the fader cap where the level is stored',
      Math.abs(capAfter - capBefore) < 0.5 && (await level()) === 0.64 &&
      (await channel.locator('.channel-meter').getAttribute('class')).includes('is-dimmed'));
    await page.getByRole('button', { name: 'Bring in Kick' }).click();
    // Reset: the visible button, then double-click, both to the track's own level.
    await page.getByRole('button', { name: "Reset Kick to the track's level" }).click();
    await frame();
    check("Reset returns the fader to the track's level", (await level()) === home && Number((await sent('volume:0'))?.value) === home);
    await slider.focus();
    await page.keyboard.press('Home');
    await body.dblclick();
    await frame();
    check("double-clicking a stem fader returns it to the track's level", (await level()) === home, `${await level()} vs ${home}`);

    check('knobs: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Scenes, musical timing and live performance (Night 3). ----------------
  // docs/NIGHT3_PROTOCOL.md: a pad reads Active only once the engine applied it, a
  // launch lands on the next bar, and held effects never reach the working mix.
  {
    const { page, errors } = await open(1440, 1000, { hasTouch: true });
    try {
      await page.waitForSelector('.scene-slot');
      const T = { timeout: 8000 };
      const slot = (i) => page.locator('.scene-slot').nth(i);
      const pad = (i) => slot(i).locator('.scene-pad');
      const stateOf = (i) => slot(i).getAttribute('data-state');
      const lineOf = async (i) => (await slot(i).locator('.scene-line').textContent())?.trim();
      const names = () => page.locator('.scene-name').allTextContents();
      const statusText = async () => (await page.locator('.scene-status').textContent())?.trim();
      const waitState = (i, states) =>
        page.waitForFunction(
          ([n, list]) => list.includes(document.querySelectorAll('.scene-slot')[n]?.getAttribute('data-state')),
          [i, [].concat(states)],
          T,
        );
      const waitLine = (i, re) =>
        page.waitForFunction(
          ([n, src]) => new RegExp(src).test(document.querySelectorAll('.scene-slot')[n]?.querySelector('.scene-line')?.textContent?.trim() ?? ''),
          [i, re.source],
          T,
        );
      const waitText = (selector, re) =>
        page.waitForFunction(
          ([sel, src]) => new RegExp(src).test(document.querySelector(sel)?.textContent?.trim() ?? ''),
          [selector, re.source],
          T,
        );
      const waitStatus = (re) => waitText('.scene-status', re);
      const knob = (label) =>
        page.locator('.knob').filter({ has: page.locator('label.knob-label', { hasText: new RegExp(`^${label}$`) }) });
      const shown = async (label) => (await knob(label).locator('.knob-value').textContent())?.replace(/\s+/g, ' ').trim();
      const playing = () => page.locator('.app').getAttribute('data-playing');
      const cancelScene = page.getByRole('button', { name: 'Cancel scene', exact: true });
      const selectedScenes = () => page.locator('.scene-pad[aria-pressed="true"]').count();
      const sceneMix = () => page.evaluate(() => {
        const { params, stems } = window.__BCKGRND_PROJECT__();
        return JSON.stringify({ stems, params: Object.fromEntries(Object.entries(params).filter(([id]) => id.startsWith('fx.'))) });
      });
      // A bar boundary, as the transport counts it: launching right after one leaves
      // nearly a whole bar (about 1.9 s at 126 BPM) before the next.
      const barNow = () => page.locator('.bar-readout .tabular-nums').textContent();
      const nextBar = async () => {
        const b = await barNow();
        await page.waitForFunction((was) => document.querySelector('.bar-readout .tabular-nums')?.textContent !== was, b, T);
      };
      // Every state each pad passes through. A queued line can be brief, so watch the
      // DOM rather than poll it.
      await page.evaluate(() => {
        const record = () =>
          document.querySelectorAll('.scene-slot').forEach((el, i) => {
            const t = `${el.getAttribute('data-state')}|${el.querySelector('.scene-line')?.textContent?.trim()}`;
            const seen = window.__SCENE_LINES__[i];
            if (seen.at(-1) !== t) seen.push(t);
          });
        window.__SCENE_LINES_RESET__ = () => {
          window.__SCENE_LINES__ = [[], [], [], []];
          record();
        };
        window.__SCENE_LINES_RESET__();
        new MutationObserver(record).observe(document.querySelector('.scene-pads'), {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        });
      });
      const resetHistory = () => page.evaluate(() => window.__SCENE_LINES_RESET__());
      const history = (i) => page.evaluate((n) => window.__SCENE_LINES__[n], i);
      const releaseFx = page.getByRole('button', { name: 'Release FX' });
      const fillButton = page.locator('.fill-button');
      const filterPad = page.getByRole('button', { name: 'Filter hold, while held' });
      const echoPad = page.getByRole('button', { name: 'Echo throw, while held' });
      const center = async (locator) => {
        await locator.scrollIntoViewIfNeeded();
        const b = await locator.boundingBox();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      };
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, p) =>
        cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }] });
      const filterLegend = () =>
        page.locator('.inspector-legend').filter({ hasText: /^Filter/ }).textContent();
      const openMenu = async (i) => {
        await slot(i).locator('.scene-menu-button').click();
        await page.getByRole('dialog').waitFor();
      };
      const menuClosed = async () => (await page.getByRole('dialog').count()) === 0;

      // Stopped, never played.
      check('scenes: four pads, named Full, Sparse, Build, Drop',
        JSON.stringify(await names()) === '["Full","Sparse","Build","Drop"]', (await names()).join(', '));
      check('scenes: Bar is the default timing',
        (await page.getByRole('button', { name: 'Launch on the next bar' }).getAttribute('aria-pressed')) === 'true');
      check('scenes: Cancel is disabled with no selection or queue', await cancelScene.isDisabled());
      const fillTitle = await fillButton.getAttribute('title');
      check('fill: disabled while stopped, and the title says why',
        (await fillButton.isDisabled()) && /play/i.test(fillTitle ?? ''), fillTitle);
      check('held effects: Release FX is disabled with nothing held', await releaseFx.isDisabled());

      // A scene picked before the first Play is active at once and starts nothing.
      await page.getByRole('slider', { name: 'Cutoff' }).fill('450');
      const beforeScenes = await sceneMix();
      await pad(1).click();
      await waitState(1, 'active');
      await page.waitForTimeout(400);
      check('scenes: before the first Play a scene is Active at once',
        (await lineOf(1)) === 'Active' && (await statusText()) === 'Sparse active', `${await lineOf(1)} / ${await statusText()}`);
      check('scenes: and playback stays stopped', (await playing()) === 'no');
      check('scenes: the stopped scene set the mix (Sparse cuts the kick)', (await stemState(page, 'kick')).state === 'cut');
      check('scenes: Cancel is available for an active scene with nothing queued', !(await cancelScene.isDisabled()));
      await cancelScene.click();
      check('scenes: Cancel before Play restores the custom mix and clears selection',
        (await selectedScenes()) === 0 && (await sceneMix()) === beforeScenes && (await playing()) === 'no');
      await pad(1).click();
      await waitState(1, 'active');

      await page.getByRole('button', { name: 'Play the track' }).click();
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes');
      check('scenes: still active after Play', (await stateOf(1)) === 'active' && (await stemState(page, 'kick')).state === 'cut');

      // The status line is for discrete changes: nothing queued, it holds still while
      // the bars go by.
      const statusRole = await page.locator('.scene-status').evaluate((el) => `${el.getAttribute('role')}/${el.getAttribute('aria-live')}`);
      check('scenes: the status line is a polite live region', statusRole === 'status/polite', statusRole);
      await page.evaluate(() => {
        window.__STATUS_MUTATIONS__ = 0;
        new MutationObserver((m) => {
          window.__STATUS_MUTATIONS__ += m.length;
        }).observe(document.querySelector('.scene-status'), { subtree: true, childList: true, characterData: true });
      });
      const samples = [await statusText()];
      for (let i = 0; i < 3; i += 1) {
        await nextBar();
        samples.push(await statusText());
      }
      const statusMutations = await page.evaluate(() => window.__STATUS_MUTATIONS__);
      check('scenes: the status line does not change every beat',
        new Set(samples).size === 1 && statusMutations === 0, `${samples.join(' | ')}; ${statusMutations} mutations over 3 bars`);

      // Drop mid-bar: Queued · Bar N, then Active on that bar, with Drop's open filter.
      await page.getByRole('slider', { name: 'Cutoff' }).fill('500');
      const closedCutoff = await shown('Cutoff');
      await resetHistory();
      await nextBar();
      await pad(3).click();
      await waitLine(3, /^Queued · Bar \d+$/);
      const queuedLine = await lineOf(3);
      const queuedAnim = await pad(3).evaluate((el) => getComputedStyle(el).animationName);
      check('scenes: pressing Drop while playing shows Queued · Bar N', /^Queued · Bar \d+$/.test(queuedLine), queuedLine);
      check('scenes: a queued pad pulses (with motion allowed)', queuedAnim === 'scene-queued', queuedAnim);
      check('scenes: queued is not active yet: Sparse still is',
        (await stateOf(3)) === 'queued' && ['active', 'modified'].includes(await stateOf(1)), `Drop ${await stateOf(3)}, Sparse ${await stateOf(1)}`);
      await waitState(3, 'active');
      check('scenes: Drop becomes Active on the next bar', (await lineOf(3)) === 'Active' && (await statusText()) === 'Drop active', await statusText());
      // The transport's readout trails the engine's applied event by one telemetry tick.
      const announced = queuedLine.replace(/\D+/g, '').padStart(2, '0');
      const onTime = await page
        .waitForFunction((n) => document.querySelector('.bar-readout .tabular-nums')?.textContent === n, announced, { timeout: 500 })
        .then(() => true, () => false);
      check('scenes: it landed on the bar it announced', onTime, `announced ${queuedLine}, transport at bar ${await barNow()}`);
      check("scenes: the Cutoff knob shows Drop's open filter", (await shown('Cutoff')) === 'Open', `${closedCutoff} -> ${await shown('Cutoff')}`);
      const dropSeen = await history(3);
      check('scenes: the pad said Sending, then Queued, then Active',
        dropSeen.findIndex((s) => s.startsWith('sending')) < dropSeen.findIndex((s) => s.startsWith('queued')) &&
          dropSeen.findIndex((s) => s.startsWith('queued')) < dropSeen.findIndex((s) => s.startsWith('active')) &&
          dropSeen.some((s) => s.startsWith('sending')),
        dropSeen.join(' > '));

      // A knob moved afterwards: Active · Modified.
      await page.getByRole('slider', { name: 'Resonance' }).fill('600');
      await waitState(3, 'modified');
      check('scenes: moving a knob after a launch shows Active · Modified', (await lineOf(3)) === 'Active · Modified', await lineOf(3));

      // Build, then Sparse before the boundary: only Sparse lands, on Build's bar.
      await resetHistory();
      await nextBar();
      await pad(2).click();
      await waitLine(2, /^Queued · Bar \d+$/);
      const buildLine = await lineOf(2);
      await pad(1).click();
      await waitLine(1, /^Queued · Bar \d+$/);
      check("scenes: a second launch clears the first one's line",
        (await lineOf(2)) === '' && (await stateOf(2)) === 'available', `${await stateOf(2)} "${await lineOf(2)}"`);
      check("scenes: the replacement keeps the bar already announced", (await lineOf(1)) === buildLine, `${buildLine} vs ${await lineOf(1)}`);
      await waitState(1, 'active');
      const buildSeen = await history(2);
      check('scenes: only Sparse becomes active; Build never does',
        !buildSeen.some((s) => s.startsWith('active')) && (await stateOf(2)) === 'available' && (await stateOf(3)) === 'available',
        buildSeen.join(' > '));

      // Cancel clears both the queued launch and the active scene. Multiple scene
      // choices keep the original custom mix as the return point.
      await nextBar();
      await pad(0).click();
      await waitLine(0, /^Queued · Bar \d+$/);
      await cancelScene.click();
      await waitStatus(/^Scene cleared; previous mix restored$/);
      check('scenes: Cancel clears the queued line and active selection',
        (await lineOf(0)) === '' && (await selectedScenes()) === 0);
      await nextBar();
      await page.waitForTimeout(300);
      check('scenes: the queued scene cannot land after Cancel',
        (await selectedScenes()) === 0 && (await sceneMix()) === beforeScenes && (await playing()) === 'yes');
      check('scenes: status confirms the previous mix was restored',
        (await statusText()) === 'Scene cleared; previous mix restored', await statusText());
      check('scenes: Cancel goes back to disabled', await cancelScene.isDisabled());

      // Pressing the queued pad again withdraws only that launch.
      await pad(1).click();
      await waitState(1, 'active');
      await nextBar();
      await pad(0).click();
      await waitStatus(/^Full queued for bar \d+$/);
      await pad(0).click();
      const padCancelled = await waitStatus(/^Full cancelled$/).then(() => true, () => false);
      await nextBar();
      await page.waitForTimeout(300);
      check('scenes: pressing the queued pad again cancels it',
        padCancelled && (await stateOf(1)) === 'active' && (await stateOf(0)) === 'available',
        `${await statusText()}; Full ${await stateOf(0)}, Sparse ${await stateOf(1)}`);

      // Shift+1..4 launch by physical key. Each replaces the one before; then cancel.
      await page.locator('body').click({ position: { x: 5, y: 600 } });
      await resetHistory();
      await nextBar();
      for (let d = 1; d <= 4; d += 1) {
        await page.keyboard.press(`Shift+Digit${d}`);
        await waitState(d - 1, ['sending', 'queued']);
      }
      const shiftSeen = await Promise.all([0, 1, 2, 3].map(history));
      await cancelScene.click();
      await waitStatus(/^Scene cleared; previous mix restored$/);
      check('scenes: Shift+1..4 launch the four pads',
        shiftSeen.every((seen) => seen.some((s) => /^(sending|queued)/.test(s))), shiftSeen.map((s) => s.join(' > ')).join(' || '));

      // The menu: capture, rename (blank refused), duplicate, reset, Escape.
      await openMenu(3);
      await page.getByRole('button', { name: 'Capture current mix' }).click();
      check('menu: Capture current mix stores into the slot and closes',
        (await statusText()) === 'Captured the current mix into Drop' && (await menuClosed()), await statusText());
      await openMenu(0);
      await page.getByRole('button', { name: 'Rename…' }).click();
      const nameField = page.getByRole('textbox', { name: 'Scene name' });
      // The field takes focus in an effect after it renders; give it a moment.
      await nameField.evaluate((el) => new Promise((resolve) => {
        const start = performance.now();
        const poll = () => (el === document.activeElement || performance.now() - start > 1000 ? resolve(null) : requestAnimationFrame(poll));
        poll();
      }));
      check('menu: Rename… puts focus in the name field', await nameField.evaluate((el) => el === document.activeElement));
      await nameField.fill('   ');
      await page.getByRole('button', { name: 'Save name' }).click();
      check('menu: a blank name is refused (aria-invalid) and the menu stays open',
        (await nameField.getAttribute('aria-invalid')) === 'true' && !(await menuClosed()) && (await names())[0] === 'Full');
      await nameField.fill('');
      await nameField.focus();
      await resetHistory();
      await page.keyboard.press('Shift+Digit3');
      await page.waitForTimeout(250);
      const typedSeen = await Promise.all([0, 1, 2, 3].map(history));
      check('scenes: Shift+digit typed into the rename field types, and launches nothing',
        (await nameField.inputValue()) === '#' && typedSeen.every((seen) => !seen.some((s) => /^(sending|queued)/.test(s))),
        `field "${await nameField.inputValue()}"; ${typedSeen.map((s) => s.join(' > ')).join(' || ')}`);
      await nameField.fill('Intro');
      await page.getByRole('button', { name: 'Save name' }).click();
      check('menu: a valid name shows on the pad', (await names())[0] === 'Intro' && (await menuClosed()), (await names()).join(', '));
      await openMenu(3);
      await page.getByRole('button', { name: 'Duplicate Drop into the Build slot' }).click();
      check('menu: Duplicate copies into another slot',
        JSON.stringify(await names()) === '["Intro","Sparse","Drop","Drop"]' && (await menuClosed()), (await names()).join(', '));
      await openMenu(0);
      await page.getByRole('button', { name: 'Reset to factory' }).click();
      await openMenu(2);
      await page.getByRole('button', { name: 'Reset to factory' }).click();
      check('menu: Reset to factory restores the recipe name',
        JSON.stringify(await names()) === '["Full","Sparse","Build","Drop"]' && (await statusText()) === 'Build is back to its factory mix',
        `${(await names()).join(', ')} / ${await statusText()}`);
      await openMenu(1);
      await page.keyboard.press('Escape');
      check('menu: Escape closes it', (await menuClosed()) && (await slot(1).locator('.scene-menu-button').getAttribute('aria-expanded')) === 'false');
      await openMenu(1);
      await page.getByRole('button', { name: 'Rename…' }).click();
      await page.keyboard.press('Escape');
      check('menu: Escape closes it from the rename field too, renaming nothing',
        (await menuClosed()) && (await names())[1] === 'Sparse');

      // Fill: first press queues, second cancels; then one plays its bar and returns.
      await nextBar();
      await fillButton.click();
      await waitText('.fill-button', /^Fill · Bar \d+$/);
      check('fill: the first press queues it for the next bar', /^Fill · Bar \d+$/.test(await fillButton.textContent()), await fillButton.textContent());
      await fillButton.click();
      await page.waitForFunction(() => document.querySelector('.fill-button')?.getAttribute('data-state') === 'idle', null, T);
      check('fill: a second press before it starts cancels it',
        (await fillButton.textContent()) === 'Drum fill' && (await statusText()) === 'Fill cancelled', await statusText());
      await nextBar();
      await fillButton.click();
      await page.waitForFunction(() => document.querySelector('.fill-button')?.getAttribute('data-state') === 'playing', null, T);
      check('fill: it plays its bar, and the button is disabled meanwhile', await fillButton.isDisabled());
      await page.waitForFunction(() => document.querySelector('.fill-button')?.getAttribute('data-state') === 'idle', null, T);
      check('fill: then it returns to idle', (await fillButton.textContent()) === 'Drum fill' && !(await fillButton.isDisabled()));

      await nextBar();
      await page.getByRole('button', { name: 'Launch Full', exact: true }).click();
      await fillButton.click();
      await waitText('.fill-button', /^Fill · Bar \d+$/);
      await page.getByRole('button', { name: 'Stop the track', exact: true }).click();
      await page.waitForFunction(() => {
        const text = document.querySelector('.scene-status')?.textContent ?? '';
        return /cancelled.*Fill cancelled/i.test(text);
      }, null, T);
      check('Stop announces both the cancelled scene and fill', /cancelled.*Fill cancelled/i.test(await statusText()), await statusText());
      await page.getByRole('button', { name: 'Play the track', exact: true }).click();

      // Held Filter: pressed while the pointer is down (and captured), the knob keeps
      // showing the mix underneath, letting go releases it.
      await page.getByRole('slider', { name: 'Cutoff' }).fill('900');
      const baseCutoff = await shown('Cutoff');
      const f = await center(filterPad);
      await page.mouse.move(f.x, f.y);
      await page.mouse.down();
      await page.waitForFunction(() => document.querySelector('[aria-label="Filter hold, while held"]')?.getAttribute('aria-pressed') === 'true', null, T);
      const captured = await filterPad.evaluate((el) => el.hasPointerCapture(1));
      check('held: holding Filter presses the pad, with the pointer captured', captured);
      check('held: the Filter heading says held', (await filterLegend()) === 'Filter · held', await filterLegend());
      check('held: the Cutoff knob still shows its base value', (await shown('Cutoff')) === baseCutoff, `${baseCutoff} vs ${await shown('Cutoff')}`);
      check('held: Release FX is enabled while something is held', await releaseFx.isEnabled());
      await page.mouse.move(f.x + 220, f.y - 160);
      check('held: sliding off the pad keeps it held', (await filterPad.getAttribute('aria-pressed')) === 'true');
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('[aria-label="Filter hold, while held"]')?.getAttribute('aria-pressed') === 'false', null, T);
      check('held: letting go releases it', (await filterLegend()) === 'Filter' && (await releaseFx.isDisabled()));

      // Held Echo, then the window loses focus: released.
      const e = await center(echoPad);
      await page.mouse.move(e.x, e.y);
      await page.mouse.down();
      await page.waitForFunction(() => document.querySelector('[aria-label="Echo throw, while held"]')?.getAttribute('aria-pressed') === 'true', null, T);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await page.waitForFunction(() => document.querySelector('[aria-label="Echo throw, while held"]')?.getAttribute('aria-pressed') === 'false', null, T);
      check('held: the window losing focus releases a held Echo', await releaseFx.isDisabled());
      await page.mouse.up();

      // Release FX lets go while a finger still holds the pad. (The pad must not have
      // focus: a focused pad releases on blur, which would pass this for the wrong reason.)
      const touchHold = async () => {
        await page.evaluate(() => document.activeElement?.blur());
        const at = await center(filterPad);
        await touch('touchStart', at);
        await page.waitForFunction(() => document.querySelector('[aria-label="Filter hold, while held"]')?.getAttribute('aria-pressed') === 'true', null, T);
        return at;
      };
      let finger = await touchHold();
      await page.locator('body').click({ position: { x: 5, y: 600 } });
      check('held: a click elsewhere does not release a held pad', (await filterPad.getAttribute('aria-pressed')) === 'true');
      // A second finger tapping another control moves focus off the held pad. A touch
      // hold must survive that (hold Filter, tap Drop); only a keyboard hold ends on blur.
      await page.evaluate(() => {
        const pad = document.querySelector('[aria-label="Filter hold, while held"]');
        pad?.focus();
        document.querySelector('.scene-pad')?.focus();
      });
      check('held: focus moving to another control does not end a touch hold', (await filterPad.getAttribute('aria-pressed')) === 'true');
      await releaseFx.click();
      check('held: Release FX releases a held effect',
        (await filterPad.getAttribute('aria-pressed')) === 'false' && (await filterLegend()) === 'Filter' && (await releaseFx.isDisabled()));
      check('held: Release FX leaves the working mix alone', (await shown('Cutoff')) === baseCutoff, await shown('Cutoff'));
      await touch('touchEnd', finger);

      // Capture during a held Filter stores the base, not the held treatment.
      finger = await touchHold();
      const heldScroll = await page.evaluate(() => window.scrollY);
      await openMenu(0);
      await page.getByRole('button', { name: 'Capture current mix' }).click();
      const heldAtCapture = await filterPad.getAttribute('aria-pressed');
      // The mouse clicks above scrolled the page; put it back before the finger lifts,
      // or the lift lands as a tap on whatever now sits under it (a mixer channel).
      await page.evaluate((y) => window.scrollTo(0, y), heldScroll);
      await touch('touchEnd', finger);
      await page.getByRole('button', { name: 'Reset cutoff' }).click();
      await page.getByRole('button', { name: 'Launch now' }).click();
      await pad(0).click();
      await waitState(0, 'active');
      check('held: a capture during a held Filter stores the base Cutoff',
        heldAtCapture === 'true' && (await shown('Cutoff')) === baseCutoff, `held ${heldAtCapture}; launched Full shows ${await shown('Cutoff')}, base ${baseCutoff}`);

      // Compare A/B on the bar: capture A, change, capture B, hear each, Exit.
      await page.getByRole('button', { name: 'Launch on the next bar' }).click();
      const chip = (i) => page.locator('.compare-chip').nth(i);
      const chipText = async (i) => (await chip(i).textContent())?.trim();
      const waitChip = (i, text) =>
        page.waitForFunction(([n, t]) => document.querySelectorAll('.compare-chip')[n]?.textContent?.trim() === t, [i, text], T);
      const beforeCutoff = await shown('Cutoff');
      const beforeRes = await shown('Resonance');
      const namesBefore = JSON.stringify(await names());
      await page.getByRole('button', { name: 'Capture A' }).click();
      check('compare: Capture A, and A is what is heard', (await chipText(0)) === 'A · Listening', await chipText(0));
      await page.getByRole('slider', { name: 'Cutoff' }).fill('300');
      const bCutoff = await shown('Cutoff');
      check('compare: editing after capture shows A · Modified', (await chipText(0)) === 'A · Modified', await chipText(0));
      await page.getByRole('button', { name: 'Capture B' }).click();
      check('compare: Capture B shows B · Listening',
        (await chipText(1)) === 'B · Listening' && (await chipText(0)) === 'A', `${await chipText(0)} / ${await chipText(1)}`);
      await nextBar();
      await chip(0).click();
      await waitChip(0, 'A · Queued');
      await waitChip(0, 'A · Listening');
      check('compare: listening to A lands on the bar and brings its knob back', (await shown('Cutoff')) === beforeCutoff, `${bCutoff} -> ${await shown('Cutoff')}`);
      await nextBar();
      await chip(1).click();
      await waitChip(1, 'B · Listening');
      check('compare: listening to B brings B back', (await shown('Cutoff')) === bCutoff, await shown('Cutoff'));
      await page.getByRole('slider', { name: 'Resonance' }).fill('250');
      await waitChip(1, 'B · Modified');
      await page.getByRole('button', { name: 'Update B' }).click();
      check('compare: Update B replaces B with what is playing', (await chipText(1)) === 'B · Listening', await chipText(1));
      await nextBar();
      await page.getByRole('button', { name: 'Exit comparison' }).click();
      await page.getByRole('button', { name: 'Capture A' }).waitFor(T);
      check('compare: Exit comparison brings back the mix from before Capture A',
        (await shown('Cutoff')) === beforeCutoff && (await shown('Resonance')) === beforeRes,
        `${await shown('Cutoff')} / ${await shown('Resonance')} vs ${beforeCutoff} / ${beforeRes}`);
      check('compare: the scene slots are unchanged, and Full is active again',
        JSON.stringify(await names()) === namesBefore && (await stateOf(0)) === 'active', `${(await names()).join(', ')}; Full ${await stateOf(0)}`);
      await page.getByRole('button', { name: 'Capture A' }).click();
      await page.getByRole('slider', { name: 'Cutoff' }).fill('400');
      const keptCutoff = await shown('Cutoff');
      await page.getByRole('button', { name: 'Keep current' }).click();
      check('compare: Keep current closes the comparison and keeps the mix',
        (await chipText(0)) === 'Capture A' && (await shown('Cutoff')) === keptCutoff && (await statusText()) === 'Kept the current mix',
        `${await chipText(0)} / ${await shown('Cutoff')} / ${await statusText()}`);
      // Keep current while a listen is still queued: what is heard now is kept, and the
      // queued one never lands over it.
      await page.getByRole('button', { name: 'Capture A' }).click();
      await page.getByRole('slider', { name: 'Cutoff' }).fill('600');
      await page.getByRole('button', { name: 'Capture B' }).click();
      const heardCutoff = await shown('Cutoff');
      await nextBar();
      await chip(0).click();
      await waitChip(0, 'A · Queued');
      await page.getByRole('button', { name: 'Keep current' }).click();
      await nextBar();
      await page.waitForTimeout(300);
      check('compare: Keep current with a listen queued keeps what was heard',
        (await shown('Cutoff')) === heardCutoff && (await chipText(0)) === 'Capture A',
        `${heardCutoff} -> ${await shown('Cutoff')}; ${await statusText()}`);

      // Panic with a launch queued: stopped, nothing queued, says Panic.
      await nextBar();
      await pad(3).click();
      await waitLine(3, /^Queued · Bar \d+$/);
      await page.getByRole('button', { name: 'Panic', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'no', null, T);
      await page.waitForTimeout(300);
      check('panic: stops playback, and the queued line clears',
        (await lineOf(3)) === '' && (await stateOf(3)) === 'available', `${await stateOf(3)} "${await lineOf(3)}"`);
      check('panic: the status line says Panic', /Panic/.test(await statusText()), await statusText());
      check('panic: Cancel remains available only if an active scene remains',
        (await cancelScene.isDisabled()) === ((await selectedScenes()) === 0));

    } catch (e) {
      check('scenes: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('scenes: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Scenes with reduced motion: a queued pad holds still but still says so. --
  {
    const { page, errors } = await open(1440, 1000, { reducedMotion: 'reduce' });
    try {
      await page.getByRole('button', { name: 'Play the track' }).click();
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes');
      const b = await page.locator('.bar-readout .tabular-nums').textContent();
      await page.waitForFunction((was) => document.querySelector('.bar-readout .tabular-nums')?.textContent !== was, b, { timeout: 8000 });
      const drop = page.locator('.scene-slot').nth(3);
      await drop.locator('.scene-pad').click();
      await page.waitForFunction(() => /^Queued · Bar \d+$/.test(document.querySelectorAll('.scene-slot')[3]?.querySelector('.scene-line')?.textContent?.trim() ?? ''), null, { timeout: 8000 });
      const anim = await drop.locator('.scene-pad').evaluate((el) => getComputedStyle(el).animationName);
      const line = (await drop.locator('.scene-line').textContent())?.trim();
      check('reduced motion: a queued pad does not animate', anim === 'none', anim);
      check('reduced motion: it still says Queued · Bar N', /^Queued · Bar \d+$/.test(line ?? ''), line);
    } catch (e) {
      check('reduced motion: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('reduced motion: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Scenes during an auto-mix: launching waits, and says so. ----------------
  {
    const { page, errors } = await open(1440, 1000);
    try {
      await page.waitForSelector('.scene-slot');
      await page.getByRole('button', { name: 'Play the track' }).click();
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes');
      await page.getByRole('button', { name: 'Capture A' }).click();
      await page.getByRole('button', { name: /^Auto mix/ }).click();
      await page.waitForFunction(() => document.querySelector('.scene-pad')?.disabled === true, null, { timeout: 8000 });
      const lines = (await page.locator('.scene-line').allTextContents()).map((t) => t.trim());
      const padsOff = await page.locator('.scene-pad').evaluateAll((els) => els.every((el) => el.disabled));
      check('mixing: every scene pad is disabled and says Available after mix',
        padsOff && lines.every((t) => t === 'Available after mix'), lines.join(' | '));
      const chipA = page.locator('.compare-chip').nth(0);
      check('mixing: Compare listen and Exit are disabled, and say why',
        (await chipA.isDisabled()) && (await chipA.getAttribute('title')) === 'Available after mix' &&
          (await page.getByRole('button', { name: 'Exit comparison' }).isDisabled()));
      const fill = page.locator('.fill-button');
      check('mixing: Fill is disabled, and says why',
        (await fill.isDisabled()) && (await fill.getAttribute('title')) === 'Available after mix', await fill.getAttribute('title'));
      await page.locator('body').click({ position: { x: 5, y: 600 } });
      await page.keyboard.press('Shift+Digit2');
      await page.waitForTimeout(200);
      check('mixing: Shift+2 launches nothing', (await page.locator('.scene-slot').nth(1).getAttribute('data-state')) === 'unavailable');
      const filterPad = page.getByRole('button', { name: 'Filter hold, while held' });
      await filterPad.scrollIntoViewIfNeeded();
      const fb = await filterPad.boundingBox();
      await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(200);
      check('mixing: a held effect is refused', (await filterPad.getAttribute('aria-pressed')) !== 'true');
      const refusedStatus = await page.locator('.scene-status').textContent();
      check('mixing: the refused effect explains when it is available', /available after mix/i.test(refusedStatus), refusedStatus);
      await page.mouse.up();
      await page.getByRole('button', { name: 'Panic', exact: true }).click();
      // The pads come back at once; playback reports stopped on the next telemetry
      // frame. Wait for both rather than reading the second straight after the first.
      await page.waitForFunction(
        () => document.querySelector('.scene-pad')?.disabled === false &&
          document.querySelector('.app')?.getAttribute('data-playing') === 'no',
        null,
        { timeout: 8000 },
      ).catch(() => {});
      check('mixing: Panic abandons the mix and the pads come back',
        (await page.locator('.app').getAttribute('data-playing')) === 'no' &&
          (await page.locator('.scene-pad').evaluateAll((els) => els.every((el) => !el.disabled))));
    } catch (e) {
      check('mixing: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('mixing: no page errors', errors.length === 0, errors.join('; '));
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
