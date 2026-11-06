import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
execFileSync('node', ['scripts/prepare-native.mjs'], { cwd: root, stdio: 'inherit' });
// Review/preserve our scripts instead of accepting native:install's npm defaults.
const composer = readFileSync(resolve(root, 'composer.json'));
try { execFileSync('php', ['artisan', 'native:install', '--installer=pnpm', '--no-interaction'], { cwd: root, stdio: 'inherit' }); }
finally { writeFileSync(resolve(root, 'composer.json'), composer); }
const electron = resolve(root, 'vendor/nativephp/desktop/resources/electron');
copyFileSync(resolve(electron, 'pnpm-lock.yaml'), resolve(root, 'nativephp/pnpm-lock.yaml'));
// Dependency lifecycle scripts were disabled. Only run the two needed binary
// installers explicitly; they do not switch package managers.
execFileSync('node', ['node_modules/electron/install.js'], { cwd: electron, stdio: 'inherit' });
