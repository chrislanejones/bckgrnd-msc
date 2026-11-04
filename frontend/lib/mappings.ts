/**
 * How each parameter maps onto a control.
 *
 * A knob turns through a fixed sweep; a mapping says what value each point of that
 * sweep is (`toNorm` / `fromNorm`, 0 at the bottom-left stop, 1 at the bottom-right),
 * how the value reads (`format`, with a unit that means something: 2.4 kHz, -6.0 dB,
 * 35%, 1/8), and how a typed value is read back (`parse`). Frequencies, gains,
 * percentages and times do not share one curve: a filter spread linearly in Hz spends
 * three quarters of its travel above 4 kHz, and a gain spread linearly in amplitude
 * puts all the useful decibels in the last few degrees.
 *
 * The value is always the engine's own number, the one sent to the worklet and saved
 * in a project. The mapping only decides where it sits under the hand and how it reads.
 */

import { param } from './contract';

export type Mapping = {
  min: number;
  max: number;
  /** Value to sweep position, 0..1. */
  toNorm: (value: number) => number;
  /** Sweep position to value. */
  fromNorm: (norm: number) => number;
  /** The value as words: number and unit separately, so the unit can be set smaller. */
  format: (value: number) => { text: string; unit?: string };
  /** The full value for assistive technology, e.g. "2.4 kilohertz". */
  speak: (value: number) => string;
  /** A typed value back to the engine's number, or null if it cannot be read. */
  parse: (text: string) => number | null;
  /** Snap a value to what the parameter can hold (whole BPM, say). */
  quantize?: (value: number) => number;
  /** The value the arc grows from, for parameters with a neutral middle. */
  center?: number;
  /** Keyboard step as a fraction of the sweep; Shift divides it by ten. */
  keyStep: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** Read the first number in a string, allowing a unicode minus and a comma decimal. */
function number(text: string): number | null {
  const m = text.replace(/−/g, '-').replace(',', '.').match(/-?\d*\.?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** A plain number with a minus sign that reads as one. */
function signed(n: number, digits: number): string {
  const text = Math.abs(n).toFixed(digits);
  if (Number(text) === 0) return (0).toFixed(digits);
  return n < 0 ? `−${text}` : `+${text}`;
}

function linear(
  min: number,
  max: number,
  opts: Partial<Mapping> & Pick<Mapping, 'format' | 'speak' | 'parse'>,
): Mapping {
  return {
    min,
    max,
    toNorm: (v) => clamp01((v - min) / (max - min)),
    fromNorm: (n) => min + clamp01(n) * (max - min),
    keyStep: 0.01,
    ...opts,
  };
}

function logarithmic(
  min: number,
  max: number,
  opts: Partial<Mapping> & Pick<Mapping, 'format' | 'speak' | 'parse'>,
): Mapping {
  const ratio = Math.log(max / min);
  return {
    min,
    max,
    toNorm: (v) => clamp01(Math.log(clamp(v, min, max) / min) / ratio),
    fromNorm: (n) => min * Math.exp(clamp01(n) * ratio),
    keyStep: 0.01,
    ...opts,
  };
}

/** A 0..max ratio shown as a whole percentage. */
function percent(max: number, opts: Partial<Mapping> = {}): Mapping {
  return linear(0, max, {
    format: (v) => ({ text: String(Math.round(v * 100)), unit: '%' }),
    speak: (v) => `${Math.round(v * 100)} percent`,
    parse: (t) => {
      const n = number(t);
      return n === null ? null : clamp(n / 100, 0, max);
    },
    ...opts,
  });
}

// ---- Frequency -------------------------------------------------------------

const FILTER_LOW = 240;
const FILTER_HIGH = 18_000;
const FILTER_RATIO = Math.log(FILTER_HIGH / FILTER_LOW);

/** The engine's filter curve: position 0..1 to Hz, exponential (Master::filter_freq). */
export function filterHz(open: number): number {
  return FILTER_LOW * Math.exp(clamp01(open) * FILTER_RATIO);
}

function hz(f: number): { text: string; unit: string } {
  if (f >= 10_000) return { text: (f / 1000).toFixed(0), unit: 'kHz' };
  if (f >= 1000) return { text: (f / 1000).toFixed(1), unit: 'kHz' };
  return { text: String(Math.round(f)), unit: 'Hz' };
}

/**
 * The tape filter. The engine already takes a 0..1 position and spreads it
 * exponentially, so the knob is linear in that position and reads it in Hz.
 */
export const FILTER: Mapping = linear(0, 1, {
  format: (v) => (v >= 0.999 ? { text: 'Open' } : hz(filterHz(v))),
  speak: (v) => {
    const f = hz(filterHz(v));
    const words = `${f.text} ${f.unit === 'kHz' ? 'kilohertz' : 'hertz'}`;
    return v >= 0.999 ? `Open, ${words}` : words;
  },
  parse: (t) => {
    if (/open/i.test(t)) return 1;
    const n = number(t);
    if (n === null) return null;
    const f = /k/i.test(t) ? n * 1000 : n;
    return clamp01(Math.log(clamp(f, FILTER_LOW, FILTER_HIGH) / FILTER_LOW) / FILTER_RATIO);
  },
});

export const RESONANCE: Mapping = logarithmic(param('fx.filterQ').min!, param('fx.filterQ').max!, {
  format: (v) => ({ text: v.toFixed(v < 1 ? 2 : 1), unit: 'Q' }),
  speak: (v) => `Q ${v.toFixed(2)}`,
  parse: (t) => {
    const n = number(t);
    return n === null ? null : clamp(n, param('fx.filterQ').min!, param('fx.filterQ').max!);
  },
});

// ---- Gain ------------------------------------------------------------------

/** The engine's isolator curve: an amount to decibels, kill below 0.02 (band_db). */
export function bandDb(amount: number): number {
  if (amount <= 0.02) return -Infinity;
  return clamp(20 * Math.log10(amount), -36, 6);
}

const BAND_MAX = param('fx.low').max!;
const BAND_TOP_DB = 20 * Math.log10(BAND_MAX);
const BAND_FLOOR_DB = -36;

/**
 * A three-band isolator. Unity sits at twelve o'clock and the arc grows from there,
 * as on a DJ mixer: the left half runs from unity down to the kill on a decibel
 * curve, the right half up to the engine's +2.9 dB.
 */
export const ISOLATOR: Mapping = {
  min: 0,
  max: BAND_MAX,
  center: 1,
  keyStep: 0.01,
  toNorm: (v) => {
    if (v <= 0.02) return 0;
    const db = 20 * Math.log10(v);
    if (db <= 0) return clamp01(0.5 * (1 - db / BAND_FLOOR_DB));
    return clamp01(0.5 + 0.5 * (db / BAND_TOP_DB));
  },
  fromNorm: (n) => {
    const x = clamp01(n);
    if (x <= 0.005) return 0;
    const db = x <= 0.5 ? BAND_FLOOR_DB * (1 - x / 0.5) : BAND_TOP_DB * ((x - 0.5) / 0.5);
    return clamp(10 ** (db / 20), 0, BAND_MAX);
  },
  format: (v) => {
    const db = bandDb(v);
    if (!Number.isFinite(db)) return { text: 'Kill' };
    return { text: signed(db, 1), unit: 'dB' };
  },
  speak: (v) => {
    const db = bandDb(v);
    return Number.isFinite(db) ? `${db.toFixed(1)} decibels` : 'killed';
  },
  parse: (t) => {
    if (/kill|off|-inf|−inf/i.test(t)) return 0;
    const n = number(t);
    if (n === null) return null;
    if (n <= BAND_FLOOR_DB) return 0;
    return clamp(10 ** (n / 20), 0, BAND_MAX);
  },
  quantize: (v) => (v === 0 ? 0 : Math.abs(v - 1) < 0.004 ? 1 : v),
};

const LEVEL_FLOOR_DB = -60;

/** Master level, a 0..1 gain, laid out and read in decibels. */
export const LEVEL: Mapping = {
  min: 0,
  max: 1,
  keyStep: 0.01,
  toNorm: (v) => (v <= 0 ? 0 : clamp01(1 - (20 * Math.log10(v)) / LEVEL_FLOOR_DB)),
  fromNorm: (n) => {
    const x = clamp01(n);
    if (x <= 0.002) return 0;
    return 10 ** ((LEVEL_FLOOR_DB * (1 - x)) / 20);
  },
  format: (v) => (v <= 0 ? { text: '−∞', unit: 'dB' } : { text: signed(20 * Math.log10(v), 1), unit: 'dB' }),
  speak: (v) => (v <= 0 ? 'silent' : `${(20 * Math.log10(v)).toFixed(1)} decibels`),
  parse: (t) => {
    if (/inf|off|mute/i.test(t)) return 0;
    const n = number(t);
    if (n === null) return null;
    if (n <= LEVEL_FLOOR_DB) return 0;
    return clamp(10 ** (Math.min(0, n) / 20), 0, 1);
  },
};

// ---- Percentages, times, tempo, the stereo field ---------------------------

export const SWING: Mapping = percent(1);
export const FEEDBACK: Mapping = percent(param('fx.echoFeedback').max!);
export const RETURN: Mapping = percent(param('fx.echoReturn').max!);
export const ROOM: Mapping = percent(param('fx.reverbMix').max!);
export const SEND: Mapping = percent(1);

export const DECAY: Mapping = logarithmic(param('fx.reverbDecay').min!, param('fx.reverbDecay').max!, {
  format: (v) => ({ text: v < 1 ? v.toFixed(2) : v.toFixed(1), unit: 's' }),
  speak: (v) => `${v.toFixed(2)} seconds`,
  parse: (t) => {
    const n = number(t);
    if (n === null) return null;
    const seconds = /ms/i.test(t) ? n / 1000 : n;
    return clamp(seconds, param('fx.reverbDecay').min!, param('fx.reverbDecay').max!);
  },
});

const TEMPO_MIN = param('transport.bpm').control!.min;
const TEMPO_MAX = param('transport.bpm').control!.max;

export const TEMPO: Mapping = linear(TEMPO_MIN, TEMPO_MAX, {
  format: (v) => ({ text: String(Math.round(v)), unit: 'BPM' }),
  speak: (v) => `${Math.round(v)} beats per minute`,
  parse: (t) => {
    const n = number(t);
    return n === null ? null : clamp(Math.round(n), TEMPO_MIN, TEMPO_MAX);
  },
  quantize: (v) => Math.round(v),
  keyStep: 1 / (TEMPO_MAX - TEMPO_MIN),
});

/** The balance reads in words: the useful positions are the ends and the middle. */
export function stereoLabel(balance: number): string {
  if (balance <= 0.02) return 'Left';
  if (balance >= 0.98) return 'Right';
  if (Math.abs(balance - 0.5) <= 0.02) return 'Stereo';
  return balance < 0.5
    ? `Left ${Math.round((0.5 - balance) * 200)}%`
    : `Right ${Math.round((balance - 0.5) * 200)}%`;
}

/** On screen, between the ends, the side is a letter ("R 10 %"), so the amount and its
    Reset fit under a knob in a three-across rack. Speech keeps the word. */
function stereoShort(balance: number): { text: string; unit?: string } {
  const full = stereoLabel(balance);
  const m = /^(Left|Right) (\d+)%$/.exec(full);
  return m ? { text: `${m[1][0]} ${m[2]}`, unit: '%' } : { text: full };
}

export const BALANCE: Mapping = linear(0, 1, {
  center: 0.5,
  format: stereoShort,
  speak: (v) => stereoLabel(v),
  parse: (t) => {
    if (/^\s*(c|centre|center|stereo)\s*$/i.test(t)) return 0.5;
    const n = number(t);
    if (/^\s*l/i.test(t)) return n === null ? 0 : clamp(0.5 - n / 200, 0, 0.5);
    if (/^\s*r/i.test(t)) return n === null ? 1 : clamp(0.5 + n / 200, 0.5, 1);
    return n === null ? null : clamp(n, 0, 1);
  },
  quantize: (v) => (Math.abs(v - 0.5) < 0.01 ? 0.5 : v),
});

export const WIDTH: Mapping = linear(0, param('fx.width').max!, {
  center: 1,
  format: (v) => (v <= 0.005 ? { text: 'Mono' } : { text: String(Math.round(v * 100)), unit: '%' }),
  speak: (v) => (v <= 0.005 ? 'mono' : `${Math.round(v * 100)} percent width`),
  parse: (t) => {
    if (/mono/i.test(t)) return 0;
    const n = number(t);
    return n === null ? null : clamp(n / 100, 0, param('fx.width').max!);
  },
  quantize: (v) => (Math.abs(v - 1) < 0.01 ? 1 : v),
});

/** A mapping's display as one string, for places that show it inline. */
export function display(mapping: Mapping, value: number): string {
  const f = mapping.format(value);
  return f.unit ? `${f.text} ${f.unit}` : f.text;
}
