/**
 * Compare A/B: two mixes of the same track, heard on the same engine and playhead.
 *
 * Kept visibly apart from Deck A / Deck B, which are two tracks. Session-only: the
 * bar says so, and nothing here is labeled saved. Listening never overwrites A or
 * B; replacing one takes Update. Keep Current adopts what is playing as the working
 * mix; Exit Comparison brings back the mix from before the first capture.
 */

import type { Compare, SceneRequest } from '../lib/scenes';
import { isPending } from '../lib/scenes';
import { cx } from './controls';

export function CompareBar({
  compare,
  modified,
  request,
  disabled,
  onCapture,
  onListen,
  onUpdate,
  onKeep,
  onExit,
}: {
  compare: Compare | null;
  /** The working mix differs from the one being heard. */
  modified: boolean;
  request: SceneRequest | null;
  /** Why listening is unavailable (a mix is running), or null. */
  disabled: string | null;
  onCapture: (which: 'a' | 'b') => void;
  onListen: (which: 'a' | 'b') => void;
  onUpdate: () => void;
  onKeep: () => void;
  onExit: () => void;
}) {
  const queued = isPending(request) ? request.target : null;
  const slot = (which: 'a' | 'b') => {
    const name = which.toUpperCase();
    const stored = compare?.[which] ?? null;
    if (!stored) {
      return (
        <button key={which} type="button" className="compare-chip" onClick={() => onCapture(which)}>
          Capture {name}
        </button>
      );
    }
    const target = which === 'a' ? 'compareA' : 'compareB';
    const hearing = compare?.listening === which;
    const label =
      queued === target ? `${name} · Queued` : hearing ? (modified ? `${name} · Modified` : `${name} · Listening`) : name;
    return (
      <button
        key={which}
        type="button"
        className={cx('compare-chip', hearing && 'is-on')}
        aria-pressed={hearing}
        disabled={disabled !== null}
        title={disabled ?? undefined}
        onClick={() => onListen(which)}
      >
        {label}
      </button>
    );
  };

  return (
    <section className="compare-bar" aria-label="Compare A/B">
      <p className="compare-title">
        Compare A/B <span className="compare-note">this session only</span>
      </p>
      <div className="compare-row">
        {slot('a')}
        {slot('b')}
        {compare?.listening && modified ? (
          <button type="button" className="text-button" onClick={onUpdate}>
            Update {compare.listening.toUpperCase()}
          </button>
        ) : null}
        {compare ? (
          <>
            <button type="button" className="text-button" onClick={onKeep}>
              Keep current
            </button>
            <button type="button" className="text-button" disabled={disabled !== null} onClick={onExit}>
              Exit comparison
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
