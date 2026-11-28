/**
 * Night 11 layout: the take's events drawer, and Fill length's place in the scenes header.
 *
 * The drawer (frontend/ui/EventsDrawer.tsx): folded by default; a disclosure beside the
 * Record dot with aria-expanded; opening it lands focus in a region named "Take events";
 * Esc closes it and gives focus back; the open state survives a reload; it never moves
 * the page (same height closed and open, the scenes toolbar stays 70px) and stays in the
 * window at every width; Export is unavailable, with its reason, until there is a take;
 * after a scene change is recorded its row is there, newest first, and Export downloads
 * the take as JSON.
 *
 * Fill length: Bar / Beat joined to the Fill style menu as one 24px pill with a mouse
 * (44 x 44 on touch), radios side by side, the header extras on one row, the status line
 * with room to read, and the Shift 1–4 tag only where the panel has room for it (1440).
 *
 * Run by tools/verify-ui.mjs (drawerChecks), or on its own:
 *   node tools/verify-ui-drawer.mjs [baseUrl]
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RT = { timeout: 30000 };
const MOUSE_TOOLBAR_MAX = 70.5;
const SPARSE = 1;

/** What the page, the toolbar, the drawer and the toggle measure right now. */
const measure = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !el.getClientRects().length) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
    };
    const toggle = document.querySelector('.events-toggle');
    const t = toggle?.getBoundingClientRect();
    // Hit-tested at its middle: nothing in the bar sits over it.
    const hit = t ? document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2) : null;
    const title = document.querySelector('.now-title .truncate');
    return {
      pageH: document.documentElement.scrollHeight,
      pageW: document.documentElement.scrollWidth,
      toolbar: box('.scene-toolbar')?.h ?? null,
      drawer: box('.events-drawer'),
      toggle: box('.events-toggle'),
      toggleHit: Boolean(hit && toggle?.contains(hit)),
      titleCut: title ? title.scrollWidth - title.clientWidth : 0,
      transport: box('.transport'),
    };
  });

export async function drawerChecks({ open, check }) {
  // ---- The walk-through at 1440: closed, open, Esc, the pref, Export, a recorded row.
  {
    const { page, errors } = await open(1440, 900);
    const toggle = page.getByRole('button', { name: 'Take events', exact: true });
    const region = page.getByRole('region', { name: 'Take events', exact: true });
    let at = 'closed';
    try {
      const closed = await measure(page);
      check('events: a Take events disclosure beside the Record dot, folded by default',
        (await toggle.count()) === 1 && (await toggle.getAttribute('aria-expanded')) === 'false'
          && (await page.locator('.record .events-toggle').count()) === 1 && closed.drawer === null && (await region.count()) === 0);
      check('events: it controls the drawer by id', (await toggle.getAttribute('aria-controls')) === (await page.locator('.events-drawer').getAttribute('id')));

      at = 'open';
      await toggle.click();
      await region.waitFor(RT);
      const opened = await measure(page);
      const focus = await page.evaluate(() => {
        const a = document.activeElement;
        return { tag: a?.tagName, inside: Boolean(a?.closest('.events-drawer')), text: a?.textContent?.trim() };
      });
      check('events: opening it says so (aria-expanded) and moves focus to its heading, in the region',
        (await toggle.getAttribute('aria-expanded')) === 'true' && focus.tag === 'H2' && focus.inside, JSON.stringify(focus));
      check('events: open, the page is the same height and the toolbar the same 70px (an overlay, no scroll added)',
        opened.pageH === closed.pageH && opened.toolbar === closed.toolbar && closed.toolbar <= MOUSE_TOOLBAR_MAX,
        `page ${closed.pageH} -> ${opened.pageH}px, toolbar ${closed.toolbar} -> ${opened.toolbar}px`);
      check('events: it sits under the transport, inside the window',
        opened.drawer && opened.drawer.y >= opened.transport.b - 0.5 && opened.drawer.b <= 900 && opened.drawer.r <= 1440 && opened.drawer.x >= 0,
        JSON.stringify(opened.drawer));

      const exp = page.getByRole('button', { name: 'Export', exact: true });
      const reason = await exp.evaluate((b) => document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent ?? '');
      check('events: with no take, Export is unavailable and says why',
        (await exp.getAttribute('aria-disabled')) === 'true' && /No take yet/.test(reason), reason);
      check('events: with no take there are no rows', (await page.locator('.events-row').count()) === 0);

      at = 'Esc';
      await page.locator('.events-action').first().focus();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('.events-drawer')?.hidden === true, null, RT);
      check('events: Esc from inside closes it and gives focus back to the toggle',
        (await toggle.getAttribute('aria-expanded')) === 'false'
          && (await page.evaluate(() => document.activeElement?.classList.contains('events-toggle'))));

      at = 'remembered';
      await toggle.click();
      await region.waitFor(RT);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('article.stem');
      check('events: the open state survives a reload (bckgrnd-msc:events-open)',
        (await toggle.getAttribute('aria-expanded')) === 'true' && (await region.isVisible())
          && (await page.evaluate(() => localStorage.getItem('bckgrnd-msc:events-open'))) === 'open');
      check('events: reopened by a reload, it does not take focus', !(await page.evaluate(() => Boolean(document.activeElement?.closest('.events-drawer')))));
      await page.getByRole('button', { name: 'Close the take events' }).click();
      check('events: Close folds it and remembers', (await toggle.getAttribute('aria-expanded')) === 'false'
        && (await page.evaluate(() => localStorage.getItem('bckgrnd-msc:events-open'))) === 'closed');

      at = 'record a scene change';
      await page.getByRole('button', { name: 'Play the track', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, RT);
      await page.locator('.record-toggle').click();
      await page.waitForFunction(() => window.__BCKGRND_RECORDING__.state() === 'recording', null, RT);
      await toggle.click();
      await region.waitFor(RT);
      check('events: recording with nothing applied yet, it says so', /Nothing applied yet/.test(await page.locator('.events-empty').textContent()));
      await page.locator('.scene-slot').nth(SPARSE).locator('.scene-pad').click();
      await page.waitForFunction(() => document.querySelectorAll('.events-row').length >= 1, null, RT);
      const row = await page.locator('.events-row').first().evaluate((li) => ({
        kind: li.querySelector('.events-kind')?.textContent,
        what: li.querySelector('.events-what')?.textContent,
        pos: li.querySelector('.events-pos')?.textContent,
        // As read: the aria-hidden number left out.
        text: (() => { const c = li.cloneNode(true); c.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove()); return c.textContent; })(),
      }));
      check('events: the recorded scene change is a row: kind, what and where',
        /Scene$/.test(row.kind ?? '') && /Sparse$/.test(row.what ?? '') && /Bar \d+\.\d/.test(row.pos ?? ''), JSON.stringify(row));
      check('events: a screen reader hears the row as one sentence', /^Event 1: Scene, Sparse, at Bar \d+\.\d/.test(row.text ?? ''), row.text);
      check('events: the summary counts it while recording', /^Recording · 1 event$/.test((await page.locator('.events-summary').textContent()) ?? ''));
      const after = await measure(page);
      check('events: a row arriving moves nothing on the page', after.pageH === (await page.evaluate(() => document.documentElement.scrollHeight)) && after.toolbar <= MOUSE_TOOLBAR_MAX);

      at = 'export';
      check('events: with a take, Export is available', (await exp.getAttribute('aria-disabled')) === null);
      const [download] = await Promise.all([page.waitForEvent('download', RT), exp.click()]);
      const file = await download.path();
      const doc = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
      check('events: Export downloads the take as JSON',
        /\.json$/.test(download.suggestedFilename()) && doc?.format === 'bckgrnd-msc/performance' && doc.events?.length >= 1,
        `${download.suggestedFilename()}: ${doc?.events?.length} events`);

      at = 'stop and clear';
      await page.locator('.record-toggle').click();
      await page.waitForFunction(() => window.__BCKGRND_RECORDING__.state() === 'stopped', null, RT);
      const clear = region.getByRole('button', { name: /^Clear the take/ });
      check('events: stopped, the drawer offers Clear', (await clear.count()) === 1);
      await clear.click();
      check('events: Clear empties it; Export is unavailable again',
        (await page.evaluate(() => window.__BCKGRND_RECORDING__.state())) === 'idle' && (await page.locator('.events-row').count()) === 0
          && (await exp.getAttribute('aria-disabled')) === 'true');
    } catch (e) {
      check('events: the walk-through ran to the end', false, `at ${at}: ${String(e.message).split('\n')[0]}`);
    }
    check('events: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Every width: the toggle in reach, the drawer inside the window, nothing moved;
  // and Fill length joined to Fill style on one header row. ---------------------------
  const widths = [[1440, 900], [1280, 800], [1180, 800], [900, 800], [375, 667, { hasTouch: true, isMobile: true }],
    [320, 640, { hasTouch: true, isMobile: true }]];
  for (const [w, h, extra] of widths) {
    const touch = Boolean(extra?.hasTouch);
    const { page, errors } = await open(w, h, extra ?? {});
    try {
      const closed = await measure(page);
      const min = touch ? 44 : 32;
      check(`${w}px events: the toggle is on screen, ${min}px, nothing over it`,
        closed.toggle && closed.toggle.w >= min && closed.toggle.h >= min && closed.toggle.r <= w && closed.toggle.b <= closed.transport.b + 0.5 && closed.toggleHit,
        JSON.stringify(closed.toggle));
      if (w > 375) check(`${w}px events: the track name isn't cut for it`, closed.titleCut <= 0, `${closed.titleCut}px cut`);
      // On the phone it sits out of flow in the position row, under the Record dot: clear
      // of the part chips and the meter, and the bar no taller than its 7.75rem.
      const clear = await page.evaluate(() => {
        const t = document.querySelector('.events-toggle').getBoundingClientRect();
        const hits = ['.song-position', '.master-meter', '.now-playing', '.save-status', '.inspector-toggle', '.record-toggle']
          .filter((sel) => {
            const el = document.querySelector(sel);
            if (!el || !el.getClientRects().length) return false;
            const b = el.getBoundingClientRect();
            return t.left < b.right - 0.5 && b.left < t.right - 0.5 && t.top < b.bottom - 0.5 && b.top < t.bottom - 0.5;
          });
        return hits;
      });
      check(`${w}px events: the toggle overlaps nothing in the bar`, clear.length === 0, clear.join(', '));
      await page.locator('.events-toggle').click();
      await page.waitForSelector('.events-drawer:not([hidden])');
      const opened = await measure(page);
      check(`${w}px events: open, the page neither grows nor scrolls sideways`,
        opened.pageH === closed.pageH && opened.pageW <= w && opened.toolbar === closed.toolbar,
        `page ${closed.pageH} -> ${opened.pageH}px, ${opened.pageW}px wide`);
      check(`${w}px events: the drawer is inside the window, under the bar`,
        opened.drawer && opened.drawer.x >= 0 && opened.drawer.r <= w + 0.5 && opened.drawer.b <= h + 0.5 && opened.drawer.y >= opened.transport.b - 1.5,
        JSON.stringify(opened.drawer));
      if (touch) {
        const small = await page.evaluate(() => [...document.querySelectorAll('.events-drawer button')]
          .filter((b) => b.getClientRects().length && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44))
          .map((b) => `${b.getAttribute('aria-label') ?? b.textContent.trim()} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`));
        check(`${w}px events: every drawer button is 44 x 44 or more`, small.length === 0, small.join(', '));
      }
      if (!touch) check(`${w}px events: the scenes toolbar stays two 32px rows (${MOUSE_TOOLBAR_MAX}px)`, closed.toolbar <= MOUSE_TOOLBAR_MAX, `${closed.toolbar}px`);

      const fill = await page.evaluate(() => {
        const b = (el) => el?.getBoundingClientRect();
        const radios = [...document.querySelectorAll('.scene-fill-length [role="radio"]')].map(b);
        const select = b(document.querySelector('.fill-style-select'));
        const actions = b(document.querySelector('.scenes-panel .panel-actions'));
        const head = b(document.querySelector('.scenes-panel .panel-head'));
        // The room the status line gets: it is empty at rest, so fill it with a long
        // outcome, measure, and put it back.
        const line = document.querySelector('.scene-status');
        const was = line.textContent;
        line.textContent = 'Drop queued · Bar 9 · lands on the bar line after this one';
        const status = b(line);
        line.textContent = was;
        const keys = document.querySelector('.scene-keys');
        return {
          side: radios.length === 2 && Math.abs(radios[0].top - radios[1].top) < 1 && radios[1].left > radios[0].left,
          h: Math.min(...radios.map((r) => r.height)),
          w: Math.min(...radios.map((r) => r.width)),
          joined: radios.length ? Math.round(radios[0].left - select.right) : null,
          sameRow: radios.length ? Math.abs(radios[0].top + radios[0].height / 2 - (select.top + select.height / 2)) < 1 : false,
          actionsH: Math.round(actions.height),
          headH: Math.round(head.height),
          status: Math.round(status.width),
          keys: Boolean(keys && keys.getClientRects().length),
          right: Math.max(...radios.map((r) => r.right)),
        };
      });
      console.log(`      fill length ${w}px: radios ${fill.w}x${fill.h}, joined ${fill.joined}px, header ${fill.headH}px (extras ${fill.actionsH}px), status ${fill.status}px, Shift tag ${fill.keys ? 'shown' : 'hidden'}`);
      check(`${w}px fill length: Bar and Beat side by side, on the Fill style menu's row`, fill.side && fill.sameRow && fill.right <= w);
      if (touch) {
        check(`${w}px fill length: 44 x 44 on touch`, fill.w >= 44 && fill.h >= 44, `${fill.w}x${fill.h}`);
        check(`${w}px events: the transport keeps its height (7.75rem and the top inset)`, Math.abs(closed.transport.h - 132) <= 1, `${closed.transport.h}px`);
      } else {
        check(`${w}px fill length: one 24px pill with the menu (joined, the extras one row)`,
          fill.h >= 24 && fill.h <= 26 && Math.abs(fill.joined + 1) <= 1 && fill.actionsH <= 26, `${fill.w}x${fill.h}, joined ${fill.joined}, extras ${fill.actionsH}px`);
        check(`${w}px fill length: the status line keeps room to read (100px or more)`, fill.status >= 100, `${fill.status}px`);
        check(`${w}px fill length: the Shift 1–4 tag ${w >= 1440 ? 'shows' : 'gives its room up'}`, fill.keys === (w >= 1440));
      }
    } catch (e) {
      check(`${w}px events: the walk-through ran to the end`, false, String(e.message).split('\n')[0]);
    }
    check(`${w}px events: no page errors`, errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Fill length with the keyboard: one tab stop, the arrows move the choice. ------
  {
    const { page, errors } = await open(1280, 800);
    try {
      const bar = page.getByRole('radiogroup', { name: 'Fill length', exact: true }).getByRole('radio', { name: 'Bar', exact: true });
      const tabs = await page.evaluate(() => [...document.querySelectorAll('.scene-fill-length [role="radio"]')].map((r) => r.tabIndex).join(','));
      check('fill length: one tab stop, on the checked radio', tabs === '0,-1', tabs);
      await bar.focus();
      await page.keyboard.press('ArrowRight');
      const now = await page.evaluate(() => ({
        checked: document.querySelector('.scene-fill-length [aria-checked="true"]')?.textContent,
        focus: document.activeElement?.textContent,
        pref: localStorage.getItem('bckgrnd-msc:fill-length'),
      }));
      check('fill length: ArrowRight picks Beat and moves focus with it', now.checked === 'Beat' && now.focus === 'Beat' && now.pref === 'beat', JSON.stringify(now));
      await page.keyboard.press('ArrowLeft');
      check('fill length: ArrowLeft goes back to Bar', (await page.evaluate(() => localStorage.getItem('bckgrnd-msc:fill-length'))) === 'bar');
    } catch (e) {
      check('fill length: the keyboard walk-through ran to the end', false, String(e.message).split('\n')[0]);
    }
    check('fill length: no page errors', errors.length === 0, errors.join('; '));
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
    await page.evaluate(() => document.fonts.ready);
    return { page, errors };
  };
  try {
    await drawerChecks({ open, check });
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`\n${failures.length} drawer check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll drawer checks passed.');
}
