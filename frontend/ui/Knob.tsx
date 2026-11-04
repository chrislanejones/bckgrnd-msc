/**
 * The knob. One implementation for every continuous control that turns.
 *
 * - **It turns.** A 270° sweep from the bottom-left stop to the bottom-right, and the
 *   indicator's angle is computed from the real parameter value through its mapping
 *   (frequency, gain and time each have their own), so what the knob shows is what
 *   the engine has. Only the indicator rotates: the face, its lighting, the ticks and
 *   the arc track stay put, so the light never swings round with the pointer.
 * - **Under the hand.** Drag up or down (or round, in circular mode), with pointer
 *   capture so the drag survives leaving the knob. Shift slows it ten times. Every way
 *   a drag can end (release, cancel, losing capture, the window losing focus) ends it,
 *   so a finger lifted off the screen never leaves the knob held. Circular drag works
 *   in angle *differences*, wrapped to ±180°, so crossing the bottom gap or the top
 *   never makes the value jump.
 * - **Keyboard and assistive technology.** The accessible control is a real
 *   `<input type="range">`, visually hidden over the dial. It is what takes focus, so
 *   arrow keys, Page Up/Down and Home/End work, and touch screen readers (VoiceOver's
 *   and TalkBack's swipe-to-adjust) adjust it as a platform slider. W3C warns that
 *   custom ARIA sliders often fail exactly there; a native range does not. Its
 *   `aria-valuetext` is the value in words.
 * - **Reset and entry.** Double-click or double-tap the dial, press Delete, or use the
 *   Reset badge. Click the value, or press Enter, to type one.
 * - **One edit per gesture.** `onChange` fires as the value moves; `onCommit` once, with
 *   where it started and where it ended, when the gesture is over.
 */

import { RotateCcw } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { editHistory } from '../lib/history';
import type { Mapping } from '../lib/mappings';
import { cx } from './controls';
import { useKnobDrag } from './knobPrefs';

/** The sweep, in degrees either side of twelve o'clock. */
const HALF_SWEEP = 135;
/** Vertical travel, in CSS pixels, for the whole sweep. Shift makes it ten times longer. */
const DRAG_PX = 180;
/** Two taps within this long, and this close, are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 12;
/** How long an outside change (a reset, a mix landing) stays highlighted. */
const UPDATED_MS = 700;
/** The native range's resolution: positions 0..RANGE across the sweep. */
const RANGE = 1000;

const EPS = 1e-6;

type Props = {
  /** Shown above the knob and used as the accessible name. */
  label: string;
  value: number;
  mapping: Mapping;
  /** Where Reset goes. */
  defaultValue: number;
  onChange: (value: number) => void;
  /** Once per finished gesture, with its start and end values. */
  onCommit?: (from: number, to: number) => void;
  /** The parameter id finished gestures are recorded under in the edit log. */
  historyId?: string;
  disabled?: boolean;
  /**
   * A short line under the value, for a state that changes what the knob does. Pass ''
   * while there is nothing to say: the line keeps its space, so the rack does not jump
   * when a note comes and goes.
   */
  note?: string;
  size?: 'md' | 'sm';
};

function angleFor(norm: number): number {
  return -HALF_SWEEP + norm * 2 * HALF_SWEEP;
}

/** A point on the dial's circle at `deg` (0 is twelve o'clock, clockwise). */
function point(deg: number, r: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [50 + r * Math.sin(rad), 50 - r * Math.cos(rad)];
}

function arc(from: number, to: number, r: number): string {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  if (b - a < 0.01) return '';
  const [x0, y0] = point(a, r);
  const [x1, y1] = point(b, r);
  const large = b - a > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const TICKS = Array.from({ length: 11 }, (_, i) => i / 10);
const TRACK = arc(-HALF_SWEEP, HALF_SWEEP, 44);

export const Knob = memo(function Knob({
  label,
  value,
  mapping,
  defaultValue,
  onChange,
  onCommit,
  historyId,
  disabled = false,
  note,
  size = 'md',
}: Props) {
  const inputId = useId();
  const noteId = useId();
  const mode = useKnobDrag();
  const norm = mapping.toNorm(value);
  const angle = angleFor(norm);
  const centerNorm = mapping.center === undefined ? 0 : mapping.toNorm(mapping.center);
  const modified = Math.abs(value - defaultValue) > EPS;

  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [updated, setUpdated] = useState(false);

  const rangeRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const dialRef = useRef<HTMLDivElement>(null);

  // Gesture state lives in refs: it changes on every pointer move and must not
  // re-render on each one.
  const drag = useRef<{
    id: number;
    from: number;
    norm: number;
    lastY: number;
    lastAngle: number;
    moved: boolean;
  } | null>(null);
  const keyFrom = useRef<number | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  /** The last value this knob itself produced, to tell an outside change from ours. */
  const emitted = useRef(value);
  const valueRef = useRef(value);
  valueRef.current = value;

  // An outside change (a reset elsewhere, a mix landing, a project load) flashes the
  // readout briefly, so a knob that moved without being touched is noticed.
  useEffect(() => {
    if (Math.abs(value - emitted.current) <= EPS || drag.current) return;
    emitted.current = value;
    setUpdated(true);
    const t = window.setTimeout(() => setUpdated(false), UPDATED_MS);
    return () => window.clearTimeout(t);
  }, [value]);

  const emit = useCallback(
    (next: number) => {
      const v = mapping.quantize ? mapping.quantize(next) : next;
      const clamped = Math.min(mapping.max, Math.max(mapping.min, v));
      if (Math.abs(clamped - valueRef.current) <= EPS) return;
      emitted.current = clamped;
      valueRef.current = clamped;
      onChange(clamped);
    },
    [mapping, onChange],
  );

  const commit = useCallback(
    (from: number) => {
      const to = valueRef.current;
      if (Math.abs(to - from) <= EPS) return;
      if (historyId) editHistory.record(historyId, from, to);
      onCommit?.(from, to);
    },
    [historyId, onCommit],
  );

  const reset = useCallback(() => {
    if (disabled) return;
    const from = valueRef.current;
    emit(defaultValue);
    commit(from);
  }, [commit, defaultValue, disabled, emit]);

  // ---- Pointer ------------------------------------------------------------

  const endDrag = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    // Only a tap can be the first half of a double tap; a drag that ended here is not.
    if (d.moved) lastTap.current = null;
    setDragging(false);
    commit(d.from);
  }, [commit]);

  // A drag also ends if the window loses focus or the page is hidden mid-gesture
  // (an alert, an app switch on a phone): the pointer-up would never arrive. While
  // it lasts, nothing on the page can be text-selected by the moving pointer.
  useEffect(() => {
    if (!dragging) return;
    const end = () => endDrag();
    const hidden = () => document.visibilityState === 'hidden' && endDrag();
    window.addEventListener('blur', end);
    document.addEventListener('visibilitychange', hidden);
    document.documentElement.dataset.controlDrag = 'yes';
    window.getSelection()?.removeAllRanges();
    return () => {
      window.removeEventListener('blur', end);
      document.removeEventListener('visibilitychange', hidden);
      delete document.documentElement.dataset.controlDrag;
    };
  }, [dragging, endDrag]);

  const angleAt = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - (box.left + box.width / 2);
    const y = event.clientY - (box.top + box.height / 2);
    return (Math.atan2(x, -y) * 180) / Math.PI;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button > 0) return;
    event.preventDefault();
    // Double tap or double click resets, for a mouse and a finger alike.
    const now = event.timeStamp;
    const tap = lastTap.current;
    if (
      tap &&
      now - tap.t < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < DOUBLE_TAP_PX
    ) {
      lastTap.current = null;
      reset();
      return;
    }
    lastTap.current = { t: now, x: event.clientX, y: event.clientY };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    rangeRef.current?.focus({ preventScroll: true });
    drag.current = {
      id: event.pointerId,
      from: valueRef.current,
      norm: mapping.toNorm(valueRef.current),
      lastY: event.clientY,
      lastAngle: angleAt(event),
      moved: false,
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    const fine = event.shiftKey ? 10 : 1;
    let delta: number;
    if (mode === 'circular') {
      const a = angleAt(event);
      // Differences, wrapped to ±180, so crossing ±180 (straight down) is a small
      // step and not a jump of a whole turn.
      let da = a - d.lastAngle;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      d.lastAngle = a;
      delta = da / (2 * HALF_SWEEP) / fine;
    } else {
      const dy = d.lastY - event.clientY;
      delta = dy / DRAG_PX / fine;
    }
    d.lastY = event.clientY;
    if (delta === 0) return;
    d.moved = true;
    d.norm = Math.min(1, Math.max(0, d.norm + delta));
    emit(mapping.fromNorm(d.norm));
  };

  // ---- Keyboard -----------------------------------------------------------

  const stepBy = (steps: number) => {
    const n = mapping.toNorm(valueRef.current) + steps * mapping.keyStep;
    emit(mapping.fromNorm(Math.min(1, Math.max(0, n))));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const fine = event.shiftKey ? 0.1 : 1;
    let handled = true;
    const start = () => {
      if (keyFrom.current === null) keyFrom.current = valueRef.current;
    };
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        start();
        stepBy(fine);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        start();
        stepBy(-fine);
        break;
      case 'PageUp':
        start();
        stepBy(10);
        break;
      case 'PageDown':
        start();
        stepBy(-10);
        break;
      case 'Home':
        start();
        emit(mapping.min);
        break;
      case 'End':
        start();
        emit(mapping.max);
        break;
      case 'Delete':
      case 'Backspace':
        reset();
        break;
      case 'Enter':
        beginEdit();
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  // A held key is one edit: it starts on the first keydown and ends when let go.
  const endKeys = () => {
    if (keyFrom.current === null) return;
    const from = keyFrom.current;
    keyFrom.current = null;
    commit(from);
  };

  // ---- Typed values -------------------------------------------------------

  const beginEdit = () => {
    if (disabled) return;
    setDraft(mapping.format(valueRef.current).text);
    setInvalid(false);
    setEditing(true);
  };

  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      editRef.current?.select();
    }
  }, [editing]);

  const finishEdit = (accept: boolean) => {
    if (accept) {
      const parsed = mapping.parse(draft);
      if (parsed === null) {
        setInvalid(true);
        return;
      }
      const from = valueRef.current;
      emit(parsed);
      commit(from);
    }
    setEditing(false);
    rangeRef.current?.focus({ preventScroll: true });
  };

  // ---- Render -------------------------------------------------------------

  const shown = mapping.format(value);
  const spoken = mapping.speak(value);
  const valueArc = arc(angleFor(centerNorm), angle, 44);

  return (
    <div
      className={cx('knob', size === 'sm' && 'knob-sm')}
      data-dragging={dragging ? 'yes' : undefined}
      data-disabled={disabled ? 'yes' : undefined}
      data-modified={modified ? 'yes' : undefined}
      data-updated={updated ? 'yes' : undefined}
      // The exact value and sweep position, for diagnostics and tests. The native range
      // below is stepped for keyboards and screen readers, so its own value is rounded.
      data-value={value}
      data-norm={norm}
    >
      <label className="control-label knob-label" htmlFor={inputId}>
        {label}
      </label>
      <div
        ref={dialRef}
        className="knob-dial"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <input
          ref={rangeRef}
          id={inputId}
          className="knob-input"
          type="range"
          min={0}
          max={RANGE}
          step={Math.max(1, Math.round(mapping.keyStep * RANGE))}
          value={Math.round(norm * RANGE)}
          disabled={disabled}
          aria-valuetext={spoken}
          aria-describedby={note ? noteId : undefined}
          aria-keyshortcuts="Enter Delete"
          // Screen readers and anything else that sets the range directly. Each such
          // adjustment is a discrete step, so it is its own edit.
          onChange={(event) => {
            const from = valueRef.current;
            emit(mapping.fromNorm(Number(event.target.value) / RANGE));
            if (keyFrom.current === null && !drag.current) commit(from);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={endKeys}
          onBlur={endKeys}
        />
        <svg viewBox="0 0 100 100" aria-hidden="true" className="knob-svg">
          <defs>
            {/* Light from the top left, fixed: these gradients never rotate. */}
            <radialGradient id={`${inputId}-face`} cx="38%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#3a404b" />
              <stop offset="55%" stopColor="#22262d" />
              <stop offset="100%" stopColor="#15181d" />
            </radialGradient>
            <linearGradient id={`${inputId}-rim`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4a515d" />
              <stop offset="100%" stopColor="#0c0d10" />
            </linearGradient>
          </defs>
          {TICKS.map((t) => {
            const a = angleFor(t);
            const [x0, y0] = point(a, 49);
            const [x1, y1] = point(a, t === 0 || t === 1 || t === 0.5 ? 45 : 46.5);
            return <line key={t} className="knob-tick" x1={x0} y1={y0} x2={x1} y2={y1} />;
          })}
          <path className="knob-track" d={TRACK} />
          {valueArc ? <path className="knob-arc" d={valueArc} /> : null}
          <circle className="knob-shadow" cx="50" cy="53" r="33" />
          <circle cx="50" cy="50" r="34" fill={`url(#${inputId}-rim)`} />
          <circle cx="50" cy="50" r="31" fill={`url(#${inputId}-face)`} />
          <g className="knob-pointer" transform={`rotate(${angle.toFixed(2)} 50 50)`}>
            <line x1="50" y1="24" x2="50" y2="38" />
          </g>
        </svg>
      </div>
      {/* The amount, with Reset beside it, centered under the dial as a pair. Reset is
          always there, grayed out at the default, so nothing moves when a knob turns. */}
      <div className="knob-readout">
        {editing ? (
          <input
            ref={editRef}
            className="knob-edit"
            type="text"
            inputMode="decimal"
            aria-label={`${label} value`}
            aria-invalid={invalid || undefined}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                finishEdit(true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finishEdit(false);
              }
            }}
            onBlur={() => {
              if (mapping.parse(draft) !== null) finishEdit(true);
              else finishEdit(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="knob-value"
            disabled={disabled}
            aria-label={`${label}: ${spoken}. Type a value`}
            onClick={beginEdit}
          >
            {shown.text}
            {shown.unit ? <span className="value-unit"> {shown.unit}</span> : null}
          </button>
        )}
        <button
          type="button"
          className="knob-reset"
          disabled={disabled || !modified}
          aria-label={`Reset ${label.toLowerCase()}`}
          title="Reset"
          onClick={reset}
        >
          <RotateCcw aria-hidden="true" size={12} strokeWidth={2.5} />
        </button>
      </div>
      {note !== undefined ? (
        <span id={noteId} className="knob-note">
          {note}
        </span>
      ) : null}
    </div>
  );
});
