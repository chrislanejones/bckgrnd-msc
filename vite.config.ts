import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Vite builds the React app into `public/build`, which is what the Blade shell
 * loads. Laravel's `public/` is the document root for both `artisan serve` and the
 * packaged desktop app, so compiled assets land in the one place both can serve.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'frontend'),
  // `root` is `frontend/`, but env files belong next to `package.json`. Without this
  // Vite looks for `frontend/.env.static` and never finds it, so `VITE_STATIC` silently
  // comes through undefined and the static bundle quietly keeps calling the API.
  envDir: import.meta.dirname,
  publicDir: false,
  base: '/build/',
  // A cache key for the worklet and wasm, whose names are fixed (see engine.ts).
  define: {
    __BUILD_ID__: JSON.stringify(JSON.parse(readFileSync(resolve(import.meta.dirname, process.env.BCKGRND_MANIFEST_PATH ?? 'public/build-manifest.json'), 'utf8')).buildId),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The wasm-bindgen glue, also bundled into the worklet.
      '@wasm': resolve(import.meta.dirname, 'public/wasm/bckgrnd_msc_engine.js'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'public/build'),
    emptyOutDir: false, // the worklet bundle lives here too
    assetsDir: 'assets',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'es2022',
    rollupOptions: {
      // The Blade shell in resources/views/app.blade.php is the page, so Vite only
      // emits the script and stylesheet. Fixed names keep the template independent
      // of content hashes, which matters because NativePHP packages the build.
      input: resolve(import.meta.dirname, 'frontend/main.tsx'),
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        // The stylesheet keeps its fixed name for the shell; everything else it pulls
        // in (the bundled fonts) is hashed, or the files would overwrite each other.
        assetFileNames: (asset) => (asset.names?.[0] ?? asset.name ?? '').endsWith('.css') ? 'assets/app.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Talk to `php artisan serve` during development.
      '/api': 'http://127.0.0.1:8000',
    },
  },
});
