/**
 * Compare A/B: two mixes of the same track, heard on the same engine and playhead.
 *
 * Kept visibly apart from Deck A / Deck B, which are two tracks. Session-only: the
 * bar says so, and nothing here is labeled saved. Listening never overwrites A or
 * B; replacing one takes Update. Keep Current adopts what is playing as the working
 * mix; Exit Comparison brings back the mix from before the first capture.
 */

import { CopyPlus, Headphones } from 'lucide-react';
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
  const hint = !compare
    ? 'Capture A, adjust the mix, then capture B.'
    : !compare.a
      ? 'Adjust the mix, then capture A.'
      : !compare.b
        ? 'Adjust the mix, then capture B.'
        : 'Switch A/B to hear the difference.';
  const slot = (which: 'a' | 'b') => {
    const name = which.toUpperCase();
    const stored = compare?.[which] ?? null;
    if (!stored) {
      return (
        <button
          key={which}
          type="button"
          className="compare-chip is-empty"
          disabled={disabled !== null}
          title={disabled ?? `Capture the current mix as ${name}, for this session`}
          onClick={() => onCapture(which)}
        >
          <CopyPlus size={16} aria-hidden="true" />
          <span>Capture {name}</span>
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
        data-queued={queued === target ? 'yes' : undefined}
        data-modified={hearing && modified ? 'yes' : undefined}
        aria-pressed={hearing}
        disabled={disabled !== null}
        title={disabled ?? `Listen to mix ${name}`}
        onClick={() => onListen(which)}
      >
        <Headphones size={16} aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <section className="compare-bar" aria-label="Compare A/B" aria-describedby="compare-hint">
      <div className="compare-heading">
        <p className="compare-title">
          Compare A/B <span className="compare-note">Session only</span>
        </p>
        <p className="compare-hint" id="compare-hint">{hint}</p>
      </div>
      <div className="compare-slots">
        {slot('a')}
        {slot('b')}
      </div>
      {compare ? (
        <div className="compare-row">
          {compare.listening && modified ? (
            <button type="button" className="text-button" disabled={disabled !== null} onClick={onUpdate}>
              Update {compare.listening.toUpperCase()}
            </button>
          ) : null}
          <button type="button" className="text-button" disabled={disabled !== null} onClick={onKeep}>
            Keep current
          </button>
          <button
            type="button"
            className="text-button compare-exit"
            disabled={disabled !== null}
            title="Restore the mix from before the first capture"
            onClick={onExit}
          >
            Exit comparison
          </button>
        </div>
      ) : null}
    </section>
  );
}
