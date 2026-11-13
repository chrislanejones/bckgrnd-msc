/**
 * The persistent transport: play/stop, what is playing, where in the song, the tempo,
 * the master meter and whether anything would be lost on a reload. It stays on screen
 * in every view at every width.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Library as LibraryIcon, OctagonX, Play, SlidersHorizontal, Square } from 'lucide-react';
import { engine } from '../lib/engine';
import { PARTS } from '../lib/stems';
import type { TrackArrangement } from '../lib/types';
import { StatusIndicator, cx } from './controls';

/** The meter's floor. Quieter than this reads as empty. */
const METER_FLOOR_DB = -48;
/** Above this the output is close to the limiter's −0.3 dBFS ceiling. */
const HOT_DB = -3;
/** How long the clip light stays lit after the last over, so a single over is seen. */
const CLIP_HOLD_MS = 2000;
/** How long a peak-hold tick stays before it falls back to the live level. */
const PEAK_HOLD_MS = 900;

const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const toFraction = (db: number) =>
  Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));

/**
 * The master output meter: left and right peak, a peak-hold tick, and a clip light.
 *
 * The peak is measured in the worklet over everything that leaves it, so it is the
 * level the speaker gets. Clip means a sample went past full scale. That can only
 * happen while a crossfade adds two decks together, since each deck's own limiter
 * holds it at −0.3 dBFS.
 */
export function MasterMeter() {
  const fills = useRef<Array<HTMLSpanElement | null>>([]);
  const ticks = useRef<Array<HTMLSpanElement | null>>([]);
  const readout = useRef<HTMLSpanElement>(null);
  const hold = useRef([
    { db: -Infinity, at: 0 },
    { db: -Infinity, at: 0 },
  ]);
  const [clipping, setClipping] = useState(false);
  const clipTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = engine.subscribe((t) => {
      const now = performance.now();
      let loudest = -Infinity;
      for (let ch = 0; ch < 2; ch += 1) {
        const db = toDb(t.peak[ch] ?? 0);
        loudest = Math.max(loudest, db);
        const h = hold.current[ch]!;
        if (db >= h.db || now - h.at > PEAK_HOLD_MS) {
          h.db = db;
          h.at = now;
        }
        const fill = fills.current[ch];
        if (fill) {
          fill.style.transform = `scaleX(${toFraction(db)})`;
          fill.dataset.hot = db > HOT_DB ? 'yes' : 'no';
        }
        const tick = ticks.current[ch];
        if (tick) tick.style.left = `${toFraction(h.db) * 100}%`;
      }
      if (readout.current) {
        readout.current.textContent =
          loudest > METER_FLOOR_DB ? `${loudest.toFixed(1)} dB` : '−∞ dB';
      }
      if (t.clipped) {
        setClipping(true);
        window.clearTimeout(clipTimer.current);
        clipTimer.current = window.setTimeout(() => setClipping(false), CLIP_HOLD_MS);
      }
    });
    return () => {
      unsubscribe();
      window.clearTimeout(clipTimer.current);
    };
  }, []);

  return (
    <div className="master-meter" role="group" aria-label="Master output">
      <div className="master-meter-bars" aria-hidden="true">
        {(['L', 'R'] as const).map((ch, i) => (
          <div key={ch} className="master-meter-row">
            <span className="master-meter-ch">{ch}</span>
            <span className="master-meter-well">
              <span
                className="master-meter-fill"
                ref={(el) => {
                  fills.current[i] = el;
                }}
              />
              <span
                className="master-meter-tick"
                ref={(el) => {
                  ticks.current[i] = el;
                }}
              />
            </span>
          </div>
        ))}
      </div>
      <span className="master-meter-readout" aria-hidden="true" ref={readout}>
        −∞ dB
      </span>
      <span
        className={cx('clip-light', clipping && 'is-on')}
        role="status"
        aria-label={clipping ? 'Master is clipping' : 'Master is not clipping'}
      >
        Clip
      </span>
    </div>
  );
}

export function TransportBar({
  track,
  playing,
  bar,
  bpm,
  edited,
  projects,
  mixing,
  liveDeck,
  onTogglePlay,
  onPanic,
  libraryToggle,
  inspectorToggle,
}: {
  track: TrackArrangement;
  playing: boolean;
  bar: number;
  bpm: number;
  edited: boolean;
  projects?: ReactNode;
  mixing: string | null;
  liveDeck: 'a' | 'b';
  onTogglePlay: () => void;
  /** Present when Panic lives in the bar (every width but the phone's, which docks it). */
  onPanic?: () => void;
  /** Present when the library is an overlay; opens it. */
  libraryToggle?: { open: boolean; onToggle: () => void };
  /** Present when the inspector can give its column back to the decks; hides it. */
  inspectorToggle?: { open: boolean; onToggle: () => void };
}) {
  const part = Math.floor(bar / 4);
  return (
    <header className="transport" aria-label="Transport">
      <div className="transport-brand">
        {libraryToggle ? (
          <button
            type="button"
            className="icon-button"
            aria-label={libraryToggle.open ? 'Close the library' : 'Open the library'}
            aria-expanded={libraryToggle.open}
            aria-controls="library"
            onClick={libraryToggle.onToggle}
          >
            <LibraryIcon className="size-4" aria-hidden />
          </button>
        ) : null}
        <h1 className="wordmark">bckgrnd-msc</h1>
      </div>

      <button
        type="button"
        className="play tap"
        aria-label={playing ? 'Stop the track' : 'Play the track'}
        aria-pressed={playing}
        aria-keyshortcuts="Space"
        onClick={onTogglePlay}
      >
        <span className="grid place-items-center">
          <Play className="icon-swap size-5" data-on={playing ? 'false' : 'true'} strokeWidth={2.4} aria-hidden />
          <Square className="icon-swap size-4" data-on={playing ? 'true' : 'false'} strokeWidth={2.4} aria-hidden />
        </span>
      </button>

      <div className="now-playing">
        <p className="now-title">
          {/* The deck letter needs the decks beside it; a phone shows one view at a time. */}
          <span className="now-deck">
            <span className={liveDeck === 'a' ? 'text-acid' : 'text-deck-b'}>{liveDeck.toUpperCase()}</span>
            <span className="text-muted"> · </span>
          </span>
          <span className="truncate" title={track.name}>{track.name}</span>
        </p>
        <p className="now-sub">
          {/* On a phone the tempo rides under the name instead of taking its own column. */}
          <span className="now-sub-bpm">{bpm} BPM · </span>
          {mixing ? `Mixing into ${mixing}` : [track.section, track.style].filter(Boolean).join(' · ')}
        </p>
      </div>

      <div className="song-position" role="group" aria-label="Song position">
        <ol className="part-chips">
          {PARTS.map((name, i) => (
            <li key={name} className={cx('part-chip', playing && i === part && 'is-on')} aria-current={playing && i === part ? 'step' : undefined}>
              {name}
            </li>
          ))}
        </ol>
        <p className="bar-readout">
          {playing ? (
            <>
              <span className="bar-word">Bar </span>
              <span className="tabular-nums">{String(bar + 1).padStart(2, '0')}</span>
              <span className="text-muted">/16</span>
            </>
          ) : (
            'Stopped'
          )}
        </p>
      </div>

      <p className="tempo-readout" aria-label={`Tempo ${bpm} BPM`}>
        <span className="tabular-nums">{bpm}</span>
        <span className="value-unit"> BPM</span>
      </p>

      <MasterMeter />

      {projects ?? <div className="save-status">
        {edited ? (
          <StatusIndicator state="warn" label="Edited · not saved" />
        ) : (
          <StatusIndicator state="idle" label="Track as written" />
        )}
      </div>}

      {onPanic ? <PanicButton onPanic={onPanic} /> : null}

      {inspectorToggle ? (
        <button
          type="button"
          className="icon-button inspector-toggle"
          aria-label={inspectorToggle.open ? 'Hide the inspector' : 'Show the inspector'}
          aria-expanded={inspectorToggle.open}
          aria-controls="inspector"
          onClick={inspectorToggle.onToggle}
        >
          <SlidersHorizontal className="size-4" aria-hidden />
        </button>
      ) : null}
    </header>
  );
}

/**
 * Panic stops everything and clears the tails. It sits in chrome that never scrolls away
 * (the bar, or the phone's bottom dock) so it is one press from any view. Its name is
 * always "Panic", even where only the stop sign shows.
 */
export function PanicButton({ onPanic, className }: { onPanic: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={cx('panic-button', className)}
      aria-label="Panic"
      title="Panic: stop everything and clear the tails"
      onClick={onPanic}
    >
      <OctagonX className="size-4 shrink-0" strokeWidth={2.2} aria-hidden />
      <span className="panic-word">Panic</span>
    </button>
  );
}
