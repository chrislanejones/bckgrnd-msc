/**
 * Fills as the UI reasons about them (Night 8, docs/NIGHT8_PROTOCOL.md): when a fill is
 * asked to play, whether a late press rolled over to the next phrase, and what the
 * Fill and Fill → Drop buttons, the pads and the status line say about it. Pure: no
 * React, no engine.
 *
 * The engine keeps the timing. The host only remembers what it asked for (which kind
 * of fill, which phrase length, where the playhead was) so the words match what the
 * engine reported.
 */

import type { Fill, TrackArrangement } from './types';
import {
  BUILD_REFUSAL,
  EVENT,
  REASON,
  foldFillEvent,
  isFillPending,
  type EngineEvent,
  type FillRequest,
  type SceneRequest,
} from './scenes';

/** Fill at: the next bar (Night 3), or the last bar of the phrase. */
export type FillAt = 'bar' | 'phrase';
/** How many bars a phrase is: an app preference, passed with each request. */
export type PhraseBars = 2 | 4 | 8 | 16;
export const PHRASE_BAR_CHOICES: readonly PhraseBars[] = [2, 4, 8, 16];
export const DEFAULT_PHRASE_BARS: PhraseBars = 4;

/** The track's first fill, Classic: what plays when a style can't be found. */
export const FILL_INDEX = 0;

/**
 * Fill style (Night 9): which of the track's four fills Fill, Fill → Drop and Rise +
 * Fill play. An app preference, like Fill at; never part of a project.
 */
export type FillStyle = 'classic' | 'simple' | 'busy' | 'syncopated';
export const FILL_STYLES: readonly FillStyle[] = ['classic', 'simple', 'busy', 'syncopated'];
export const DEFAULT_FILL_STYLE: FillStyle = 'classic';
export const FILL_STYLE_LABEL: Record<FillStyle, string> = {
  classic: 'Classic',
  simple: 'Simple',
  busy: 'Busy',
  syncopated: 'Syncopated',
};
/**
 * A style's word on the Fill button, in place of "Fill" while it waits or plays. Short
 * for Syncopated: "Syncopated · Next phrase" leaves the fill row no room at all at
 * 1180px (measured), "Synco · Next phrase" leaves 33px. Its name stays the full one.
 */
export const FILL_STYLE_WORD: Record<FillStyle, string> = {
  classic: 'Fill',
  simple: 'Simple',
  busy: 'Busy',
  syncopated: 'Synco',
};
/** What a style does, for its menu's tooltip. */
export const FILL_STYLE_HINT: Record<FillStyle, string> = {
  classic: "the track's own fill",
  simple: 'a lighter fill: the hats thin out',
  busy: 'a rising clap roll',
  syncopated: 'offbeat accents, 3 + 3 + 2',
};

/** The Fill button's name for a style: "Classic fill", or "Classic beat fill" for a beat. */
export const fillStyleName = (style: FillStyle, length: FillLength = 'bar'): string =>
  `${FILL_STYLE_LABEL[style]}${length === 'beat' ? ' beat' : ''} fill`;

/**
 * The engine's index for `style` among the fills it was loaded with: its place in
 * `styles` (the track's `fillStyles`), or Classic's 0 when the library has none or
 * lacks that style.
 */
export function fillIndex(styles: readonly Fill[] | undefined, style: FillStyle): number {
  const i = styles?.findIndex((f) => f.style === style) ?? -1;
  return i >= 0 ? i : FILL_INDEX;
}

// ---- Fill length: a bar, or only its last beat (Night 10) ----------------------------

/**
 * Fill length: the whole bar (Night 3's fill), or only its last beat, steps 12-15, with
 * the bar's first three beats left to the groove. An app preference like Fill style;
 * independent of it (Random and Rotate pick the style the same way for either).
 */
export type FillLength = 'bar' | 'beat';
export const FILL_LENGTHS: readonly FillLength[] = ['bar', 'beat'];
export const DEFAULT_FILL_LENGTH: FillLength = 'bar';
export const FILL_LENGTH_LABEL: Record<FillLength, string> = { bar: 'Bar', beat: 'Beat' };
/** What the engine is sent as `length`: 0 the bar, 1 its last beat. */
export const fillLengthCode = (length: FillLength | undefined): 0 | 1 => (length === 'beat' ? 1 : 0);
/** Why Beat can't be chosen for this track: it was exported without beat fills. */
export const NO_BEAT_FILLS = "this track's library has no beat fills: fills play the bar";

/**
 * The length a press plays: the preference, or Bar when the track has no beat fills
 * (a library exported before Night 10). The fill is then named Bar too: the host names
 * what plays, as it does for a style it lacks (ADR-024).
 */
export const effectiveLength = (length: FillLength, beats: readonly Fill[] | undefined): FillLength =>
  length === 'beat' && beats?.length ? 'beat' : 'bar';

// ---- Fill choice: a style, or Random / Rotate (Night 9) ------------------------------

/** The Fill style menu: the four styles, then Random and Rotate. Classic by default. */
export type FillMode = 'random' | 'rotate';
export type FillChoice = FillStyle | FillMode;
export const FILL_CHOICES: readonly FillChoice[] = [...FILL_STYLES, 'random', 'rotate'];
export const FILL_MODE_LABEL: Record<FillMode, string> = { random: 'Random', rotate: 'Rotate' };
export const isFillMode = (choice: FillChoice): choice is FillMode => choice === 'random' || choice === 'rotate';

/**
 * Where Random and Rotate are: kept for the session, never stored, and kept across a
 * track change. Moved on only when a fill actually starts playing (`advanceFill`), so a
 * canceled, refused or withdrawn request plays next what it showed.
 */
export type FillCursor = {
  /** Rotate's next place in `FILL_STYLES` (0-3). */
  rotate: number;
  /** How many Random picks have played: Random's draw counter. */
  draws: number;
  /** The style that played last, so Random never repeats it. */
  last: FillStyle | null;
};
export const FILL_CURSOR: FillCursor = { rotate: 0, draws: 0, last: null };
/** Random's seed: fixed, so a session's sequence is the same every time (and testable). */
export const FILL_SEED = 0x6b0a5e9d;

/** Draw `n` of mulberry32 from `seed`: a number in [0, 1), the same every time. */
export function fillDraw(seed: number, n: number): number {
  let t = (seed + Math.imul(n + 1, 0x6d2b79f5)) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The styles a track's fills actually have, in menu order: Classic alone without any. */
export function availableStyles(styles: readonly Fill[] | undefined): FillStyle[] {
  const have = FILL_STYLES.filter((x) => styles?.some((f) => f.style === x));
  return have.length ? have : ['classic'];
}

/** What a press plays: the style that will be heard, and its index for the engine. */
export type FillPick = { style: FillStyle; index: number };

/**
 * Resolve the menu's choice to one style, at queue time (and before it, to show it).
 * A style the track lacks plays Classic, and is named Classic: the effective style is
 * the one named everywhere. Rotate takes the next available style from its place;
 * Random draws among the available styles, never the one that played last (unless it
 * is the only one).
 */
export function resolveFill(choice: FillChoice, styles: readonly Fill[] | undefined, cursor: FillCursor, seed = FILL_SEED): FillPick {
  const have = availableStyles(styles);
  let style: FillStyle;
  if (choice === 'rotate') {
    const n = FILL_STYLES.length;
    style = 'classic';
    for (let k = 0; k < n; k += 1) {
      const x = FILL_STYLES[(cursor.rotate + k) % n]!;
      if (have.includes(x)) {
        style = x;
        break;
      }
    }
  } else if (choice === 'random') {
    const pool = have.length > 1 && cursor.last ? have.filter((x) => x !== cursor.last) : have;
    style = pool[Math.floor(fillDraw(seed, cursor.draws) * pool.length)]!;
  } else {
    style = have.includes(choice) ? choice : 'classic';
  }
  return { style, index: fillIndex(styles, style) };
}

/**
 * `resolveFill` for a fill of `length`: a beat fill picks its style among the track's
 * beat fills, the same way, and its index is past the four bar fills (`withFillStyles`
 * sends the engine the bar fills, then the beat fills). Without beat fills it is the
 * bar fill's pick.
 */
export function resolveFillAt(
  choice: FillChoice,
  styles: readonly Fill[] | undefined,
  beats: readonly Fill[] | undefined,
  length: FillLength,
  cursor: FillCursor,
  seed = FILL_SEED,
): FillPick {
  if (effectiveLength(length, beats) === 'bar' || !styles?.length) return resolveFill(choice, styles, cursor, seed);
  const pick = resolveFill(choice, beats, cursor, seed);
  return { style: pick.style, index: styles.length + pick.index };
}

/** The cursor after a fill picked with `choice` started playing `style`. */
export function advanceFill(cursor: FillCursor, choice: FillChoice, style: FillStyle): FillCursor {
  return {
    rotate: choice === 'rotate' ? (FILL_STYLES.indexOf(style) + 1) % FILL_STYLES.length : cursor.rotate,
    draws: choice === 'random' ? cursor.draws + 1 : cursor.draws,
    last: style,
  };
}

/** The menu's words for a choice: a mode says what the next press plays. */
export function fillChoiceLabel(choice: FillChoice, next: FillStyle): string {
  return isFillMode(choice) ? `${FILL_MODE_LABEL[choice]} · next ${FILL_STYLE_LABEL[next]}` : FILL_STYLE_LABEL[choice];
}

/**
 * The Fill button's name: the style that will play ("Busy fill"), and in Random or
 * Rotate the mode too ("Busy fill, by Rotate").
 */
export const fillChoiceName = (choice: FillChoice, style: FillStyle, length: FillLength = 'bar'): string =>
  isFillMode(choice) ? `${fillStyleName(style, length)}, by ${FILL_MODE_LABEL[choice]}` : fillStyleName(style, length);

/**
 * The arrangement as the engine is sent it: with the four styles as its fills, then
 * the four beat fills (Night 10), so `fillIndex` and `resolveFillAt` pick one. The
 * arrangement itself is left as it is (it is a project's hashed source); without
 * styles it goes unchanged and index 0 is its own fill.
 */
export function withFillStyles(
  arranged: TrackArrangement,
  styles: readonly Fill[] | undefined,
  beats?: readonly Fill[],
): TrackArrangement {
  return styles?.length ? { ...arranged, fills: [...styles, ...(beats ?? [])] } : arranged;
}

/** What the engine is sent as `phrase`: 0 for the next bar. */
export const fillPhrase = (at: FillAt, bars: PhraseBars): 0 | PhraseBars => (at === 'phrase' ? bars : 0);

/** A plain fill, the fill of a Fill into, or the fill a Rise finishes with. */
export type FillKind = 'plain' | 'into' | 'rise';

/** The fill the host follows: the engine's request, and what it is part of. */
export type FillJob = FillRequest & {
  kind: FillKind;
  /** The phrase it was sent with: 0 the next bar, else 2, 4, 8 or 16. */
  phrase: number;
  /** The song step (0-255) the playhead was on when it was asked for or re-announced. */
  from: number;
  /** A late press: it plays the end of the next phrase, not this one. */
  late?: boolean;
  /** The request it was sent with: the Fill into's scene, or the Rise. */
  partner?: number;
  /** The style it plays (resolved when sent): it keeps it if the choice changes meanwhile. */
  style?: FillStyle;
  /** The menu's choice it was resolved from: Random and Rotate move on when it starts. */
  choice?: FillChoice;
  /** `beat`: only the bar's last beat (Night 10). Kept as sent, like `style`. Absent: the bar. */
  length?: FillLength;
};

/** The words a beat fill adds after the style's word on the buttons: "Busy beat". */
const beatWord = (job: FillJob): string => (job.length === 'beat' ? ' beat' : '');

const STEPS_PER_BAR = 16;
const SONG_STEPS = 256;

/**
 * Whether a phrase fill rolled over to the next phrase: its first step (`fill queued`
 * `b`) lies in a later phrase than the playhead, or behind it in the same one (a loop's
 * last bar asked for while it plays, which comes round on the next pass). Never for a
 * next-bar fill.
 */
export function rolledOver(from: number, firstStep: number, phrase: number): boolean {
  if (phrase <= 0 || from < 0) return false;
  const span = phrase * STEPS_PER_BAR;
  const at = ((from % SONG_STEPS) + SONG_STEPS) % SONG_STEPS;
  const first = ((firstStep % SONG_STEPS) + SONG_STEPS) % SONG_STEPS;
  return Math.floor(first / span) !== Math.floor(at / span) || first <= at;
}

/**
 * Fold one fill event into the job the host follows: `foldFillEvent`, plus whether a
 * queued phrase fill rolled over (measured from the press, or for a re-announce after
 * a loop change from `step`, where the playhead is now), and an unlinked fill becoming
 * a plain one. Returns the same object when the event changes nothing.
 */
export function foldFillJob(job: FillJob, event: EngineEvent, step: number): FillJob {
  let next = foldFillEvent(job, event);
  if (next === job) return job;
  if (event.kind === EVENT.fillQueued) {
    const from = job.status === 'sending' ? job.from : step;
    next = { ...next, from, late: rolledOver(from, event.b, job.phrase) };
  }
  if (event.kind === EVENT.fillUnlinked) {
    next = { ...next, kind: 'plain' };
    delete next.partner;
  }
  return next;
}

/**
 * The request a fill leads into (a Fill into's scene, or a Rise), marked filling once
 * that fill has started, so its pad can say "Filling into Drop". Any other request is
 * returned as it is.
 */
export function markFilling(request: SceneRequest, fillId: number): SceneRequest {
  if (request.fillInto?.fillId === fillId && !request.fillInto.filling) {
    return { ...request, fillInto: { ...request.fillInto, filling: true } };
  }
  const build = request.build;
  if (build?.fill?.fillId === fillId && !build.fill.filling) {
    return { ...request, build: { ...build, fill: { ...build.fill, filling: true } } };
  }
  return request;
}

/** A pending fill the Fill button itself shows: a plain one, or any that is playing. */
export function fillButtonJob(job: FillJob | null): FillJob | null {
  if (!isFillPending(job)) return null;
  return job.kind === 'plain' || job.status === 'playing' ? job : null;
}

/** The Fill button's words. "Drum fill" at rest, as in Night 3. */
export function fillButtonLabel(job: FillJob | null): string {
  const own = fillButtonJob(job);
  if (!own) return 'Drum fill';
  // A style other than Classic names itself in place of the word Fill ("Busy · Bar 8"),
  // which keeps the widest words on the fill row. Classic keeps Night 8's words.
  // A beat fill says so after the style's word ("Busy beat · Bar 8"); Classic's is
  // "Beat fill", so it never reads "Fill beat".
  const word = own.length === 'beat' && (!own.style || own.style === 'classic')
    ? 'Beat fill'
    : `${own.style ? FILL_STYLE_WORD[own.style] : 'Fill'}${beatWord(own)}`;
  if (own.status === 'playing') return `${word} playing`;
  if (own.status === 'sending') return `${word}…`;
  if (own.late) return `${word} · Next phrase`;
  return own.bar ? `${word} · Bar ${own.bar}` : `${word} queued`;
}

/** The Fill button's name for assistive technology. `phrase` is the current Fill at. */
export function fillButtonAria(job: FillJob | null, name: string, phrase: number, length: FillLength = 'bar'): string {
  const own = fillButtonJob(job);
  if (own?.status === 'playing') return `${name} is playing`;
  if (own) {
    if (own.phrase === 0 || !own.bar) {
      return own.length === 'beat' && own.bar ? `Cancel the queued ${name}, on the last beat of bar ${own.bar}` : `Cancel the queued ${name}`;
    }
    const where = own.length === 'beat' ? `on the last beat of bar ${own.bar}` : `at the end of bar ${own.bar}`;
    return own.late
      ? `Cancel the queued ${name}, at the end of the next phrase, bar ${own.bar}`
      : `Cancel the queued ${name}, ${where}`;
  }
  if (length === 'beat') {
    return phrase === 0
      ? `${name} for one beat, the last beat of this bar or the next`
      : `${name} for one beat, the last beat before the next ${phrase}-bar phrase line`;
  }
  return phrase === 0
    ? `${name} for one bar, from the next bar`
    : `${name} for one bar, ending on the next ${phrase}-bar phrase line`;
}

/** The Fill button's tooltip when it can be pressed. */
export const fillButtonTitle = (name: string, phrase: number, length: FillLength = 'bar'): string =>
  length === 'beat'
    ? phrase === 0
      ? `${name}: the last beat of the bar, this bar's if it hasn't started`
      : `${name}: the last beat before the ${phrase}-bar phrase line`
    : phrase === 0
      ? `${name}: one bar, from the next bar`
      : `${name}: one bar, ending on the ${phrase}-bar phrase line`;

/** The status line when a plain fill is queued (again, after a loop change). */
export function fillQueuedStatus(job: FillJob): string {
  const what = job.length === 'beat' ? 'Beat fill' : 'Fill';
  const bar = job.length === 'beat' && job.bar ? `the last beat of bar ${job.bar}` : `bar ${job.bar ?? ''}`.trim();
  if (job.phrase === 0 || !job.bar) return `${what} queued for ${bar}`;
  return job.late
    ? `${what} queued for ${bar}, the end of the next phrase`
    : `${what} queued for ${bar}, the end of the phrase`;
}

/** The pending Fill into, if the job is one. */
export const fillIntoJob = (job: FillJob | null): FillJob | null =>
  isFillPending(job) && job.kind === 'into' ? job : null;

/** The Fill → Drop button's words, `scene` being the slot's current name. */
export function fillIntoLabel(job: FillJob | null, scene: string): string {
  const own = fillIntoJob(job);
  if (!own) return `Fill → ${scene}`;
  if (own.status === 'playing') return `Filling → ${scene}`;
  if (own.status === 'sending' || !own.bar) return `Fill → ${scene}…`;
  // A beat fill reads "Beat · Bar 8 → Drop": the same width as the bar fill's words.
  const word = own.length === 'beat' ? 'Beat' : 'Fill';
  return own.late ? `${word} · Next phrase → ${scene}` : `${word} · Bar ${own.bar} → ${scene}`;
}

/** The Fill → Drop button's name for assistive technology. */
export function fillIntoAria(job: FillJob | null, scene: string, phrase: number, length: FillLength = 'bar'): string {
  const own = fillIntoJob(job);
  if (!own) {
    if (length === 'beat') {
      return phrase === 0
        ? `Fill into ${scene}: a beat fill on the bar's last beat, then ${scene} on the downbeat`
        : `Fill into ${scene}: a beat fill on the last beat of the ${phrase}-bar phrase`;
    }
    return phrase === 0
      ? `Fill into ${scene}: a fill on the next bar, then ${scene}`
      : `Fill into ${scene} at the end of the ${phrase}-bar phrase`;
  }
  if (own.status === 'playing') return `Filling into ${scene}. Press again to cancel ${scene}; the fill plays out its bar.`;
  if (own.status === 'sending' || !own.bar) return `Fill into ${scene}, being queued. Press again to cancel.`;
  return own.late
    ? `Fill into ${scene} at the end of the next phrase, bar ${own.bar}. Press again to cancel.`
    : `Fill into ${scene} at the end of bar ${own.bar}. Press again to cancel.`;
}

/** A pad's line while its scene waits on a fill: Fill into, or a Rise's last bar. */
export const fillingLine = (scene: string): string => `Filling into ${scene}`;
/** A pad's line while a Fill into's scene waits for its fill. */
export const fillInLine = (bar: number | undefined): string => (bar ? `Fill in · Bar ${bar}` : 'Fill in…');

// ---- Refusals: plain words, naming the part at fault -------------------------

/** Why a request was refused, where the scene words (`REASON`) would mislead. */
const REFUSAL: Record<number, string> = {
  3: 'not while the deck is scratched or braking',
  6: 'not during a mix',
  7: 'press Play first',
  9: 'the track changed',
};

/** Why a plain fill was not started (event 15). */
export function fillRefusal(reason: number): string {
  if (reason === 1) return "this track's fill isn't available";
  if (reason === 8) return 'a fill is already queued or playing';
  return REFUSAL[reason] ?? REASON[reason] ?? 'refused';
}

/** `b` of a refused Fill into's events 15 and 5 (`FILL_INTO_REJECTED_PART`). */
const INTO_PART = { scene: 1, fill: 2, lanes: 3 } as const;

/** Why a Fill into was not started (events 15 and 5), naming the part at fault. */
export function fillIntoRefusal(reason: number, part: number, scene: string): string {
  if (part === INTO_PART.scene) return reason === 1 ? `${scene} isn't a valid mix` : (REFUSAL[reason] ?? REASON[reason] ?? 'refused');
  if (part === INTO_PART.fill) return fillRefusal(reason);
  if (part === INTO_PART.lanes) return `${scene}'s patterns were refused`;
  return REFUSAL[reason] ?? REASON[reason] ?? 'refused';
}

/** `b` of event 45 with reason `invalid`: the parts Night 8 adds (`BUILD_REJECTED_PART`). */
const BUILD_PART = { lanes: 4, fill: 5 } as const;

/** Why a Rise was not started (event 45), naming the part at fault. */
export function buildRefusal(reason: number, part: number): string {
  if (part === BUILD_PART.fill) return reason === 8 ? 'a fill is already waiting' : "this track's fill isn't available";
  if (part === BUILD_PART.lanes && reason === 1) return 'its patterns were refused';
  return BUILD_REFUSAL[reason] ?? REASON[reason] ?? 'refused';
}

/** The status line when a Fill into or a Rise + Fill was canceled or cut short. */
export function fillIntoCancelled(scene: string, reason: number | undefined, filling: boolean): string {
  if (reason === undefined || reason === 10) {
    return filling ? `${scene} canceled; the fill plays out its bar` : `Fill → ${scene} canceled`;
  }
  return `Fill → ${scene} canceled: ${REASON[reason] ?? ''}`;
}
