/**
 * One mixer channel: the stem's name, its state in words, a vertical fader with the
 * meter beside it, and Solo, Cut and Reset beneath.
 *
 * Three things that look alike mean different things, and are drawn differently:
 *
 * | Element | Means | Moves when |
 * |---|---|---|
 * | The fader cap | The level you set | You move it |
 * | The meter beside it | Measured audio on this stem | The music plays |
 * | The marker on the rail | The track's own level for this stem | The track changes |
 *
 * A cut stem's meter and channel dim and its state says so; the cap stays at the
 * stored level, so cutting never looks like the fader went to zero.
 */

import { memo, useEffect, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { stemRange } from '../lib/contract';
import { engine } from '../lib/engine';
import { editHistory } from '../lib/history';
import { ICONS, isSilenced, type StemState } from '../lib/stems';
import type { StemId, StemMeta } from '../lib/types';
import { StatusIndicator, cx } from './controls';
import { PERCENT, VerticalFader } from './VerticalFader';

const VOLUME = stemRange('volume');

/** A vertical meter strip, written from telemetry without a React render. */
export function ChannelMeter({ index, dimmed }: { index: number; dimmed: boolean }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      engine.subscribe((t) => {
        const el = bar.current;
        if (el) el.style.transform = `scaleY(${Math.min(1, t.levels[index] ?? 0)})`;
      }),
    [index],
  );
  return (
    <div className={cx('channel-meter', dimmed && 'is-dimmed')} aria-hidden="true">
      <span ref={bar} />
    </div>
  );
}

export const MixerChannel = memo(function MixerChannel({
  meta,
  index,
  state,
  stateLabel,
  volume,
  home,
  muted,
  soloed,
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
  /** The track's own level for this stem. */
  home: number;
  muted: boolean;
  soloed: boolean;
  selected: boolean;
  onVolume: (id: StemId, value: number) => void;
  onCut: (id: StemId) => void;
  onSolo: (id: StemId) => void;
  onSelect: (id: StemId) => void;
}) {
  const Icon = ICONS[meta.id];
  const silenced = isSilenced(state);
  const headingId = `stem-${meta.id}`;
  const modified = Math.abs(volume - home) > 1e-6;
  return (
    <article
      className={cx('stem channel', silenced && 'is-cut', selected && 'is-selected')}
      aria-labelledby={headingId}
      data-state={state}
    >
      <button
        type="button"
        className="channel-name"
        aria-pressed={selected}
        aria-label={`Inspect ${meta.name}`}
        onClick={() => onSelect(meta.id)}
      >
        <Icon className="size-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
        <span id={headingId} role="heading" aria-level={3}>
          {meta.name}
        </span>
      </button>
      <div className="channel-status" title={stateLabel}>
        <StatusIndicator state={state} label={stateLabel} compact />
      </div>
      <div className="channel-strip">
        <VerticalFader
          label={`${meta.name} volume`}
          value={volume}
          min={VOLUME.min}
          max={VOLUME.max}
          defaultValue={home}
          format={PERCENT}
          historyId={`stem.${meta.id}.volume`}
          dimmed={silenced}
          onChange={(v) => onVolume(meta.id, v)}
        />
        <ChannelMeter index={index} dimmed={silenced} />
      </div>
      <div className="channel-actions">
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
        <button
          type="button"
          className="badge stem-badge channel-reset tap"
          disabled={!modified}
          aria-label={`Reset ${meta.name} to the track's level`}
          onClick={() => {
            editHistory.record(`stem.${meta.id}.volume`, volume, home);
            onVolume(meta.id, home);
          }}
        >
          <RotateCcw className="size-3" aria-hidden />
        </button>
      </div>
    </article>
  );
});
