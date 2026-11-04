/**
 * Small pieces the pattern editor's parts share: what part of the song is on screen,
 * note names, and the words for engine reasons.
 */

import { PARTS } from '../../lib/stems';
import { STEPS_PER_BAR } from '../../lib/patterns';

/** What the grid shows: one bar, all sixteen steps or (on a phone) eight of them. */
export type Viewport = {
  bar: number;
  /** Columns within the bar, in order: 0..15, or 0..7 / 8..15. */
  cols: number[];
};

export const viewStart = (v: Viewport) => v.bar * STEPS_PER_BAR + (v.cols[0] ?? 0);
export const viewEnd = (v: Viewport) => viewStart(v) + v.cols.length;

/** Columns grouped by beat (steps 1-4, 5-8, 9-12, 13-16), for the drum and velocity rows. */
export function beatGroups(cols: number[]): number[][] {
  const groups: number[][] = [];
  for (const c of cols) {
    const g = Math.floor(c / 4);
    const last = groups.at(-1);
    if (last && Math.floor((last[0] ?? 0) / 4) === g) last.push(c);
    else groups.push([c]);
  }
  return groups;
}

export const partOf = (bar: number) => PARTS[Math.floor(bar / 4)] ?? '';

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
/** Scientific pitch name: 60 is C4. */
export const noteName = (n: number) => `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
export const isBlackKey = (n: number) => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);

/** "Bar 9, step 3" for a song step. */
export const stepLabel = (step: number) =>
  `bar ${Math.floor(step / STEPS_PER_BAR) + 1}, step ${(step % STEPS_PER_BAR) + 1}`;

/** Engine reasons (docs/NIGHT3_PROTOCOL.md), as the status line says them. */
export const PATTERN_REASON: Record<number, string> = {
  1: 'the engine refused it',
  2: 'stopped',
  3: 'the playhead moved',
  4: 'a new track loaded',
  5: 'panic',
  6: 'a mix is running',
  7: 'not playing',
  9: 'it was for the previous track',
  10: 'withdrawn',
};

export const pct = (v: number) => Math.round(v * 100);
