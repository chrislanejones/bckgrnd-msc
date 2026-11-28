/**
 * Night 11B: the Arrangement drawer, a read-only timeline of a take
 * (frontend/ui/ArrangementDrawer.tsx).
 *
 * At 1440: a take with a scene, a fill, a 2-bar Rise and a held Beat Repeat, recorded
 * through the UI; then the Timeline toggle in the Take events drawer opens the
 * arrangement (folded by default, aria-expanded, focus to its heading). Each kind is
 * in its lane; spans are as long as their onsets say; every marker sits at its onset
 * on a bar grid whose bar 1 is the first event's song bar; names read "Fill, Busy
 * beat, bar 5 beat 4"; a click inspects (describeEvent's label and song position, the
 * take bar); the arrows move between events; zoom changes the bar width and the label
 * density; Esc closes and gives focus back; the open state survives a reload.
 *
 * At 1440, 1280, 1180 and 900 with a mouse (and the 375 phone): the scenes toolbar is
 * 70px with the drawer open and closed, the page neither grows nor scrolls sideways,
 * and the drawer is inside the window; on touch, markers and zoom are 44px.
 *
 * Run by tools/verify-ui.mjs (arrangementChecks), or on its own:
 *   node tools/verify-ui-arrangement.mjs [baseUrl]
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RT = { timeout: 30000 };
const MOUSE_TOOLBAR_MAX = 70.5;
const SPARSE = 1;
const DROP = 3;

function kit(page) {
  const pad = (i) => page.locator('.scene-slot').nth(i).locator('.scene-pad');
  const play = async () => {
    if ((await page.locator('.app').getAttribute('data-playing')) === 'yes') return;
    await page.getByRole('button', { name: 'Play the track', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.getAttribute('data-playing') === 'yes', null, RT);
  };
  const events = () => page.evaluate(() => window.__BCKGRND_RECORDING__.recording()?.events ?? []);
  const waitFor = (kind, settled = false) =>
    page.waitForFunction(([k, s]) => (window.__BCKGRND_RECORDING__.recording()?.events ?? [])
      .some((e) => e.kind === k && (!s || (e.outcome ?? e.endedBy) !== 'open')), [kind, settled], RT);
  const record = async () => {
    await page.locator('.record-toggle').click();
    await page.waitForFunction(() => window.__BCKGRND_RECORDING__.state() === 'recording', null, RT);
  };
  const openTimeline = async () => {
    const events = page.getByRole('button', { name: 'Take events', exact: true });
    if ((await events.getAttribute('aria-expanded')) !== 'true') await events.click();
    await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    await page.waitForSelector('.arrangement:not([hidden])');
  };
  return { pad, play, events, waitFor, record, openTimeline };
}

const measure = (page) =>
  page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !el.getClientRects().length) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
    };
    return {
      pageH: document.documentElement.scrollHeight,
      pageW: document.documentElement.scrollWidth,
      toolbar: box('.scene-toolbar')?.h ?? null,
      drawer: box('.arrangement'),
    };
  });

/** Bar width as drawn: the step between bar lines, read from the custom property. */
const barPx = (page) => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.arrangement-scroll')).getPropertyValue('--bar-px')));

export async function arrangementChecks({ open, check }) {
  // ---- The walk-through at 1440 ------------------------------------------------------
  {
    const { page, errors } = await open(1440, 1000);
    const k = kit(page);
    let at = 'closed';
    try {
      check('arrangement: folded by default, nothing drawn', (await page.locator('.arrangement').isHidden())
        && (await page.evaluate(() => localStorage.getItem('bckgrnd-msc:arrangement-open'))) === null);

      at = 'record';
      await k.play();
      await k.record();
      await k.pad(SPARSE).click();
      await k.waitFor('scene');
      await page.locator('.fill-button').click();
      await k.waitFor('fill', true);
      const rise = page.getByRole('radio', { name: 'Rise into the scene over several bars' });
      if ((await rise.getAttribute('aria-checked')) !== 'true') await rise.click();
      await page.getByRole('radio', { name: 'Rise over 2 bars' }).click();
      await k.pad(DROP).click();
      await k.waitFor('rise', true);
      const repeatPad = page.getByRole('button', { name: 'Beat repeat, while held', exact: true });
      await repeatPad.scrollIntoViewIfNeeded();
      const rb = await repeatPad.boundingBox();
      await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
      await page.mouse.down();
      await k.waitFor('repeat');
      await page.waitForTimeout(600);
      await page.mouse.up();
      await k.waitFor('repeat', true);
      await page.locator('.record-toggle').click();
      await page.waitForFunction(() => window.__BCKGRND_RECORDING__.state() === 'stopped', null, RT);
      await page.evaluate(() => window.scrollTo(0, 0));

      at = 'open';
      const closed = await measure(page);
      await k.openTimeline();
      const toggle = page.getByRole('button', { name: 'Timeline', exact: true });
      const focus = await page.evaluate(() => ({ tag: document.activeElement?.tagName, inside: Boolean(document.activeElement?.closest('.arrangement')) }));
      check('arrangement: the Timeline toggle opens it (aria-expanded), focus to its heading',
        (await toggle.getAttribute('aria-expanded')) === 'true' && focus.tag === 'H2' && focus.inside
          && (await page.getByRole('region', { name: 'Arrangement', exact: true }).count()) === 1, JSON.stringify(focus));
      check('arrangement: headed Current take, and remembered as open',
        (await page.locator('.arrangement-source').textContent()) === 'Current take'
          && (await page.evaluate(() => localStorage.getItem('bckgrnd-msc:arrangement-open'))) === 'open');
      const opened = await measure(page);
      check('arrangement: open, the page is the same height and the toolbar the same 70px',
        opened.pageH === closed.pageH && opened.toolbar === closed.toolbar && opened.toolbar <= MOUSE_TOOLBAR_MAX && opened.pageW <= 1440,
        `page ${closed.pageH} -> ${opened.pageH}px, toolbar ${closed.toolbar} -> ${opened.toolbar}px`);
      check('arrangement: a bottom sheet inside the window', opened.drawer && opened.drawer.b <= 1000.5 && opened.drawer.x >= 0 && opened.drawer.r <= 1440, JSON.stringify(opened.drawer));

      at = 'lanes';
      const take = await k.events();
      const lanes = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.arrangement-lane')].map((l) =>
        [l.dataset.lane, [...l.querySelectorAll('.arrangement-marker')].map((m) => m.dataset.kind)])));
      check('arrangement: four lanes, Scenes, Fills, Rise and Repeat, and no Echo or Filter',
        JSON.stringify(Object.keys(lanes)) === '["scene","fill","rise","repeat"]', JSON.stringify(lanes));
      check('arrangement: the scene, the fill, the Rise and the repeat each in their lane',
        lanes.scene?.includes('scene') && lanes.fill?.includes('fill') && lanes.rise?.includes('rise') && lanes.repeat?.includes('repeat'), JSON.stringify(lanes));
      check('arrangement: one marker per event in the take', Object.values(lanes).flat().length === take.length, `${Object.values(lanes).flat().length} / ${take.length}`);

      // Positions: x = (onset + lead) * px per step, lead = the first event's step in its bar.
      const geo = await page.evaluate(() => {
        const pps = parseFloat(getComputedStyle(document.querySelector('.arrangement-scroll')).getPropertyValue('--step-px'));
        const track = document.querySelector('.arrangement-track').getBoundingClientRect().left;
        return {
          pps,
          markers: [...document.querySelectorAll('.arrangement-marker')].map((m) => {
            const b = m.parentElement.getBoundingClientRect();
            return { kind: m.dataset.kind, name: m.getAttribute('aria-label'), left: b.left - track, w: b.width, span: m.dataset.span === 'true' };
          }),
          bars: [...document.querySelectorAll('.arrangement-bar-number')].map((n) => n.textContent),
        };
      });
      const first = take.reduce((a, b) => (b.onset < a.onset ? b : a));
      const lead = (first.step % 16) - first.onset;
      const want = (e) => (e.onset + lead) * geo.pps;
      const byKind = (kind) => take.find((e) => e.kind === kind);
      const placedAt = (kind) => geo.markers.find((m) => m.kind === kind);
      const off = ['scene', 'fill', 'rise', 'repeat'].map((kind) => Math.abs(placedAt(kind).left - want(byKind(kind))));
      check('arrangement: every marker sits at its onset, bar 1 on the first event\'s song bar line',
        off.every((d) => d < 0.6), `off by ${off.map((d) => d.toFixed(1)).join('/')}px at ${geo.pps}px a step, lead ${lead}`);
      const spanOff = ['fill', 'rise', 'repeat'].map((kind) => Math.abs(placedAt(kind).w - (byKind(kind).endOnset - byKind(kind).onset) * geo.pps));
      check('arrangement: the fill, the Rise and the repeat are spans from onset to endOnset',
        spanOff.every((d) => d < 0.6), `off by ${spanOff.map((d) => d.toFixed(1)).join('/')}px`);
      check('arrangement: the Rise spans its 2 bars', Math.abs(placedAt('rise').w - 32 * geo.pps) < 0.6, `${placedAt('rise').w}px`);
      check('arrangement: bars are numbered 1 to N of the take', geo.bars[0] === '1' && geo.bars.length >= 3, geo.bars.join(' '));
      const names = geo.markers.map((m) => m.name);
      check('arrangement: markers are buttons named kind, what, bar and beat',
        names.every((n) => /^(Scene|Fill|Fill into|Rise|Repeat), .+, bar \d+ beat [1-4]$/.test(n)), names.join(' | '));

      at = 'inspect';
      const fillMarker = page.locator('.arrangement-marker[data-kind="fill"]').first();
      await fillMarker.click();
      const fillEvent = byKind('fill');
      const inspector = page.getByRole('region', { name: 'Selected event', exact: true });
      const said = await inspector.textContent();
      const want2 = await page.evaluate((seq) => {
        const e = window.__BCKGRND_RECORDING__.recording().events.find((x) => x.seq === seq);
        const beat = `Bar ${e.bar}.${e.beat}`;
        return { beat, pass: e.pass };
      }, fillEvent.seq);
      check('arrangement: a click selects it (aria-current) and the inspector shows it',
        (await fillMarker.getAttribute('aria-current')) === 'true' && /^Fill/.test(said) && said.includes(`Song${want2.beat}`) && /Take\s*Bar \d+\.\d/.test(said) && /Length16 steps · 1 bar/.test(said), said);
      check('arrangement: the inspector is a labeled region, not a live one',
        (await inspector.getAttribute('aria-live')) === null && (await page.locator('.arrangement-inspector [aria-live]').count()) === 0);
      await page.keyboard.press('ArrowRight');
      const next = await page.evaluate(() => ({ focus: document.activeElement?.getAttribute('aria-label'), current: document.querySelector('.arrangement-marker[aria-current="true"]')?.getAttribute('aria-label') }));
      // Time order as drawn: left edge, then lane (Scenes, Fills, Rise, Repeat).
      const laneOrder = ['scene', 'fillInto', 'fill', 'rise', 'repeat'];
      const inTime = [...geo.markers].sort((a, b) => a.left - b.left || laneOrder.indexOf(a.kind) - laneOrder.indexOf(b.kind));
      const fillName = placedAt('fill').name;
      const after = inTime[inTime.findIndex((m) => m.name === fillName) + 1]?.name;
      check('arrangement: ArrowRight moves to the next event in time, and selects it',
        next.focus === after && next.current === after, `${JSON.stringify(next)}, expected ${after}`);
      await page.keyboard.press('Home');
      const home = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      check('arrangement: Home goes to the first event', home === inTime[0].name, `${home} / ${inTime[0].name}`);
      const tabStops = await page.locator('.arrangement-marker[tabindex="0"]').count();
      check('arrangement: the lanes are one tab stop', tabStops === 1, `${tabStops}`);

      at = 'zoom';
      const w0 = await barPx(page);
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      const w1 = await barPx(page);
      await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
      await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
      const w2 = await barPx(page);
      check('arrangement: Zoom in widens a bar, Zoom out narrows it', w1 > w0 && w2 < w0, `${w0} -> ${w1} -> ${w2}px a bar`);
      const out = page.getByRole('button', { name: 'Zoom out', exact: true });
      for (let i = 0; i < 8 && (await out.getAttribute('aria-disabled')) !== 'true'; i++) await out.click();
      const dense = await page.evaluate(() => {
        const nums = [...document.querySelectorAll('.arrangement-bar-number')];
        return { px: parseFloat(getComputedStyle(document.querySelector('.arrangement-scroll')).getPropertyValue('--bar-px')), labels: nums.map((n) => n.textContent), gap: nums.length > 1 ? nums[1].getBoundingClientRect().left - nums[0].getBoundingClientRect().left : null };
      });
      // 8px a bar: labels every 4th bar (1, 5, 9...), still 32px apart.
      check('arrangement: zoomed all the way out, bar labels thin out and stay 32px apart',
        dense.px === 8 && dense.labels[0] === '1' && (dense.labels[1] === undefined || dense.labels[1] === '5') && (dense.gap === null || dense.gap >= 32)
          && (await page.getByRole('button', { name: 'Zoom out', exact: true }).getAttribute('aria-disabled')) === 'true',
        JSON.stringify(dense));
      // Ctrl + wheel over the lanes zooms in.
      const sb = await page.locator('.arrangement-scroll').boundingBox();
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await page.waitForFunction((before) => parseFloat(getComputedStyle(document.querySelector('.arrangement-scroll')).getPropertyValue('--bar-px')) > before, dense.px, { timeout: 3000 }).catch(() => {});
      check('arrangement: Ctrl and the wheel zoom too', (await barPx(page)) > dense.px, `${dense.px} -> ${await barPx(page)}px`);

      at = 'Esc';
      await page.locator('.arrangement-marker').first().focus();
      await page.keyboard.press('Escape');
      await page.waitForSelector('.arrangement[hidden]', { state: 'attached' });
      check('arrangement: Esc closes it and gives focus back to the Timeline toggle',
        (await page.evaluate(() => document.activeElement?.classList.contains('timeline-toggle'))) && (await toggle.getAttribute('aria-expanded')) === 'false');
      check('arrangement: Esc closed only it, not the events drawer under it', (await page.locator('.events-drawer').isVisible()));
    } catch (e) {
      check('arrangement: the walk-through ran to the end', false, `at ${at}: ${String(e.message).split('\n').slice(0, process.env.VERIFY_VERBOSE ? 14 : 1).join(' | ')}`);
    }
    check('arrangement: no page errors', errors.length === 0, errors.join('; '));
    await page.close();
  }

  // ---- Every width: toolbar 70px open and closed, no page scroll, in the window. ------
  for (const [w, h, extra] of [[1440, 900], [1280, 800], [1180, 800], [900, 800], [375, 667, { hasTouch: true, isMobile: true }]]) {
    const touch = Boolean(extra?.hasTouch);
    const { page, errors } = await open(w, h, extra ?? {});
    const k = kit(page);
    try {
      await k.play();
      await k.record();
      await k.pad(SPARSE).click();
      await k.waitFor('scene');
      await page.evaluate(() => window.scrollTo(0, 0));
      const closed = await measure(page);
      await k.openTimeline();
      await page.waitForSelector('.arrangement-marker');
      const opened = await measure(page);
      const pageMoved = opened.pageH !== closed.pageH || opened.pageW > w;
      console.log(`      arrangement ${w}px: sheet ${opened.drawer ? `${Math.round(opened.drawer.w)}x${Math.round(opened.drawer.h)} at y ${Math.round(opened.drawer.y)}` : 'missing'}; page ${closed.pageH} -> ${opened.pageH}px; toolbar ${closed.toolbar} -> ${opened.toolbar}px`);
      check(`${w}px arrangement: open, the page neither grows nor scrolls sideways`, !pageMoved, `page ${closed.pageH} -> ${opened.pageH}px, ${opened.pageW}px wide`);
      if (!touch) {
        check(`${w}px arrangement: the scenes toolbar is 70px, open and closed`,
          closed.toolbar <= MOUSE_TOOLBAR_MAX && opened.toolbar === closed.toolbar, `${closed.toolbar} / ${opened.toolbar}px`);
      }
      check(`${w}px arrangement: the sheet is inside the window`,
        opened.drawer && opened.drawer.x >= -0.5 && opened.drawer.r <= w + 0.5 && opened.drawer.b <= h + 0.5 && opened.drawer.y >= 0, JSON.stringify(opened.drawer));
      if (touch) {
        const small = await page.evaluate(() => [...document.querySelectorAll('.arrangement button')]
          .filter((b) => b.getClientRects().length && (b.getBoundingClientRect().width < 44 || b.getBoundingClientRect().height < 44))
          .map((b) => `${b.getAttribute('aria-label') ?? b.textContent.trim()} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`));
        check(`${w}px arrangement: every button in it is 44 x 44 or more`, small.length === 0, small.join(', '));
        const dock = await page.evaluate(() => {
          const d = document.querySelector('.phone-dock')?.getBoundingClientRect();
          const a = document.querySelector('.arrangement').getBoundingClientRect();
          return d ? a.bottom <= d.top + 0.5 : true;
        });
        check(`${w}px arrangement: it stops above the view dock`, dock);
        // Nothing in it past its own edges: the header's zoom and Close, the inspector.
        const spill = await page.evaluate(() => {
          const a = document.querySelector('.arrangement');
          const r = a.getBoundingClientRect();
          return [...a.querySelectorAll('.arrangement-head *, .arrangement-inspector, .arrangement-scroll')]
            .filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > r.right + 0.5)
            .map((el) => `${el.getAttribute('aria-label') ?? el.className} ${Math.round(el.getBoundingClientRect().right)}`)
            .concat(a.scrollWidth > a.clientWidth + 0.5 ? [`sheet scrollWidth ${a.scrollWidth}`] : []);
        });
        check(`${w}px arrangement: nothing spills past the sheet (zoom and Close in reach)`, spill.length === 0, spill.join(', '));
      }
    } catch (e) {
      check(`${w}px arrangement: the walk-through ran to the end`, false, String(e.message).split('\n')[0]);
    }
    check(`${w}px arrangement: no page errors`, errors.length === 0, errors.join('; '));
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
    await arrangementChecks({ open, check });
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`\n${failures.length} arrangement check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll arrangement checks passed.');
}
