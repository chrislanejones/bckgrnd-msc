import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const bundle = await build({ entryPoints: ['frontend/lib/snapshot.ts'], bundle: true, format: 'esm', write: false });
const { readSnapshot } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const library = JSON.parse(readFileSync('public/library/index.json', 'utf8'));
const source = async (id) => JSON.parse(readFileSync(`public/library/${id}.json`, 'utf8')).track;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.on('dialog', (d) => void d.accept());
const base = process.argv[2] ?? 'http://127.0.0.1:8080';
const temp = mkdtempSync(join(tmpdir(), 'bckgrnd projects é '));
const project = () => page.evaluate(() => window.__BCKGRND_PROJECT__());
const menu = () => page.getByRole('button', { name: /^Projects ·/ }).click();
const close = () => page.getByRole('button', { name: 'Close projects', exact: true }).click();
const save = async () => {
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Saved '));
};
const file = async () => {
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download project file', exact: true }).click();
  const d = await downloaded; const path = join(temp, d.suggestedFilename()); await d.saveAs(path);
  return JSON.parse(readFileSync(path, 'utf8'));
};

try {
  await page.goto(base); await page.waitForFunction(() => !!window.__BCKGRND_PROJECT__?.());
  // Import portable accepted composition before editing and saving it.
  await menu();
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/release/edited.bckgrnd.json');
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Opened '));
  await close();
  await page.getByRole('button', { name: 'Edit patterns', exact: true }).click();
  await page.locator('[data-drum-cell][data-lane="clap"][data-step="1"]').click();
  await page.getByRole('button', { name: 'Bass', exact: true }).click();
  const note = page.locator('.roll-note').first(); await note.focus(); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  const bassFader = page.locator('article.stem[aria-labelledby="stem-bass"] input[type=range]');
  await bassFader.focus(); await page.keyboard.press('ArrowDown');
  await page.locator('.scene-slot').nth(0).locator('.scene-menu-button').click();
  await page.getByRole('button', { name: 'Capture current mix', exact: true }).click();
  const original = await project();
  await menu(); await page.getByLabel('Project name', { exact: true }).fill('Night 6 café');
  await save(); const first = await file(); assert.equal(first.project.name, 'Night 6 café');
  await close();
  // A playing Full then Drop shares the original return point. Cancel must
  // restore patterns as well as mix, keep playing, and prevent a queued landing.
  await page.getByRole('button', { name: 'Play the track', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.app')?.dataset.playing === 'yes');
  await page.getByRole('button', { name: 'Launch Full', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.scene-slot')[0]?.dataset.state === 'active');
  await page.getByRole('button', { name: 'Launch Drop', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel scene', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.scene-status')?.textContent?.includes('previous mix restored'));
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'yes');
  assert.deepEqual(await project(), original);
  await menu(); await save(); const restored = await file();
  await readSnapshot(restored, library.tracks, source);
  await page.getByRole('button', { name: 'Close projects', exact: true }).click();
  await page.getByRole('button', { name: 'Stop the track', exact: true }).click();
  await page.reload(); await page.waitForFunction(() => !!window.__BCKGRND_PROJECT__?.());
  await menu(); await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Opened '));
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  assert.deepEqual(await project(), original);
  // Failed save cannot destroy the committed revision or the in-memory work.
  await page.getByLabel('Project name', { exact: true }).fill('Unsaved work');
  await page.evaluate(() => { window.__originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = () => { throw new Error('Injected disk full'); }; });
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.includes('Save failed:'));
  assert.equal((await file()).project.name, 'Unsaved work');
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalPut; });
  await save();
  // Cancellation publishes no partial WAV.
  let downloads = 0; const onDownload = () => downloads++; page.on('download', onDownload);
  await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
  await page.getByRole('button', { name: /^Cancel export/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.includes('Export cancelled'));
  assert.equal(downloads, 0); page.off('download', onDownload);
  const exporting = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
  const d = await Promise.race([exporting, page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Export failed:')).then(async () => { throw new Error(await page.locator('[data-testid="project-status"]').textContent()); })]); const wav = join(temp, 'export.wav'); await d.saveAs(wav);
  const bytes = readFileSync(wav); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(40), bytes.length - 44); assert(bytes.subarray(44).some((b) => b !== 0));
  // Import migration leaves the original file unchanged and opens stopped.
  const older = readFileSync('tests/fixtures/contract/v1-sparse.input.json', 'utf8');
  await page.locator('input[type=file]').setInputFiles('tests/fixtures/contract/v1-sparse.input.json');
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Opened '));
  assert.equal((await file()).project.version, 3);
  assert.equal(readFileSync('tests/fixtures/contract/v1-sparse.input.json', 'utf8'), older);
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  await close();
  // A candidate may sound, but saving still records accepted working patterns.
  await page.getByRole('button', { name: 'Edit patterns', exact: true }).click();
  await page.getByRole('button', { name: 'Closed hat', exact: true }).click();
  const accepted = await project();
  await page.getByRole('button', { name: 'Humanize', exact: true }).click();
  await page.getByRole('group', { name: 'Humanize' }).getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('.preview-bar').waitFor();
  await menu(); await page.getByLabel('Project name', { exact: true }).fill('Preview accepted'); await save(); assert.deepEqual((await file()).project.patterns, accepted.patterns);
  // Recover a later unsaved revision explicitly after a reload, never autoplay.
  await page.getByLabel('Project name', { exact: true }).fill('Recovery café');
  await page.waitForFunction(async () => new Promise((resolve) => {
    const r = indexedDB.open('bckgrnd-projects', 1);
    r.onsuccess = () => { const q = r.result.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => { resolve(q.result.some((x) => x.recovery?.project.name === 'Recovery café')); r.result.close(); }; };
  }));
  await page.reload(); await page.waitForFunction(() => !!window.__BCKGRND_PROJECT__?.()); await menu();
  await page.locator('li', { hasText: 'Preview accepted' }).getByRole('button', { name: /^Recover r/ }).last().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.includes('Opened Recovery café'));
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  assert.deepEqual((await file()).project.patterns, accepted.patterns);
  console.log(`PASS project save/reopen/no-autoplay, Full → Drop → Cancel → save, failed save, migration, preview exclusion, recovery, export cancellation, PCM WAV (${bytes.length} bytes). Artifacts: ${temp}`);
} finally { await context.close(); await browser.close(); }
