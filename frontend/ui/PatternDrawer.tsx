/**
 * The editor drawer, opened on purpose and closed out of the way.
 *
 * For now it shows one stem's pattern across the whole 16-bar song, read-only, with
 * the playhead from engine telemetry. Editing replaces this view later; the drawer,
 * its place in the layout and its stem picker stay.
 */

import { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { BARS, PARTS, STEM_NAMES, STEM_ORDER, stemLane } from '../lib/stems';
import type { StemId, TrackArrangement } from '../lib/types';
import { Segmented, cx } from './controls';

export function PatternDrawer({
  open,
  onClose,
  track,
  stem,
  onStem,
  songStep,
}: {
  open: boolean;
  onClose: () => void;
  track: TrackArrangement;
  stem: StemId;
  onStem: (stem: StemId) => void;
  songStep: number;
}) {
  const lane = useMemo(() => stemLane(track, stem), [track, stem]);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Opening the drawer on purpose moves focus into it, so the keyboard lands where the
  // eyes do. Escape is handled by the app, which owns what had focus before.
  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open]);

  return (
    <section
      id="pattern-drawer"
      className={cx('drawer', open && 'is-open')}
      aria-label="Pattern"
      data-views="edit"
    >
      <header className="drawer-head">
        <div className="drawer-title">
          <h2 className="panel-title">Pattern</h2>
          <span className="badge-static">Read-only</span>
        </div>
        <Segmented<StemId>
          label="Stem"
          hideLabel
          value={stem}
          onPick={onStem}
          options={STEM_ORDER.map((id) => ({ value: id, label: STEM_NAMES[id] }))}
        />
        <button
          ref={closeRef}
          type="button"
          className="icon-button drawer-close"
          aria-label="Close the pattern"
          onClick={onClose}
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div
        className="pattern-grid"
        role="img"
        aria-label={`${STEM_NAMES[stem]} pattern across all 16 bars of ${track.name}`}
      >
        {Array.from({ length: BARS }, (_, bar) => (
          <div key={bar} className={cx('pattern-row', bar % 4 === 0 && 'is-phrase')}>
            <span className="pattern-bar">
              {bar % 4 === 0 ? <span className="pattern-part">{PARTS[bar / 4]}</span> : null}
              <span className="tabular-nums">{bar + 1}</span>
            </span>
            <span className="pattern-steps">
              {Array.from({ length: 16 }, (_, i) => {
                const at = bar * 16 + i;
                const vel = lane[at] ?? 0;
                return (
                  <span
                    key={i}
                    className={cx('pattern-cell', vel > 0 && 'on', at === songStep && 'now', i % 4 === 0 && 'beat')}
                    style={vel > 0 ? { opacity: 0.35 + 0.65 * Math.min(1, vel) } : undefined}
                  />
                );
              })}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
