/**
 * A deck's waveform, and the scratch and seek gestures on it.
 *
 * Moved from app.tsx unchanged. The waveform is drawn from the arrangement, so it
 * shows what will play, including the bars still ahead.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { engine } from '../lib/engine';
import { PARTS, STEM_ORDER, STEPS } from '../lib/stems';
import type { StemId, TrackArrangement } from '../lib/types';
import { cx } from './controls';

/** Pointer travel, in CSS pixels, below which a press counts as a tap rather than a drag. */
const SCRUB_TAP_PX = 4;
/** How long the hand can rest before the platter is treated as held still. */
const SCRUB_REST_MS = 60;

/**
 * Dragging the waveform's playhead: a vinyl scratch over the live deck.
 *
 * Grabbing the waveform takes hold of the record where it is — the head does not
 * jump to the pointer — and moving drags it. The drag's speed, measured against the
 * deck's own speed at this tempo, is the playback rate the engine scratches at:
 * backwards plays the recent past in reverse, forwards replays it, still is silence.
 * Letting go drops the song in at the step under the head.
 *
 * A tap without a drag is a seek: the song jumps to the tapped bar.
 *
 * The playhead is drawn from the drag while it is held, because the engine's own
 * step is frozen during a scratch.
 */
function useScrub(step: number, bpm: number, live: boolean) {
  const [shown, setShown] = useState<number | null>(null);
  const drag = useRef<{
    x0: number;
    lastX: number;
    lastT: number;
    width: number;
    at: number;
    moved: boolean;
    tapStep: number;
  } | null>(null);
  const rest = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(rest.current), []);

  // Losing the platter mid-drag — a stop, or a mix starting — drops the drag here
  // only. The engine has already let go on its own (stop and mix both release the
  // platter where the hand had it), and by the time this deck stops being live the
  // other deck is, so a scratchEnd sent now would jump the wrong track.
  useEffect(() => {
    if (!live && drag.current) {
      window.clearTimeout(rest.current);
      drag.current = null;
      setShown(null);
    }
  }, [live]);

  const end = () => {
    const d = drag.current;
    if (!d) return;
    window.clearTimeout(rest.current);
    drag.current = null;
    setShown(null);
    if (d.moved) {
      engine.scratchEnd(Math.round(d.at) % STEPS);
    } else {
      // A tap seeks, without the scratch sound in between.
      engine.scratchStart();
      engine.scratchEnd(d.tapStep);
    }
  };

  const handlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (step < 0) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* pointer already released */
      }
      const box = event.currentTarget.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      drag.current = {
        x0: event.clientX,
        lastX: event.clientX,
        lastT: event.timeStamp,
        width: box.width,
        at: step % STEPS,
        moved: false,
        tapStep: Math.min(STEPS - 1, Math.floor(fraction * STEPS)),
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.abs(event.clientX - d.x0) < SCRUB_TAP_PX) return;
        d.moved = true;
        d.lastX = event.clientX;
        d.lastT = event.timeStamp;
        engine.scratchStart();
        return;
      }
      const dt = Math.max(1, event.timeStamp - d.lastT);
      const dSteps = ((event.clientX - d.lastX) / d.width) * STEPS;
      d.lastX = event.clientX;
      d.lastT = event.timeStamp;
      d.at = Math.min(STEPS - 1, Math.max(0, d.at + dSteps));
      setShown(d.at);
      // Sixteenth steps per millisecond at this tempo is rate 1.
      const normal = (bpm * 4) / 60000;
      engine.scratch(dSteps / dt / normal);
      window.clearTimeout(rest.current);
      rest.current = window.setTimeout(() => {
        if (drag.current?.moved) engine.scratch(0);
      }, SCRUB_REST_MS);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };

  return { step: shown, held: shown !== null, handlers };
}

/**
 * The song waveform, drawn from the arrangement's own lanes rather than an
 * `AnalyserNode`: it shows what *will* play, including the bars that are still
 * ahead, which a live scope cannot.
 */
export const DeckWave = memo(function DeckWave({
  side,
  track,
  step,
  status,
  silenced,
  bpm,
  mixing,
}: {
  side: 'a' | 'b';
  track: TrackArrangement | null;
  step: number;
  status: 'Live' | 'Cue' | 'Idle';
  /** Stems that are not sounding, left out of the drawing. */
  silenced?: Record<StemId, boolean>;
  /** Current tempo, so a drag's speed can be expressed as a playback rate. */
  bpm: number;
  /** A mix is running. The platter cannot be grabbed until it hands over. */
  mixing: boolean;
}) {
  // Both decks always draw. Before a track is cued there is nothing to show, so the
  // slot keeps its height with a placeholder rather than collapsing — a deck that
  // appears and disappears as tracks are cued makes the layout jump.
  // Keyed on which stems are silent as well as the track, so cutting one redraws.
  const silentKey = silenced ? STEM_ORDER.filter((id) => silenced[id]).join(',') : '';
  const path = useMemo(
    () => (track ? waveBands(track, silenced) : null),
    [track, silentKey],
  );
  const live = status === 'Live';
  const grabbable = live && !mixing;
  const scrub = useScrub(step, bpm, grabbable);
  const shown = scrub.step ?? step;
  const head = shown < 0 ? 0 : ((shown % STEPS) / STEPS) * 100;

  return (
    <div className="deck-wave" data-live={live ? 'yes' : 'no'}>
      <div className="flex items-baseline justify-between gap-2 px-2.5 pt-1.5">
        <p className="truncate text-xs font-semibold">
          <span className={side === 'a' ? 'text-acid' : 'text-deck-b'}>{side.toUpperCase()}</span>
          <span className="text-muted"> · </span>
          {track ? track.name : '—'}
        </p>
        <p className="shrink-0 text-xs text-muted">{live && mixing ? 'Mixing' : status}</p>
      </div>
      <div
        className={cx('relative mx-2 mb-5 mt-1', grabbable && 'wave-scrub', scrub.held && 'is-held')}
        {...(grabbable ? scrub.handlers : {})}
      >
        <svg
          viewBox="0 0 256 48"
          className="block h-12 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Deck ${side.toUpperCase()} waveform`}
        >
          <line className="wave-axis" x1="0" y1="24" x2="256" y2="24" />
          {Array.from({ length: 17 }, (_, b) => (
            <line
              key={b}
              className={b % 4 === 0 ? 'wave-grid-phrase' : 'wave-grid'}
              x1={(b / 16) * 256}
              x2={(b / 16) * 256}
              y1="1"
              y2="47"
            />
          ))}
          {path ? (
            <>
              <path d={path.low} className="wave-low" />
              <path d={path.mid} className="wave-mid" />
              <path d={path.high} className="wave-high" />
            </>
          ) : (
            <line className="wave-grid" x1="0" y1="24" x2="256" y2="24" />
          )}
        </svg>
        {/* The song form as [ ] brackets over the waveform, one per four-bar part,
            named small along the bottom. The live part lights up. */}
        <div className="wave-parts" aria-hidden="true">
          {PARTS.map((name, index) => (
            <span
              key={name}
              className={cx('wave-part', live && Math.floor(shown / 64) === index && 'is-on')}
            >
              <span className="wave-part-name">{name}</span>
            </span>
          ))}
        </div>
        <span
          className="wave-shade"
          style={{ left: `${head}%`, opacity: live ? 1 : 0 }}
        />
        <span
          className="wave-head"
          style={{ left: `${head}%`, opacity: live ? 1 : 0 }}
        />
      </div>
    </div>
  );
});

/**
 * Three envelopes — low, mid and high — rendered as sine lobes.
 *
 * Drums poke their transient onto the following step and melodic stems sustain
 * across their gate, which is what makes the shape read as a mix rather than a
 * grid of identical blocks.
 */
function waveBands(
  track: TrackArrangement,
  silenced?: Record<StemId, boolean>,
): { low: string; mid: string; high: string } {
  // A stem that is cut is left out of the drawing, so the waveform thins as stems are
  // taken away and fills back in as they return. The whole app is about removing
  // stems; a picture that stayed the same either way was describing the arrangement
  // rather than what you are hearing.
  const on = (id: StemId) => !silenced?.[id];
  const low = Array.from({ length: STEPS }, () => 0);
  const mid = Array.from({ length: STEPS }, () => 0);
  const high = Array.from({ length: STEPS }, () => 0);

  const poke = (dest: number[], values: number[], weight: number) => {
    values.forEach((value, index) => {
      if (value <= 0 || index >= STEPS) return;
      dest[index] += value * weight;
      if (index + 1 < STEPS) dest[index + 1] += value * weight * 0.45;
    });
  };

  if (on('kick')) poke(low, track.kick, 1);
  if (on('clap')) poke(mid, track.clap, 0.55);
  if (on('hats')) {
    poke(high, track.hat, 0.42);
    poke(high, track.hatOpen, 0.62);
  }

  const sustain = (
    dest: number[],
    events: (typeof track.bass)[number][],
    weight: number,
  ) => {
    events.forEach((event, index) => {
      if (!event || index >= STEPS) return;
      const span = Math.max(1, Math.min(event.len, STEPS - index));
      for (let i = 0; i < span; i += 1) {
        dest[index + i] += event.vel * weight * (1 - (i / span) * 0.55);
      }
    });
  };

  if (on('bass')) sustain(low, track.bass, 0.82);
  if (on('stab')) sustain(mid, track.stab, 0.5);
  if (on('lead')) sustain(mid, track.lead, 0.46);
  if (on('pad')) sustain(mid, track.pad, 0.34);
  if (on('arp')) sustain(high, track.arp, 0.4);

  const blur = (values: number[]) =>
    values.map((_, index) => {
      const prev = values[index - 1] ?? values[index] ?? 0;
      const next = values[index + 1] ?? values[index] ?? 0;
      return (values[index] ?? 0) * 0.5 + prev * 0.25 + next * 0.25;
    });

  /**
   * One band as a mirrored envelope.
   *
   * `ripple` puts a shallow oscillation on the edge at a musical rate, so the shape
   * reads as a waveform rather than a smooth tube. It is deliberately shallow: an
   * earlier version ran it at `0.32 + 0.68 * lobe`, which swung the edge nearly to
   * zero between lobes and turned every band into a row of bubbles, with the rhythm of
   * the sine rather than the rhythm of the track. At `0.86 + 0.14` the envelope is
   * what you see and the ripple is only texture on it.
   *
   * `floor` is the thickness at silence. Small, so the sparse intro and the break
   * actually read as quiet — the old constant 1.35 drew a solid band through both.
   */
  const band = (
    envelope: number[],
    ripple: number,
    scale: number,
    floor: number,
  ) => {
    const count = 720;
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i <= count; i += 1) {
      const x = (i / count) * 256;
      const pos = (i / count) * (STEPS - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(STEPS - 1, i0 + 1);
      const t = pos - i0;
      const ease = t * t * (3 - 2 * t);
      const env = Math.min(
        1.15,
        (envelope[i0] ?? 0) * (1 - ease) + (envelope[i1] ?? 0) * ease,
      );
      const lobe = Math.abs(Math.sin(pos * ripple));
      const amp = (floor + env * scale) * (0.86 + 0.14 * lobe);
      top.push(`${x.toFixed(2)},${(24 - amp).toFixed(2)}`);
      bottom.push(`${x.toFixed(2)},${(24 + amp).toFixed(2)}`);
    }
    bottom.reverse();
    return `M${top.join('L')}L${bottom.join('L')}Z`;
  };

  // Nested, widest at the back: the low band is the body, the mid sits inside it and
  // the high is a bright core. Each ripples twice as fast as the one under it, which
  // is roughly how the content divides — kick on the beat, hats on the sixteenth.
  // The scales are close together on purpose. Spread wider, the low band swallows the
  // other two and the whole thing reads as one blue shape with a pale line through it;
  // the point of splitting the bands is to see the hats and the melody against the
  // kick, so each has to clear the one behind it.
  return {
    low: band(blur(low), Math.PI / 2, 17, 0.9),
    mid: band(blur(mid), Math.PI, 13.5, 0.65),
    high: band(blur(high), Math.PI * 2, 9.5, 0.45),
  };
}