import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

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
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The wasm-bindgen glue, also bundled into the worklet.
      '@wasm': resolve(import.meta.dirname, 'public/wasm/floor_engine.js'),
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
        assetFileNames: 'assets/app.[ext]',
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