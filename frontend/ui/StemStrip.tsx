/**
 * One stem: its spine, its state in words, a meter, this bar's pattern, a fader, and
 * Solo over Cut.
 *
 * The spine is also the button that opens the stem in the inspector. The strip is
 * dimmed only when the stem is silenced by the user (cut, or off because of another
 * stem's solo). A stem resting through a bar the song leaves it out of stays at full
 * strength and says so, since nothing is wrong with it.
 */

import { stemRange } from '../lib/contract';
import { ICONS, isSilenced, type StemState } from '../lib/stems';
import type { StemMeta } from '../lib/types';
import { StatusIndicator, StemMeter, cx } from './controls';

const VOLUME = stemRange('volume');

export function StemStrip({
  meta,
  index,
  state,
  stateLabel,
  volume,
  muted,
  soloed,
  activity,
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
  /** Which of the current bar's sixteen steps have a hit or a note. */
  activity: boolean[];
  /** The step sounding now within the bar, or -1. */
  col: number;
  selected: boolean;
  onVolume: (value: number) => void;
  onCut: () => void;
  onSolo: () => void;
  onSelect: () => void;
}) {
  const Icon = ICONS[meta.id];
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
        onClick={onSelect}
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
            onChange={(event) => onVolume(Number(event.target.value))}
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
          onClick={onSolo}
        >
          Solo
        </button>
        <button
          type="button"
          className={cx('badge stem-badge tap', silenced && 'is-cut')}
          aria-pressed={muted}
          aria-label={`${muted ? 'Bring in' : 'Cut'} ${meta.name}`}
          aria-keyshortcuts={meta.keys}
          onClick={onCut}
        >
          {muted ? 'In' : 'Cut'}
        </button>
      </div>
    </article>
  );
}
