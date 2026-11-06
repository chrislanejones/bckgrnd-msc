import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const cdp = process.env.NATIVE_CDP;
const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch();
try {
  const page = cdp ? browser.contexts()[0].pages()[0] : await browser.newPage();
  page.setDefaultTimeout(10000);
  if (cdp) {
    // Electron intentionally refuses a dirty page reload. Commit this acceptance
    // fixture before reloading to install the AudioContext instrumentation.
    if (!await page.getByRole('dialog', { name: 'Projects', exact: true }).isVisible())
      await page.getByRole('button', { name: /^Projects ·/ }).click();
    await page.getByRole('button', { name: 'Save project', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Saved '));
  }
  await page.addInitScript(() => {
    const Original = window.AudioContext;
    window.__releaseContexts = [];
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.__releaseContexts.push(this); }
    };
  });
  page.on('dialog', (dialog) => void dialog.accept().catch(() => {}));
  if (cdp) await page.reload();
  else await page.goto(process.argv[2] ?? 'http://127.0.0.1:8080');
  await page.getByRole('button', { name: 'Play the track', exact: true }).click();
  // The transport updates optimistically before the worklet's first telemetry.
  // Interrupt only once real output has reached the meter, not during startup.
  await page.waitForFunction(() => document.querySelector('.app')?.dataset.playing === 'yes'
    && [...document.querySelectorAll('.master-meter-fill')].some(el => {
      const level = Number(el.style.transform.match(/scaleX\(([^)]+)\)/)?.[1]);
      return level > 0;
    }), {}, { timeout: 8000 });
  const project = await page.evaluate(() => window.__BCKGRND_PROJECT__());
  await page.evaluate(async () => {
    const context = window.__releaseContexts[0];
    await context.suspend();
    window.__realResume = context.resume;
    context.resume = async () => { throw new Error('Test output device unavailable'); };
  });
  await page.getByRole('button', { name: 'Resume Audio', exact: true }).waitFor();
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  await page.getByRole('button', { name: 'Resume Audio', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Test output device unavailable' }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__BCKGRND_PROJECT__()), project);
  await page.evaluate(() => { window.__releaseContexts[0].resume = window.__realResume; });
  await page.getByRole('button', { name: 'Resume Audio', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.app')?.dataset.playing === 'yes' && !document.querySelector('.audio-error'));
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Stop the track', exact: true }).click();
    await page.getByRole('button', { name: 'Play the track', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.app')?.dataset.playing === 'yes');
  }
  await page.getByRole('button', { name: 'Stop the track', exact: true }).click();
  console.log(`PASS ${cdp ? 'installed desktop' : 'browser'}: interruption stops transport indication; failed resume preserves composition; Resume Audio reconnects; repeated start/stop. Physical sleep/device changes remain separate.`);
} finally { await browser.close(); }
