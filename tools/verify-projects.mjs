import { chromium } from 'playwright';
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
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
  // An untouched track has nothing to lose: no warning, no recovery row, no "Unsaved".
  assert.equal(await page.locator('.save-status').textContent(), 'As written');
  await page.getByRole('button', { name: 'Solo Kick' }).click();
  assert.equal(await page.locator('.save-status').textContent(), 'Unsaved');
  await page.getByRole('button', { name: 'Solo Kick' }).click();
  // The dialog owns the keyboard: nothing behind it plays or cuts, and Save still works.
  await menu();
  const playingBefore = await page.locator('.app').getAttribute('data-playing');
  const cutBefore = await page.evaluate(() => document.querySelector('article.stem')?.dataset.state);
  await page.getByRole('button', { name: 'Close projects', exact: true }).focus();
  await page.keyboard.press('1');
  await page.locator('input[aria-label="Project name"]').focus();
  assert.equal(await page.evaluate(() => document.querySelector('article.stem')?.dataset.state), cutBefore);
  assert.equal(await page.locator('.app').getAttribute('data-playing'), playingBefore);
  // Typing a name keeps its spaces; only the stored name is trimmed.
  await page.locator('input[aria-label="Project name"]').fill('');
  await page.locator('input[aria-label="Project name"]').pressSequentially('My  Song ');
  assert.equal(await page.locator('input[aria-label="Project name"]').inputValue(), 'My  Song ');
  assert.equal((await file()).project.name, 'My  Song');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Saved '));
  await page.getByLabel('Project name', { exact: true }).fill('My Song');
  await save();
  // A second save with nothing new keeps the rollback copy a real older revision.
  await save();
  const rows = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('bckgrnd-projects', 1);
    r.onsuccess = () => { const q = r.result.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => { resolve(q.result); r.result.close(); }; };
  }));
  const mine = rows.find((row) => row.current?.project.name === 'My Song');
  assert.ok(mine.previous && mine.previous.revision < mine.current.revision, 'repeat save kept the older revision');
  // A "Saved" notice doesn't outlive the next edit.
  await page.getByLabel('Project name', { exact: true }).fill('My Song 2');
  assert.match(await page.locator('[data-testid="project-status"]').textContent(), /^Unsaved · r\d+$/);
  // Deleting the open project's saved copy leaves it unsaved, and it can still save.
  await page.locator('li', { hasText: 'My Song' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('li', { hasText: 'My Song' }).waitFor({ state: 'detached' });
  assert.equal(await page.locator('.save-status').textContent(), 'Unsaved');
  await save();
  // Opening the saved copy of what is open is clean, and its edits save normally.
  await page.locator('li', { hasText: 'My Song 2' }).getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.startsWith('Opened '));
  assert.equal(await page.locator('.save-status').textContent(), 'Saved');
  await close();
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
  await menu(); await page.locator('li', { hasText: 'Night 6 café' }).getByRole('button', { name: 'Open', exact: true }).click();
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
  // waitForFunction treats a promise as true, so this has to poll for itself.
  const recovered = () => page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('bckgrnd-projects', 1);
    r.onsuccess = () => { const q = r.result.transaction('projects').objectStore('projects').getAll(); q.onsuccess = () => { resolve(q.result.some((x) => x.recovery?.project.name === 'Recovery café')); r.result.close(); }; };
  }));
  for (let tries = 0; !(await recovered()); tries++) {
    assert.ok(tries < 50, 'the recovery copy was never written');
    await page.waitForTimeout(100);
  }
  await page.reload(); await page.waitForFunction(() => !!window.__BCKGRND_PROJECT__?.()); await menu();
  await page.locator('li', { hasText: 'Preview accepted' }).getByRole('button', { name: /^Recover r/ }).last().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.includes('Opened Recovery café'));
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  assert.deepEqual((await file()).project.patterns, accepted.patterns);
  // A library update warns and opens; a render, with no one to warn, still refuses.
  const changed = await file(); const realHash = changed.source.sha256; changed.source.sha256 = 'a'.repeat(64);
  await assert.rejects(readSnapshot(changed, library.tracks, source), /Source library mismatch/);
  await assert.rejects(readSnapshot({ ...changed, source: { trackId: 'not-this-track', sha256: realHash } }, library.tracks, source, () => {}), /different track/);
  const changedPath = join(temp, 'library-changed.bckgrnd.json'); writeFileSync(changedPath, JSON.stringify(changed));
  await page.locator('input[type=file]').setInputFiles(changedPath);
  await page.locator('[data-testid="source-warning"]').waitFor();
  assert.equal(await page.locator('.save-status').textContent(), 'Unsaved');
  assert.deepEqual((await file()).project.patterns, changed.project.patterns);
  assert.equal(await page.locator('.app').getAttribute('data-playing'), 'no');
  await save();
  assert.equal(await page.locator('[data-testid="source-warning"]').count(), 0);
  assert.equal((await file()).source.sha256, realHash);
  // The static (Netlify) build has no /api behind it. Even a page that carries a desktop
  // token must keep using browser storage there and never call the native bridge.
  const isStatic = (await fetch(new URL('/api/tracks', base))).status === 404;
  if (isStatic) {
    const web = await browser.newContext(); const tab = await web.newPage(); const nativeCalls = [];
    await tab.route(new URL('/', base).href, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="bckgrnd-native-token" content="test">') });
    });
    tab.on('request', (r) => { if (r.url().includes('/api/native/')) nativeCalls.push(r.url()); });
    await tab.goto(base); await tab.waitForFunction(() => !!window.__BCKGRND_PROJECT__?.());
    await tab.getByRole('button', { name: /^Projects ·/ }).click();
    await tab.getByLabel('Project name', { exact: true }).fill('Static stays web');
    await tab.getByRole('button', { name: 'Save project', exact: true }).click();
    await tab.waitForFunction(() => document.querySelector('[data-testid="project-status"]')?.textContent?.includes('Saved Static stays web'));
    assert.equal(await tab.getByRole('button', { name: 'Reveal Export' }).count(), 0, 'static build offers no desktop file actions');
    assert.deepEqual(nativeCalls, [], 'static build never calls the native bridge');
    await web.close();
    console.log(`PASS (static) project save/reopen/no-autoplay, Full → Drop → Cancel → save, failed save, migration, preview exclusion, recovery, export cancellation, PCM WAV (${bytes.length} bytes), browser storage despite a desktop token. Artifacts: ${temp}`);
  } else {
  // Desktop: Save As ties the project to its file, and Save keeps that file current. The
  // bridge is mocked here; ProjectFilesTest covers the real file writes.
  const desktop = await browser.newContext(); const desk = await desktop.newPage();
  desk.on('dialog', (d) => void d.accept());
  let calls = []; let fileFails = false; const chosen = '/music/song.bckgrnd.json';
  await desk.route(new URL('/', base).href, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<head>', '<head><meta name="bckgrnd-native-token" content="test">') });
  });
  await desk.route('**/api/native/projects/*', (route) => {
    const action = route.request().url().split('/').pop(); calls.push(action);
    if (action === 'update-file' && fileFails) return route.fulfill({ status: 422, json: { message: 'the disk is gone' } });
    return route.fulfill({ json: action === 'list' ? [] : action === 'save-file' || action === 'update-file' ? { path: chosen } : { ok: true } });
  });
  const said = (text) => desk.waitForFunction((t) => document.querySelector('[data-testid="project-status"]')?.textContent?.includes(t), text);
  const writes = () => calls.filter((c) => c === 'save-file' || c === 'write' || c === 'update-file');
  const rename = (name) => desk.getByLabel('Project name', { exact: true }).fill(name);
  const saveProject = () => desk.getByRole('button', { name: 'Save project', exact: true }).click();
  await desk.goto(base); await desk.waitForFunction(() => !!window.__BCKGRND_PROJECT__?.());
  await desk.getByRole('button', { name: /^Projects ·/ }).click();
  await rename('Desk song'); await desk.getByRole('button', { name: 'Save As', exact: true }).click(); await said(chosen);
  assert.deepEqual(writes(), ['save-file', 'write']);
  calls = []; await rename('Desk song 2'); await saveProject(); await said(`Desk song 2 · r`); await said(chosen);
  assert.deepEqual(writes(), ['write', 'update-file']);
  // A file that can't be written is said out loud, and the next Save retries only the file.
  calls = []; fileFails = true; await rename('Desk song 3'); await saveProject(); await said('The project file was not updated: the disk is gone');
  assert.deepEqual(writes(), ['write', 'update-file']);
  calls = []; fileFails = false; await saveProject(); await said(`Desk song 3 · r`); await said(chosen);
  assert.deepEqual(writes(), ['update-file']);
  await desktop.close();
  console.log(`PASS project save/reopen/no-autoplay, Full → Drop → Cancel → save, failed save, migration, preview exclusion, recovery, export cancellation, PCM WAV (${bytes.length} bytes). Artifacts: ${temp}`);
  }
} finally { await context.close(); await browser.close(); }
