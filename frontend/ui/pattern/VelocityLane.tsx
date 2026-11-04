/**
 * Velocity for the focused drum lane: one slim bar per hit, under its step.
 *
 * - A step with no hit shows an empty marker, not a zero bar: there is nothing to
 *   make louder, and dragging can never create or delete a hit. Lowering a velocity
 *   stops at the floor (`MIN_VELOCITY`); taking a hit away is the grid's job.
 * - Press a bar to select it (Shift or Ctrl/Cmd adds to the selection). Drag it up
 *   or down to change it: if the bar is part of a selection, the whole selection
 *   follows, either all set to the same value or each scaled together, as the editor's
 *   mode says. One drag is one undoable edit, committed on release.
 * - Each bar is a slider for assistive technology and the keyboard: Up/Down 5%
 *   (Shift 1%), Home/End to the floor or full. Exact numbers go in the inspector.
 */

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { MIN_VELOCITY } from '../../lib/editing';
import { laneSpec, type DrumEvent, type Pattern } from '../../lib/patterns';
import { cx } from '../controls';
import { beatGroups, pct, type Viewport } from './shared';

type Drag = {
  pointerId: number;
  id: string;
  ids: string[];
  startY: number;
  startVel: number;
  height: number;
  moved: boolean;
  value: number;
  additive: boolean;
};

const clamp = (v: number) => Math.min(1, Math.max(MIN_VELOCITY, v));

export function VelocityLane({
  pattern,
  view,
  selection,
  mode,
  disabled,
  onSelect,
  onCommit,
}: {
  pattern: Pattern;
  view: Viewport;
  selection: ReadonlySet<string>;
  /** How a multi-selection moves together. */
  mode: 'set' | 'scale';
  disabled: boolean;
  onSelect: (ids: string[]) => void;
  /** A finished change: `ids` set to `value`, or scaled by it. */
  onCommit: (ids: string[], how: 'set' | 'scale', value: number) => void;
}) {
  const spec = laneSpec(pattern.lane);
  const base = view.bar * 16;
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const hits = new Map<number, DrumEvent>();
  for (const e of pattern.events) hits.set(e.step, e as DrumEvent);

  /** What a bar shows mid-drag. */
  function shown(e: DrumEvent): number {
    if (!drag || !drag.moved || !drag.ids.includes(e.id)) return e.vel;
    if (drag.ids.length === 1 || mode === 'set') return drag.value;
    return clamp(e.vel * (drag.value / drag.startVel));
  }

  function begin(ev: PointerEvent<HTMLElement>, e: DrumEvent) {
    if (disabled || ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    ev.currentTarget.focus({ preventScroll: true });
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    const ids = selection.has(e.id) && !additive ? [...selection] : [e.id];
    const track = ev.currentTarget.parentElement?.getBoundingClientRect().height ?? 64;
    setDrag({
      pointerId: ev.pointerId,
      id: e.id,
      ids,
      startY: ev.clientY,
      startVel: e.vel,
      height: Math.max(24, track),
      moved: false,
      value: e.vel,
      additive,
    });
  }

  function move(ev: PointerEvent) {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.pointerId) return;
    const dy = d.startY - ev.clientY;
    if (!d.moved && Math.abs(dy) < 3) return;
    setDrag({ ...d, moved: true, value: clamp(d.startVel + dy / d.height) });
  }

  function end(ev: PointerEvent, commit: boolean) {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.pointerId) return;
    setDrag(null);
    if (!d.moved) {
      // A press without a drag selects.
      if (d.additive) {
        const next = new Set(selection);
        if (next.has(d.id)) next.delete(d.id);
        else next.add(d.id);
        onSelect([...next]);
      } else onSelect([d.id]);
      return;
    }
    if (!commit) return;
    if (d.ids.length > 1 && mode === 'scale') onCommit(d.ids, 'scale', d.value / d.startVel);
    else onCommit(d.ids, 'set', d.value);
  }

  function onKey(ev: KeyboardEvent, e: DrumEvent) {
    if (disabled) return;
    const step = ev.shiftKey ? 0.01 : 0.05;
    let value: number | null = null;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') value = e.vel + step;
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') value = e.vel - step;
    else if (ev.key === 'Home') value = MIN_VELOCITY;
    else if (ev.key === 'End') value = 1;
    if (value === null) return;
    ev.preventDefault();
    onCommit([e.id], 'set', clamp(value));
  }

  return (
    <div className={cx('velocity-lane', disabled && 'is-disabled')} aria-label={`${spec.label} velocity`} role="group">
      <span className="velocity-label" aria-hidden>
        Velocity
      </span>
      <div className="step-groups">
        {beatGroups(view.cols).map((g) => (
          <div key={g[0]} className="step-group">
            {g.map((col) => {
              const e = hits.get(base + col);
              if (!e) {
                return (
                  <span key={col} className="velocity-slot is-empty" aria-hidden>
                    <span className="velocity-none" />
                  </span>
                );
              }
              const v = shown(e);
              return (
                <span key={col} className="velocity-slot">
                  <span
                    role="slider"
                    tabIndex={0}
                    data-velocity=""
                    aria-label={`${spec.label} step ${col + 1} velocity`}
                    aria-valuemin={Math.round(MIN_VELOCITY * 100)}
                    aria-valuemax={100}
                    aria-valuenow={pct(v)}
                    aria-valuetext={`${pct(v)}%`}
                    aria-orientation="vertical"
                    aria-disabled={disabled || undefined}
                    className={cx('velocity-bar', selection.has(e.id) && 'is-selected')}
                    style={{ '--vel': v } as React.CSSProperties}
                    onPointerDown={(ev) => begin(ev, e)}
                    onPointerMove={move}
                    onPointerUp={(ev) => end(ev, true)}
                    onPointerCancel={(ev) => end(ev, false)}
                    onLostPointerCapture={(ev) => end(ev, true)}
                    onKeyDown={(ev) => onKey(ev, e)}
                  >
                    <span className="velocity-fill" />
                    <span className="velocity-grip" />
                  </span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
