/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * `'1'` when building the PHP-free static bundle.
   *
   * In static mode the frontend skips the API entirely and reads the exported
   * `public/library/*.json`. Without it the app still works via a fallback, but every
   * page load would fire an `/api/tracks` request that 404s on a static host.
   */
  readonly VITE_STATIC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Unique per `vite build`, set in vite.config.ts; a cache key for fixed-name assets. */
declare const __BUILD_ID__: string;
