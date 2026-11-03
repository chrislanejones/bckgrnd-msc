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

    // Master controls still reach the engine path: move the filter and reset it.
    await page.getByRole('button', { name: 'Master', exact: true }).click();
    const filter = page.getByLabel('Filter', { exact: true });
    await filter.fill('0.5');
    check('a fader moves off its default and offers Reset', await page.getByRole('button', { name: 'Reset filter' }).isEnabled());
    await page.getByRole('button', { name: 'Reset filter' }).click();
    check('Reset returns it home', (await filter.inputValue()) === '1');

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
