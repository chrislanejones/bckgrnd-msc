// ESLint for the TypeScript front end and the Node tools (flat config).
// `pnpm run lint` runs it; the global rule pairs it with `tsc --noEmit`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'vendor/',
      'dist/',
      'public/',
      'storage/',
      'engine-core/',
      'bootstrap/',
      'nativephp/',
      'old/',
      'screenshots/',
      'test-results/',
      'playwright-report/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `catch {}` is how the tools say "try, and move on"; the house style.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // `cond ? a() : b()` as a statement is used for paired actions (undo/redo).
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
      // A leading underscore marks a parameter a signature requires but the body ignores.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['frontend/worklets/**/*.ts'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The browser checks drive Playwright: page.evaluate() callbacks run in the page.
    files: ['tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['frontend/worklets/**/*.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
);
