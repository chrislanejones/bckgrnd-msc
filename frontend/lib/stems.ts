/**
 * Stem identity and the stem state vocabulary.
 *
 * Every stem shows exactly one state, in the same words everywhere
 * (docs/DESIGN_PHILOSOPHY.md, "Visible cause and effect"). The state is derived from
 * what the user set and what the arrangement holds for the current bar — never
 * guessed from a meter, which reads silence between hits as "not playing".
 */

import {
  Activity,
  AudioLines,
  CircleDot,
  Music2,
  Orbit,
  Radio,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { StemId, TrackArrangement } from './types';

export const STEM_ORDER: StemId[] = ['kick', 'clap', 'hats', 'bass', 'stab', 'lead', 'pad', 'arp'];

export const STEM_NAMES: Record<StemId, string> = {
  kick: 'Kick',
  clap: 'Clap',
  hats: 'Hats',
  bass: 'Bass',
  stab: 'Stab',
  lead: 'Lead',
  pad: 'Pad',
  arp: 'Arp',
};

export const ICONS: Record<StemId, LucideIcon> = {
  kick: CircleDot,
  clap: AudioLines,
  hats: Activity,
  bass: Waves,
  stab: Zap,
  lead: Music2,
  pad: Radio,
  arp: Orbit,
};

export const PARTS = ['Intro', 'Groove', 'Break', 'Drop'] as const;
export const STEPS = 256;
export const BARS = 16;

/**
 * One state per stem.
 *
 * `queued` is part of the vocabulary but nothing produces it yet: it arrives with the
 * quantized performance controls, when an action waits for the next bar.
 */
export type StemState = 'ready' | 'playing' | 'resting' | 'cut' | 'soloed' | 'offBySolo' | 'queued';

/** Whether the state is silent because of something the user did. */
export function isSilenced(state: StemState): boolean {
  return state === 'cut' || state === 'offBySolo';
}

export function stemState(
  id: StemId,
  opts: {
    muted: Record<StemId, boolean>;
    solo: Record<StemId, boolean>;
    playing: boolean;
    soundsThisBar: boolean;
  },
): StemState {
  const anySolo = STEM_ORDER.some((s) => opts.solo[s]);
  // The engine silences a stem that is cut even while it is soloed, so Cut wins.
  if (opts.muted[id]) return 'cut';
  if (anySolo && !opts.solo[id]) return 'offBySolo';
  if (opts.solo[id]) return 'soloed';
  if (!opts.playing) return 'ready';
  return opts.soundsThisBar ? 'playing' : 'resting';
}

/** The words for a state. `soloedBy` names the stems holding the solo. */
export function stemStateLabel(state: StemState, soloedBy: StemId[] = []): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'playing':
      return 'Playing';
    case 'resting':
      return 'Rests this bar';
    case 'cut':
      return 'Cut';
    case 'soloed':
      return 'Solo';
    case 'offBySolo': {
      const first = soloedBy[0];
      if (!first) return 'Off: solo';
      const more = soloedBy.length > 1 ? ` +${soloedBy.length - 1}` : '';
      return `Off: solo on ${STEM_NAMES[first]}${more}`;
    }
    case 'queued':
      return 'Next bar';
  }
}

/**
 * For every bar, which stems have something sounding in it.
 *
 * Drums count a hit in the bar. Melodic stems count a note *sounding* in the bar, from
 * its onset to the end of its gate, so a pad held across four bars reads as playing in
 * all four rather than only the bar it started in. Hand percussion rides the hats.
 */
export function soundingMap(track: TrackArrangement): Record<StemId, boolean>[] {
  const out = Array.from({ length: BARS }, () =>
    Object.fromEntries(STEM_ORDER.map((id) => [id, false])) as Record<StemId, boolean>,
  );
  const mark = (stem: StemId, from: number, len = 1) => {
    for (let s = from; s < Math.min(STEPS, from + Math.max(1, len)); s += 1) {
      const bar = out[Math.floor(s / 16)];
      if (bar) bar[stem] = true;
    }
  };
  const hits = (stem: StemId, lane: number[] | undefined) =>
    lane?.forEach((v, i) => v > 0 && mark(stem, i));

  hits('kick', track.kick);
  hits('clap', track.clap);
  hits('hats', track.hat);
  hits('hats', track.hatOpen);
  for (const lane of Object.values(track.perc ?? {})) hits('hats', lane);
  for (const stem of ['bass', 'stab', 'lead', 'pad', 'arp'] as const) {
    track[stem].forEach((event, i) => event && mark(stem, i, event.len));
  }
  return out;
}

/** The pattern of one stem across the whole song, as velocities (0 is silent). */
export function stemLane(track: TrackArrangement, stem: StemId): number[] {
  const out = Array.from({ length: STEPS }, () => 0);
  const add = (lane: number[] | undefined) =>
    lane?.forEach((v, i) => {
      if (i < STEPS) out[i] = Math.max(out[i] ?? 0, v);
    });
  switch (stem) {
    case 'kick':
      add(track.kick);
      break;
    case 'clap':
      add(track.clap);
      break;
    case 'hats':
      add(track.hat);
      add(track.hatOpen);
      for (const lane of Object.values(track.perc ?? {})) add(lane);
      break;
    default:
      track[stem].forEach((event, i) => {
        if (event && i < STEPS) out[i] = event.vel;
      });
  }
  return out;
}
