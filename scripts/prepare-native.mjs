/** Focused compatibility patch for the locked NativePHP Desktop 2.4 runtime.
 * Fail closed on upstream changes. Never enable Node in the renderer. */
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const base = resolve(root, 'vendor/nativephp/desktop');
const lock = JSON.parse(readFileSync(resolve(root, 'composer.lock'), 'utf8'));
if (lock.packages.find((p) => p.name === 'nativephp/desktop')?.version !== '2.4.0') throw new Error('Review native compatibility patches for the new NativePHP version.');
function replace(file, from, to) {
  const path = resolve(base, file); let s = readFileSync(path, 'utf8');
  if (s.includes(to)) return;
  if (!s.includes(from)) throw new Error(`Native patch no longer matches ${file}`);
  writeFileSync(path, s.replaceAll(from, to));
}
replace('src/Drivers/Electron/Traits/ExecuteCommand.php', "'npm' => 'npm install',", "'pnpm' => 'pnpm install --ignore-scripts',\n                'npm' => 'npm install',");
replace('src/Drivers/Electron/Traits/ExecuteCommand.php', "'npm' => 'npm run dev',", "'pnpm' => 'pnpm run dev',\n                'npm' => 'npm run dev',");
replace('src/Drivers/Electron/Commands/BuildCommand.php', "->run('npm ci',", "->run('pnpm install --frozen-lockfile --ignore-scripts',");
replace('src/Drivers/Electron/Commands/BuildCommand.php', '->run("npm run {$this->buildCommand}:{$this->buildOS}"', '->run("pnpm run {$this->buildCommand}:{$this->buildOS}"');
for (const [dir, ext] of [['src', 'ts'], ['dist', 'js']]) {
  const entry = `resources/electron/electron-plugin/${dir}/index.${ext}`;
  replace(entry, '        initialize();', `        // One owner of the persistent runtime and its loopback server.
        if (!app.requestSingleInstanceLock()) { app.exit(0); return; }
        app.on('second-instance', () => {
            for (const win of Object.values(state.windows)) {
                if (!win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
            }
        });
        initialize();`);
  replace(entry, '            this.quitting = true;', `            // Let the renderer confirm persistence before stopping PHP.
            const windows = Object.values(state.windows).filter((win) => !win.isDestroyed());
            if (windows.length) {
                event.preventDefault();
                for (const win of windows) win.close();
                return;
            }
            this.quitting = true;`);
  const path = `resources/electron/electron-plugin/${dir}/server`;
  replace(`${path}/php.${ext}`, 'if (runningSecureBuild()) {\n        variables.APP_SERVICES_CACHE', 'if (app.isPackaged) {\n        variables.APP_SERVICES_CACHE');
  replace(`${path}/webPreferences.${ext}`, 'sandbox: false,', 'sandbox: true,\n    nodeIntegration: false,\n    webSecurity: true,');
  replace(`${path}/webPreferences.${ext}`, 'preload/index.mjs', 'preload/bckgrnd.cjs');
  replace(`${path}/api/window.${ext}`, "import { BrowserWindow } from 'electron';", "import { BrowserWindow, ipcMain } from 'electron';");
  replace(`${path}/api/window.${ext}`, "import { enable } from '@electron/remote/main/index.js';", `// A single narrow IPC action, accepted only from this app's main frame.
const approvedCloses = new WeakSet();
ipcMain.on('bckgrnd:confirm-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || event.senderFrame !== win.webContents.mainFrame) return;
    const url = new URL(event.senderFrame.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) return;
    if (event.senderFrame.url !== win.webContents.getURL()) return;
    approvedCloses.add(win); win.close();
});`);
  replace(`${path}/api/window.${ext}`, 'enable(window.webContents);', '// Remote module intentionally unavailable.');
  replace(`${path}/api/window.${ext}`, "window.on('close', () => {", `window.on('close', (event) => {
        if (!approvedCloses.has(window)) {
            event.preventDefault(); window.webContents.send('bckgrnd:close-request'); return;
        }`);
}
copyFileSync(resolve(root, 'nativephp/preload.cjs'), resolve(base, 'resources/electron/electron-plugin/dist/preload/bckgrnd.cjs'));
replace('src/Builder/Concerns/ManagesEnvFile.php', 'collect(file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES))', 'collect(is_file($envFile) ? file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) : [])');
replace('resources/electron/electron-builder.mjs', "target: ['AppImage', 'deb'],", "target: ['tar.xz', 'deb'],");
replace('resources/electron/electron-builder.mjs', 'maintainer: appUrl,', 'maintainer: appAuthor,\n        syncDesktopName: true,');
replace('resources/electron/electron-builder.mjs', 'homepage: appUrl,', "homepage: appUrl,\n        license: 'MIT',\n        desktopName: 'com.chrislanejones.bckgrndmsc.desktop',");
const pkgPath = resolve(base, 'resources/electron/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
for (const key of Object.keys(pkg.scripts)) pkg.scripts[key] = pkg.scripts[key].replace(/\b(?:p+npm|npm) run /g, 'pnpm run ');
pkg.packageManager = 'pnpm@10.26.0';
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
// This is the dependency's supplied npm lock, not user work. The reviewed pnpm
// lock is kept in nativephp/ and restored into the generated runtime on install.
rmSync(resolve(base, 'resources/electron/package-lock.json'), { force: true });
if (existsSync(resolve(root, 'nativephp/pnpm-lock.yaml'))) copyFileSync(resolve(root, 'nativephp/pnpm-lock.yaml'), resolve(base, 'resources/electron/pnpm-lock.yaml'));
console.log('NativePHP 2.4 compatibility applied: pnpm, sandboxed preload, validated close IPC.');
