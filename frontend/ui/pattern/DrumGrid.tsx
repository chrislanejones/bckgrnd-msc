/**
 * The four drum lanes for one bar: paint hits on and off, one row at a time.
 *
 * - **Paint mode is decided where the gesture starts.** Pressing an empty step paints
 *   hits onto every step the pointer crosses in that row; pressing a hit erases.
 *   Crossing a step twice does not toggle it back. Releasing commits the whole row
 *   change as one undoable edit; a cancelled pointer commits nothing.
 * - **Three treatments that never share a look:** content is a fill (brighter for a
 *   louder hit), selection is an outline, the playhead is a narrow tick at the foot
 *   of its column. Steps 1, 5, 9 and 13 start a beat group.
 * - **Keyboard:** one cell in the grid is in the tab order; arrows move, Enter or
 *   Space toggles. Space here is the cell's, not play/stop.
 */

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Lock } from 'lucide-react';
import { laneSpec, type DrumEvent, type LaneId, type Pattern } from '../../lib/patterns';
import { cx } from '../controls';
import { beatGroups, pct, type Viewport } from './shared';

type Drag = { lane: LaneId; mode: 'add' | 'remove'; steps: Set<number>; pointerId: number };

export function DrumGrid({
  lanes,
  view,
  playStep,
  focusLane,
  selection,
  lockedLanes,
  lockedEvents,
  disabled,
  onFocusLane,
  onPaint,
}: {
  lanes: Pattern[];
  view: Viewport;
  /** The step playing, as a song step, or -1. */
  playStep: number;
  focusLane: LaneId;
  selection: ReadonlySet<string>;
  lockedLanes: readonly LaneId[];
  lockedEvents: ReadonlySet<string>;
  disabled: boolean;
  onFocusLane: (lane: LaneId) => void;
  /** A finished gesture: these steps of `lane` painted on or off. */
  onPaint: (lane: LaneId, steps: number[], mode: 'add' | 'remove') => void;
}) {
  const [drag, setDragState] = useState<Drag | null>(null);
  // Read through a ref: pointerup and lostpointercapture arrive back to back, before
  // a re-render, and the gesture must commit once.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [cursor, setCursor] = useState<{ lane: number; col: number }>({ lane: 0, col: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const base = view.bar * 16;
  const groups = beatGroups(view.cols);

  const hitAt = (p: Pattern, step: number) => p.events.find((e) => e.step === step) as DrumEvent | undefined;

  function begin(e: PointerEvent, lane: LaneId, step: number, has: boolean) {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    rootRef.current?.setPointerCapture(e.pointerId);
    onFocusLane(lane);
    setDrag({ lane, mode: has ? 'remove' : 'add', steps: new Set([step]), pointerId: e.pointerId });
  }

  function move(e: PointerEvent) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-drum-cell]');
    if (!el || el.dataset.lane !== drag.lane) return;
    const step = Number(el.dataset.step);
    if (!drag.steps.has(step)) setDrag({ ...drag, steps: new Set(drag.steps).add(step) });
  }

  function end(e: PointerEvent, commit: boolean) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    setDrag(null);
    if (commit) onPaint(drag.lane, [...drag.steps], drag.mode);
  }

  function onKey(e: KeyboardEvent, laneIndex: number, col: number) {
    const ci = view.cols.indexOf(col);
    let next: { lane: number; col: number } | null = null;
    if (e.key === 'ArrowRight') next = { lane: laneIndex, col: view.cols[Math.min(view.cols.length - 1, ci + 1)]! };
    else if (e.key === 'ArrowLeft') next = { lane: laneIndex, col: view.cols[Math.max(0, ci - 1)]! };
    else if (e.key === 'ArrowDown') next = { lane: Math.min(lanes.length - 1, laneIndex + 1), col };
    else if (e.key === 'ArrowUp') next = { lane: Math.max(0, laneIndex - 1), col };
    else if (e.key === 'Home') next = { lane: laneIndex, col: view.cols[0]! };
    else if (e.key === 'End') next = { lane: laneIndex, col: view.cols.at(-1)! };
    if (!next) return;
    e.preventDefault();
    setCursor(next);
    const lane = lanes[next.lane];
    if (lane) onFocusLane(lane.lane);
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-drum-cell][data-row="${next.lane}"][data-col="${next.col}"]`)
      ?.focus();
  }

  const cursorCol = view.cols.includes(cursor.col) ? cursor.col : view.cols[0]!;

  return (
    <div
      ref={rootRef}
      className={cx('drum-grid', disabled && 'is-disabled')}
      role="group"
      aria-label={`Drum steps, bar ${view.bar + 1}`}
      onPointerMove={move}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onLostPointerCapture={(e) => end(e, true)}
    >
      {lanes.map((p, laneIndex) => {
        const spec = laneSpec(p.lane);
        const laneLocked = lockedLanes.includes(p.lane);
        return (
          <div key={p.lane} className={cx('drum-row', focusLane === p.lane && 'is-focus')}>
            <button
              type="button"
              className="drum-lane-name"
              aria-pressed={focusLane === p.lane}
              onClick={() => onFocusLane(p.lane)}
            >
              {spec.label}
              {laneLocked ? <Lock className="size-3" aria-label="locked" /> : null}
            </button>
            <div className="step-groups">
              {groups.map((g) => (
                <div key={g[0]} className="step-group">
                  {g.map((col) => {
                    const step = base + col;
                    const hit = hitAt(p, step);
                    let on = Boolean(hit);
                    if (drag && drag.lane === p.lane && drag.steps.has(step)) on = drag.mode === 'add';
                    const vel = hit?.vel ?? spec.velocity;
                    const isCursor = laneIndex === cursor.lane && col === cursorCol;
                    return (
                      <button
                        key={col}
                        type="button"
                        data-drum-cell=""
                        data-own-space=""
                        data-lane={p.lane}
                        data-step={step}
                        data-row={laneIndex}
                        data-col={col}
                        tabIndex={isCursor ? 0 : -1}
                        className={cx(
                          'drum-cell',
                          on && 'is-on',
                          hit && selection.has(hit.id) && focusLane === p.lane && 'is-selected',
                          hit && lockedEvents.has(`${p.lane}:${hit.id}`) && 'is-locked',
                          step === playStep && 'is-playhead',
                        )}
                        style={on ? ({ '--vel': vel } as React.CSSProperties) : undefined}
                        aria-pressed={Boolean(hit)}
                        aria-disabled={disabled || undefined}
                        aria-label={`${spec.label}, step ${col + 1}${hit ? `, hit at ${pct(hit.vel)}%` : ''}`}
                        onPointerDown={(e) => begin(e, p.lane, step, Boolean(hit))}
                        onFocus={() => setCursor({ lane: laneIndex, col })}
                        onKeyDown={(e) => onKey(e, laneIndex, col)}
                        onClick={(e) => {
                          // Pointer gestures commit on release; this is the keyboard's toggle.
                          if (e.detail !== 0 || disabled) return;
                          onFocusLane(p.lane);
                          onPaint(p.lane, [step], hit ? 'remove' : 'add');
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
