import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { engine } from './lib/engine';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from the page shell');

/**
 * Console entry point for diagnosing audio on a machine we cannot see.
 *
 * The automated checks tap the worklet with an analyser and a muted sink, because a
 * headless browser has no output device — so "the checks pass" says the engine emits
 * correct samples, not that they reach a speaker. On a real machine, run
 * `await __FLOOR_DIAG__()` to see which of the two you have.
 */
declare global {
  interface Window {
    __FLOOR_DIAG__: () => Promise<Record<string, unknown>>;
  }
}

window.__FLOOR_DIAG__ = async () => {
  const report = await engine.diagnose();
  console.table(report);
  return report;
};

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
