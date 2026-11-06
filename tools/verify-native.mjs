/** Installed Linux/X11 acceptance. Test tools are not runtime dependencies. */
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, openSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const binary = realpathSync(process.env.NATIVE_BINARY ?? `${process.env.HOME}/.local/bin/bckgrnd-msc`);
const xdo = (...args) => execFileSync(process.env.XDOTOOL ?? 'xdotool', args.map(String), { encoding: 'utf8' }).trim();
const dir = mkdtempSync(join(tmpdir(), 'bckgrnd native café '));
const closer = join(dir, 'close-window');
execFileSync('cc', ['tools/native-close.c', '-o', closer, '-lX11']);
const input = join(dir, 'browser-project.bckgrnd.json');
writeFileSync(input, readFileSync(process.env.BROWSER_PROJECT ?? 'tests/fixtures/release/edited.bckgrnd.json'));
const port = Number(process.env.NATIVE_DEBUG_PORT ?? 9224);
let priorClipboard;
try { priorClipboard = execFileSync('xclip', ['-selection', 'clipboard', '-out'], { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { priorClipboard = Buffer.alloc(0); }
let child, browser, page;
const poll = async (fn, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { const r = await fn(); if (r) return r; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Native test condition timed out');
};
const windowId = (name) => {
  const ids = xdo('search', '--name', `^${name}$`).split('\n');
  return ids.find(id => Number(xdo('getwindowgeometry', '--shell', id).match(/WIDTH=(\d+)/)?.[1]) > 300);
};
const closeWindow = () => execFileSync(closer, [windowId('bckgrnd-msc')]);
async function launch() {
  const args = ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`];
  const wrapped = process.env.BWRAP;
  const command = wrapped ?? binary;
  const commandArgs = wrapped ? ['--bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--tmpfs', resolve('.'), '--chdir', dir, binary, ...args] : args;
  child = spawn(command, commandArgs, { cwd: dir, env: { ...process.env, PATH: '/usr/bin:/bin' }, stdio: ['ignore', openSync(join(dir, 'app.log'), 'a'), openSync(join(dir, 'app.log'), 'a')] });
  await poll(() => fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok), 20000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await poll(() => browser.contexts()[0]?.pages()[0]);
  await page.waitForFunction(() => !!window.__BCKGRND_PROJECT__?.(), {}, { timeout: 20000 });
  const origin = new URL(page.url()).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert(await page.evaluate(() => isSecureContext && !!window.BckgrndDesktop));
}
async function fileDialog(title, path) {
  const id = await poll(() => windowId(title));
  const geometry = xdo('getwindowgeometry', '--shell', id);
  assert(!/X=-|Y=-/.test(geometry), `Native dialog is off screen: ${geometry}`);
  if (path === null) {
    const width = Number(geometry.match(/WIDTH=(\d+)/)[1]);
    const height = Number(geometry.match(/HEIGHT=(\d+)/)[1]);
    xdo('mousemove', '--window', id, width - 140, height - 24, 'click', 1); return;
  }
  // Activate the native GTK chooser before typing its standard location shortcut.
  xdo('mousemove', '--window', id, 350, 140, 'click', 1, 'key', 'ctrl+l');
  // XTest's legacy keymap loses non-ASCII characters; GTK clipboard paste keeps
  // the exact UTF-8 path. Restore the prior clipboard after the acceptance run.
  execFileSync('xclip', ['-selection', 'clipboard', '-in'], { input: path, stdio: ['pipe', 'ignore', 'ignore'] });
  xdo('key', 'ctrl+a', 'ctrl+v');
  // Clipboard selection transfer is asynchronous in GTK; let that transfer finish
  // before activating Select. The application outcome is separately event-driven.
  await new Promise(resolve => setTimeout(resolve, 200));
  xdo('mousemove', '--window', id, Number(geometry.match(/WIDTH=(\d+)/)[1]) - 50, Number(geometry.match(/HEIGHT=(\d+)/)[1]) - 24, 'click', 1);
}
const menu = () => page.getByRole('button', { name: /^Projects ·/ }).click();
const status = (text) => page.waitForFunction(t => document.querySelector('[data-testid="project-status"]')?.textContent?.includes(t), text);
try {
  await launch(); await menu();
  await page.getByRole('button', { name: 'Import project file', exact: true }).click();
  await fileDialog('Open Project', input); await status('Opened ');
  await page.getByRole('button', { name: 'Close projects', exact: true }).click();
  await page.getByRole('button', { name: 'Edit patterns', exact: true }).click();
  await page.locator('[data-drum-cell][data-lane="clap"][data-step="2"]').click();
  await page.getByRole('button', { name: 'Bass', exact: true }).click();
  await page.locator('.roll-note').first().focus(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  const composition = await page.evaluate(() => window.__BCKGRND_PROJECT__());
  await page.getByRole('button', { name: 'Play the track', exact: true }).click();
  await page.getByRole('button', { name: 'Launch Full', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.scene-slot')[0]?.dataset.state === 'active');
  await page.getByRole('button', { name: 'Launch Drop', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel scene', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.scene-status')?.textContent?.includes('previous mix restored'));
  assert.deepEqual(await page.evaluate(() => window.__BCKGRND_PROJECT__()), composition);
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'yes');
  await menu(); await page.getByLabel('Project name', { exact: true }).fill('Night 6 Linux café');
  await page.getByRole('button', { name: 'Save project', exact: true }).click(); await status('Saved ');
  await page.getByRole('button', { name: 'Import project file', exact: true }).click();
  await fileDialog('Open Project', null);
  assert.deepEqual(await page.evaluate(() => window.__BCKGRND_PROJECT__()), composition);
  // Native save failure must keep the window, memory and prior committed revision.
  await page.getByLabel('Project name', { exact: true }).fill('Close recovery café');
  await page.route('**/api/native/projects/write', r => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Injected disk full' }) }));
  closeWindow(); await status('Save failed:'); assert(!page.isClosed());
  assert.deepEqual(await page.evaluate(() => window.__BCKGRND_PROJECT__()), composition);
  await page.unroute('**/api/native/projects/write');
  // Keep-open and cancel-and-quit both use an actual close request during a job.
  await page.route('**/wasm/**', async r => { await new Promise(resolve => setTimeout(resolve, 500)); await r.continue().catch(() => {}); });
  await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
  const dialog = page.waitForEvent('dialog'); closeWindow();
  const keep = await dialog; assert(keep.message().includes('Cancel export and quit')); await keep.dismiss();
  assert(!page.isClosed());
  const quitDialog = page.waitForEvent('dialog'); closeWindow();
  await (await quitDialog).accept();
  await page.waitForEvent('close', { timeout: 15000 });
  await poll(() => child.exitCode !== null); await browser.close();
  // Reinstall/relaunch uses the same persistent directory, never autoplay.
  await launch(); await menu();
  await page.locator('li', { hasText: 'Close recovery café' }).getByRole('button', { name: 'Open', exact: true }).click();
  await status('Opened '); assert.deepEqual(await page.evaluate(() => window.__BCKGRND_PROJECT__()), composition);
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  await page.getByLabel('Project name', { exact: true }).fill('Night 6 Linux café');
  await page.getByRole('button', { name: 'Save As', exact: true }).click();
  const savedFile = join(dir, 'native-saved.bckgrnd.json');
  await fileDialog('Save Project As', savedFile); await status('Saved ');
  await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
  const wav = join(dir, 'native-export.wav');
  await fileDialog('Export WAV', wav); await status('Exported ');
  const bytes = readFileSync(wav); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert(bytes.subarray(44).some(b => b));
  const diagnostics = await page.evaluate(async () => (await fetch('/api/native/projects/diagnostics', { method: 'POST', headers: { 'X-Bckgrnd-Token': document.querySelector('meta[name="bckgrnd-native-token"]').content } })).json());
  assert(diagnostics.php.startsWith('8.4.')); assert(!diagnostics.storage.startsWith(binary));
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ binary, checkoutHidden: !!process.env.BWRAP, diagnostics, savedFile, wav, bytes: bytes.length }, null, 2));
  console.log(`PASS installed Linux: native import/cancel/save-as/export, edited drums+bass, Full → Drop → Cancel, failed-save close, keep-open/cancel-export quit, persistent reopen without autoplay. ${dir}`);
} finally {
  if (browser) await browser.close();
  execFileSync('xclip', ['-selection', 'clipboard', '-in'], { input: priorClipboard, stdio: ['pipe', 'ignore', 'ignore'] });
}
