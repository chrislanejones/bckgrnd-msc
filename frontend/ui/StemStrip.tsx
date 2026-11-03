/**
 * One stem: its spine, its state in words, a meter, this bar's pattern, a fader, and
 * Solo over Cut.
 *
 * The spine is also the button that opens the stem in the inspector. The strip is
 * dimmed only when the stem is silenced by the user (cut, or off because of another
 * stem's solo). A stem resting through a bar the song leaves it out of stays at full
 * strength and says so, since nothing is wrong with it.
 */

import { memo, useMemo } from 'react';
import { barActivity } from '../lib/api';
import { stemRange } from '../lib/contract';
import { ICONS, isSilenced, type StemState } from '../lib/stems';
import type { StemId, StemMeta, TrackArrangement } from '../lib/types';
import { editHistory } from '../lib/history';
import { StatusIndicator, StemMeter, cx, useRangeGesture } from './controls';

const VOLUME = stemRange('volume');

/**
 * Memoized, with callbacks that take the stem's id, so a strip re-renders only when
 * something about it changes: its own fader, its state, or the playhead moving a step.
 * A knob turning elsewhere no longer re-renders all eight.
 */
export const StemStrip = memo(function StemStrip({
  meta,
  index,
  state,
  stateLabel,
  volume,
  muted,
  soloed,
  track,
  bar,
  col,
  selected,
  onVolume,
  onCut,
  onSolo,
  onSelect,
}: {
  meta: StemMeta;
  index: number;
  state: StemState;
  stateLabel: string;
  volume: number;
  muted: boolean;
  soloed: boolean;
  track: TrackArrangement;
  /** The bar playing now, whose pattern the step row shows. */
  bar: number;
  /** The step sounding now within the bar, or -1. */
  col: number;
  selected: boolean;
  onVolume: (id: StemId, value: number) => void;
  onCut: (id: StemId) => void;
  onSolo: (id: StemId) => void;
  onSelect: (id: StemId) => void;
}) {
  const Icon = ICONS[meta.id];
  const activity = useMemo(() => barActivity(track, meta.id, bar), [track, meta.id, bar]);
  const gesture = useRangeGesture(`stem.${meta.id}.volume`, volume);
  /** Back to the track's own level for this stem, as one edit. */
  const resetVolume = () => {
    const home = track.mix[meta.id];
    if (Math.abs(home - volume) < 1e-6) return;
    editHistory.record(`stem.${meta.id}.volume`, volume, home);
    onVolume(meta.id, home);
  };
  const silenced = isSilenced(state);
  const headingId = `stem-${meta.id}`;
  return (
    <article
      className={cx('stem', silenced && 'is-cut', selected && 'is-selected')}
      aria-labelledby={headingId}
      data-state={state}
    >
      <button
        type="button"
        className="stem-spine"
        aria-pressed={selected}
        aria-label={`Inspect ${meta.name}`}
        onClick={() => onSelect(meta.id)}
      >
        <Icon className="size-4 shrink-0" strokeWidth={2.2} aria-hidden />
        <span id={headingId} className="stem-name" role="heading" aria-level={3}>
          {meta.name}
        </span>
      </button>
      <div className="stem-body">
        <div className="stem-top">
          <StatusIndicator state={state} label={stateLabel} compact />
          <StemMeter index={index} />
        </div>
        <div className="step-row" aria-hidden="true">
          {activity.map((on, i) => (
            <span key={i} className={cx('step', on && 'on', i === col && 'now')} />
          ))}
        </div>
        <label className="stem-fader">
          <span className="sr-only">{meta.name} volume</span>
          <input
            className="fader"
            type="range"
            {...VOLUME}
            value={volume}
            aria-valuetext={`${Math.round(volume * 100)}%`}
            aria-keyshortcuts="Delete"
            title="Double-click or Delete for the track's own level"
            onChange={(event) => onVolume(meta.id, Number(event.target.value))}
            {...gesture}
            onDoubleClick={resetVolume}
            onKeyDown={(event) => {
              if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                resetVolume();
                return;
              }
              gesture.onKeyDown();
            }}
          />
        </label>
      </div>
      {/* Solo over Cut, one badge column, the same width on every stem. Cut lights
          whenever the stem is silenced, including by another stem's solo. */}
      <div className="stem-actions">
        <button
          type="button"
          className="badge stem-badge tap"
          aria-pressed={soloed}
          aria-label={`Solo ${meta.name}`}
          onClick={() => onSolo(meta.id)}
        >
          Solo
        </button>
        <button
          type="button"
          className={cx('badge stem-badge tap', silenced && 'is-cut')}
          aria-pressed={muted}
          aria-label={`${muted ? 'Bring in' : 'Cut'} ${meta.name}`}
          aria-keyshortcuts={meta.keys}
          onClick={() => onCut(meta.id)}
        >
          {muted ? 'In' : 'Cut'}
        </button>
      </div>
    </article>
  );
});
