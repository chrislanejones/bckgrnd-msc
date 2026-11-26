/**
 * Beat Repeat (Night 10, docs/NIGHT10_PROTOCOL.md) at the host and UI level.
 *
 * The Deck's Repeat pad is a held effect like Echo and Filter: holding it presses it
 * and the engine takes the gesture (a refusal would let the pad go at once); letting go,
 * a pointer cancel, lost capture, window blur, the tab going hidden, a Space or Enter
 * keyup and the pad losing focus each release it; a track change, Release FX and Panic
 * clear it while a finger still holds the pad. The division picker defaults to 1/8, reaches the
 * engine, and is remembered across a reload (`bckgrnd-msc:repeat-division`).
 *
 * Run by tools/verify-ui.mjs (repeatChecks), or on its own:
 *   node tools/verify-ui-repeat.mjs [baseUrl]
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const T = { timeout: 5000 };
const PAD = 'Beat repeat, while held';
const PREF_KEY = 'bckgrnd-msc:repeat-division';

export async function repeatChecks({ open, check }) {
  const { page, errors } = await open(1440, 1000);
  try {
    const pad = page.getByRole('button', { name: PAD, exact: true });
    const releaseFx = page.getByRole('button', { name: 'Release FX' });
    const pressed = () => pad.getAttribute('aria-pressed');
    const waitPressed = (v) =>
      page.waitForFunction(([name, want]) => document.querySelector(`[aria-label="${name}"]`)?.getAttribute('aria-pressed') === want, [PAD, v], T);
    const NOTE = { 4: 'quarter', 8: 'eighth', 16: 'sixteenth' };
    const radio = (d) => page.getByRole('radio', { name: `Repeat every ${NOTE[d]} note`, exact: true });
    const sent = () => page.evaluate(() => window.__BCKGRND_SENT__?.().repeatDivision ?? null);
    const center = async () => {
      await pad.scrollIntoViewIfNeeded();
      const b = await pad.boundingBox();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, p) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }] });

    check('repeat: a Repeat hold pad sits next to Filter in the Deck pads',
      (await pad.count()) === 1
        && (await page.locator('.deck-pads .pad').evaluateAll((els, name) => {
          const i = els.findIndex((el) => el.getAttribute('aria-label') === name);
          return i > 0 && els[i - 1].getAttribute('aria-label') === 'Filter hold, while held';
        }, PAD)));
    check('repeat: not held at rest', (await pressed()) === 'false');
    check('repeat: the division defaults to 1/8',
      (await radio(8).getAttribute('aria-checked')) === 'true'
        && (await Promise.all([4, 16].map((d) => radio(d).getAttribute('aria-checked')))).every((v) => v === 'false'));

    await page.getByRole('button', { name: 'Play the track' }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, T);
    await page.waitForFunction(() => window.__BCKGRND_SENT__?.().repeatDivision != null, null, T).catch(() => {});
    const boot = await sent();
    check('repeat: the remembered division reaches the engine on load', boot?.type === 'repeatDivision' && boot?.value === 8, JSON.stringify(boot));

    // Hold with the mouse: pressed, captured, and still pressed once the engine answered.
    let at = await center();
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await waitPressed('true');
    check('repeat: holding presses the pad, with the pointer captured', await pad.evaluate((el) => el.hasPointerCapture(1)));
    check('repeat: Release FX is enabled while a repeat is held', await releaseFx.isEnabled());
    await page.waitForTimeout(800);
    check('repeat: the engine took the gesture (a refusal lets the pad go)', (await pressed()) === 'true');
    await page.mouse.up();
    await waitPressed('false');
    check('repeat: letting go releases it', (await pressed()) === 'false' && (await releaseFx.isDisabled()));

    // A pointer cancel (the browser took the touch) releases it.
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await waitPressed('true');
    await pad.evaluate((el) => el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
    await waitPressed('false').catch(() => {});
    check('repeat: a pointer cancel releases it', (await pressed()) === 'false' && (await releaseFx.isDisabled()));
    await page.mouse.up();

    // Lost capture releases it. Chrome makes a capture active (gotpointercapture) only
    // on the next pointer event; releasing a capture that is still pending fires no
    // lostpointercapture at all, so move once and wait for the capture to be active.
    await page.mouse.move(at.x, at.y);
    await pad.evaluate((el) => {
      el.dataset.gotCapture = '';
      el.addEventListener('gotpointercapture', () => (el.dataset.gotCapture = '1'), { once: true });
    });
    await page.mouse.down();
    await waitPressed('true');
    await page.mouse.move(at.x + 1, at.y + 1);
    await page.waitForFunction((name) => document.querySelector(`[aria-label="${name}"]`)?.dataset.gotCapture === '1', PAD, T);
    await pad.evaluate((el) => el.releasePointerCapture(1));
    // Chrome delivers lostpointercapture with the next pointer event.
    await page.mouse.move(at.x + 2, at.y + 2);
    await waitPressed('false').catch(() => {});
    check('repeat: losing pointer capture releases it', (await pressed()) === 'false');
    await page.mouse.up();

    // The window losing focus releases it.
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await waitPressed('true');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitPressed('false').catch(() => {});
    check('repeat: the window losing focus releases it', (await pressed()) === 'false');
    await page.mouse.up();

    // The tab going hidden releases it.
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await waitPressed('true');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitPressed('false').catch(() => {});
    check('repeat: the tab going hidden releases it', (await pressed()) === 'false');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });
    await page.mouse.up();

    // The keyboard: Space and Enter hold while down and let go on keyup; the pad
    // losing focus ends a keyboard hold.
    for (const key of [' ', 'Enter']) {
      const name = key === ' ' ? 'Space' : 'Enter';
      await pad.focus();
      await page.keyboard.down(key);
      await waitPressed('true').catch(() => {});
      const down = await pressed();
      await page.keyboard.up(key);
      await waitPressed('false').catch(() => {});
      check(`repeat: ${name} holds it and its keyup releases it`, down === 'true' && (await pressed()) === 'false', `${down} then ${await pressed()}`);
    }
    await pad.focus();
    await page.keyboard.down('Enter');
    await waitPressed('true').catch(() => {});
    await pad.evaluate((el) => el.blur());
    await waitPressed('false').catch(() => {});
    check('repeat: the pad losing focus ends a keyboard hold', (await pressed()) === 'false');
    await page.keyboard.up('Enter');

    // A track change (pick another track while holding) releases it, and the new
    // track plays.
    await page.evaluate(() => document.activeElement?.blur());
    at = await center();
    await touch('touchStart', at);
    await waitPressed('true');
    const other = page.locator('#library .track-badge[aria-pressed="false"]').first();
    await other.click();
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, T).catch(() => {});
    await waitPressed('false').catch(() => {});
    check('repeat: loading another track releases it and plays the new one',
      (await pressed()) === 'false' && (await releaseFx.isDisabled())
        && (await page.locator('.app').getAttribute('data-playing')) === 'yes');
    await touch('touchEnd', at);

    // Release FX while a finger still holds the pad (focus elsewhere, so a focus
    // release cannot pass this for the wrong reason).
    await page.evaluate(() => document.activeElement?.blur());
    at = await center();
    await touch('touchStart', at);
    await waitPressed('true');
    await releaseFx.click();
    await waitPressed('false').catch(() => {});
    check('repeat: Release FX clears a held repeat', (await pressed()) === 'false' && (await releaseFx.isDisabled()));
    await touch('touchEnd', at);

    // Panic, likewise.
    await page.evaluate(() => document.activeElement?.blur());
    await touch('touchStart', at);
    await waitPressed('true');
    await page.getByRole('button', { name: 'Panic', exact: true }).click();
    await waitPressed('false').catch(() => {});
    // The transport shows stopped once the engine reports its Stop, a moment later.
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'no', null, T).catch(() => {});
    check('repeat: Panic clears a held repeat', (await pressed()) === 'false');
    // Intermittent in the full suite only (Night 10, Night 11: 1 of 2 suite runs, 0 of
    // 16 standalone). On a failure, say what the screen shows so the cause can be found.
    const afterPanic = await page.evaluate(() => ({
      playing: document.querySelector('.app')?.getAttribute('data-playing'),
      status: document.querySelector('.scene-status')?.textContent?.trim().slice(0, 120),
      play: document.querySelector('.play')?.getAttribute('aria-label'),
    }));
    check('repeat: Panic stops the transport', afterPanic.playing === 'no', afterPanic.playing === 'no' ? '' : JSON.stringify(afterPanic));
    await touch('touchEnd', at);

    // The division: picked, sent, remembered across a reload.
    await radio(16).click();
    await page.waitForFunction(() => window.__BCKGRND_SENT__?.().repeatDivision?.value === 16, null, T).catch(() => {});
    check('repeat: picking 1/16 reaches the engine', (await sent())?.value === 16, JSON.stringify(await sent()));
    check('repeat: and is remembered', (await page.evaluate((k) => localStorage.getItem(k), PREF_KEY)) === '16');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('article.stem');
    check('repeat: the division survives a reload', (await radio(16).getAttribute('aria-checked')) === 'true');
    check('repeat: the pad names its division', /1\/16/.test((await pad.textContent()) ?? ''), await pad.textContent());
    await page.evaluate((k) => localStorage.setItem(k, 'nonsense'), PREF_KEY);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('article.stem');
    check('repeat: a bad stored division falls back to 1/8', (await radio(8).getAttribute('aria-checked')) === 'true');
  } catch (e) {
    check('repeat: the walk-through ran to the end', false, String(e.message).split('\n')[0]);
  }
  check('repeat: no page errors', errors.length === 0, errors.join('; '));
  await page.close();
}

// ---- On its own: node tools/verify-ui-repeat.mjs [baseUrl] ---------------------
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
    await repeatChecks({ open, check });
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`\n${failures.length} repeat check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll repeat checks passed.');
}
