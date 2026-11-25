/**
 * Performance preferences: how Fill and Rise are set up (Night 8). Per viewer, kept in
 * localStorage like the knob drag mode (`ui/knobPrefs.tsx`) and Output's fold, and never
 * part of a project: they describe how you perform, not what the song is (ADR-020).
 */

export const PREF = {
  /** Fill at: `bar` (the next bar) or `phrase` (the phrase's last bar). */
  fillAt: 'bckgrnd-msc:fill-at',
  /** The phrase length a Phrase end fill ends on: 2, 4, 8 or 16. */
  phraseBars: 'bckgrnd-msc:fill-phrase-bars',
  /** Fill style (Night 9): `classic`, `simple`, `busy` or `syncopated`. */
  fillStyle: 'bckgrnd-msc:fill-style',
  /** How many bars Rise rises over: 2, 4 or 8. */
  riseBars: 'bckgrnd-msc:rise-bars',
  /** Finish with Fill on Rise: `on` or `off`. */
  riseFill: 'bckgrnd-msc:rise-fill',
  /** Compare A/B unfolded in the scenes toolbar (Night 9): `open` or `closed`. */
  compareOpen: 'bckgrnd-msc:compare-open',
  /** Beat Repeat's division (Night 10): 4, 8 or 16. */
  repeatDivision: 'bckgrnd-msc:repeat-division',
} as const;

/** The stored choice for `key` if it is one of `choices`, else `fallback`. */
export function readChoice<T extends string | number>(key: string, choices: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return choices.find((c) => String(c) === raw) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Remember a choice. */
export function writeChoice(key: string, value: string | number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
}
