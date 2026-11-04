/**
 * The vertical fader: a mixer channel's level, shaped like the hardware it imitates.
 *
 * - **What it shows is the setting.** The cap sits at the stored value and never
 *   moves with the music; the meter beside it (a separate element, see
 *   `ChannelMeter`) is what moves. Muting a stem dims its channel but leaves the cap
 *   where the level is stored, so a cut never looks like a fader pulled to zero.
 * - **The default marker** is the track's own value for this stem, not a shared
 *   default: each stem's sits at its own height and only moves when the track does.
 * - **Under the hand.** Grabbing anywhere on the rail starts a relative drag from the
 *   current value, so the cap never jumps to the pointer. Shift is ten times finer.
 *   Pointer capture keeps the drag when the finger leaves the rail, and every way a
 *   drag can end (release, cancel, lost capture, the window losing focus) ends it.
 * - **Without dragging.** The readout is a button: click or tap it to type a value,
 *   the single-pointer alternative to a drag. Reset sits below with Solo and Cut.
 * - **Keyboard and assistive technology.** As with the knob, the accessible control
 *   is a native `<input type="range">`, laid over the rail, vertical, with
 *   `aria-valuetext`: arrows step 1% (Shift 0.1%), Page Up/Down 10%, Home/End the
 *   ends, Delete resets, Enter types a value. Touch screen readers adjust it as a
 *   platform slider.
 * - **One edit per gesture**: a whole drag, a held key or a typed value is one entry
 *   in the edit log.
 */

import { memo, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { editHistory } from '../lib/history';
import { cx } from './controls';

/** The native range's resolution. */
const RANGE = 1000;
const EPS = 1e-6;
/** Ticks drawn on the scale, as fractions of the travel; the strong ones are labelled. */
const TICKS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const STRONG = new Set([0, 0.5, 1]);

export type FaderFormat = {
  /** The value as a short readout, e.g. "72%". */
  text: (value: number) => string;
  /** The value in words for assistive technology, e.g. "72 percent". */
  speak: (value: number) => string;
  /** A typed value back to the stored number, or null if it cannot be read. */
  parse: (text: string) => number | null;
};

/** A 0..1 level shown as a whole percentage, as the stem faders always have been. */
export const PERCENT: FaderFormat = {
  text: (v) => `${Math.round(v * 100)}%`,
  speak: (v) => `${Math.round(v * 100)} percent`,
  parse: (t) => {
    const m = t.replace(',', '.').match(/-?\d*\.?\d+/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n / 100 : null;
  },
};

type Props = {
  /** The accessible name, e.g. "Kick volume". */
  label: string;
  value: number;
  min: number;
  max: number;
  /** The track's own value, where Reset goes and the marker sits. */
  defaultValue: number;
  format: FaderFormat;
  onChange: (value: number) => void;
  /** Recorded in the edit log once per finished gesture. */
  historyId?: string;
  disabled?: boolean;
  /** Dimmed (cut, or out of a solo). The cap stays where the value is. */
  dimmed?: boolean;
};

export const VerticalFader = memo(function VerticalFader({
  label,
  value,
  min,
  max,
  defaultValue,
  format,
  onChange,
  historyId,
  disabled = false,
  dimmed = false,
}: Props) {
  const inputId = useId();
  const span = max - min;
  const norm = Math.min(1, Math.max(0, (value - min) / span));
  const home = Math.min(1, Math.max(0, (defaultValue - min) / span));
  const modified = Math.abs(value - defaultValue) > EPS;

  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);

  const railRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const drag = useRef<{ id: number; from: number; norm: number; lastY: number; travel: number } | null>(
    null,
  );
  const keyFrom = useRef<number | null>(null);

  const emit = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(min, next));
      if (Math.abs(clamped - valueRef.current) <= EPS) return;
      valueRef.current = clamped;
      onChange(clamped);
    },
    [max, min, onChange],
  );

  const commit = useCallback(
    (from: number) => {
      const to = valueRef.current;
      if (historyId && Math.abs(to - from) > EPS) editHistory.record(historyId, from, to);
    },
    [historyId],
  );

  const reset = useCallback(() => {
    if (disabled) return;
    const from = valueRef.current;
    emit(defaultValue);
    commit(from);
  }, [commit, defaultValue, disabled, emit]);

  // ---- Pointer: relative drag, never a jump ---------------------------------

  const endDrag = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    commit(d.from);
  }, [commit]);

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

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button > 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    rangeRef.current?.focus({ preventScroll: true });
    const travel = railRef.current?.getBoundingClientRect().height ?? 180;
    drag.current = {
      id: event.pointerId,
      from: valueRef.current,
      norm: (valueRef.current - min) / span,
      lastY: event.clientY,
      travel: Math.max(40, travel),
    };
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || event.pointerId !== d.id) return;
    const dy = d.lastY - event.clientY;
    d.lastY = event.clientY;
    if (dy === 0) return;
    const fine = event.shiftKey ? 10 : 1;
    d.norm = Math.min(1, Math.max(0, d.norm + dy / d.travel / fine));
    emit(min + d.norm * span);
  };

  // ---- Keyboard -------------------------------------------------------------

  const stepBy = (fraction: number) => emit(valueRef.current + fraction * span);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const fine = event.shiftKey ? 0.1 : 1;
    const start = () => {
      if (keyFrom.current === null) keyFrom.current = valueRef.current;
    };
    let handled = true;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        start();
        stepBy(0.01 * fine);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        start();
        stepBy(-0.01 * fine);
        break;
      case 'PageUp':
        start();
        stepBy(0.1);
        break;
      case 'PageDown':
        start();
        stepBy(-0.1);
        break;
      case 'Home':
        start();
        emit(min);
        break;
      case 'End':
        start();
        emit(max);
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

  const endKeys = () => {
    if (keyFrom.current === null) return;
    const from = keyFrom.current;
    keyFrom.current = null;
    commit(from);
  };

  // ---- Typed values -----------------------------------------------------------

  const beginEdit = () => {
    if (disabled) return;
    setDraft(format.text(valueRef.current).replace('%', ''));
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
      const parsed = format.parse(draft);
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

  return (
    <div
      className={cx('vfader', dimmed && 'is-dimmed')}
      data-dragging={dragging ? 'yes' : undefined}
      data-disabled={disabled ? 'yes' : undefined}
      data-modified={modified ? 'yes' : undefined}
      data-value={value}
      style={{ '--pos': norm, '--home': home } as CSSProperties}
    >
      {editing ? (
        <input
          ref={editRef}
          className="vfader-edit"
          type="text"
          inputMode="decimal"
          aria-label={`${label}, percent`}
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
          onBlur={() => finishEdit(format.parse(draft) !== null)}
        />
      ) : (
        <button
          type="button"
          className="vfader-readout"
          disabled={disabled}
          aria-label={`${label}: ${format.speak(value)}. Type a value`}
          onClick={beginEdit}
        >
          {format.text(value)}
        </button>
      )}
      <div
        className="vfader-body"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={reset}
      >
        <div className="vfader-scale" aria-hidden="true">
          {TICKS.map((t) => (
            <span
              key={t}
              className={cx('vfader-tick', STRONG.has(t) && 'is-strong')}
              style={{ bottom: `${t * 100}%` }}
            />
          ))}
        </div>
        <div ref={railRef} className="vfader-rail">
          <input
            ref={rangeRef}
            id={inputId}
            className="vfader-input"
            type="range"
            min={0}
            max={RANGE}
            step={10}
            value={Math.round(norm * RANGE)}
            disabled={disabled}
            aria-label={label}
            aria-orientation="vertical"
            aria-valuetext={format.speak(value)}
            aria-keyshortcuts="Enter Delete"
            onChange={(event) => {
              const from = valueRef.current;
              emit(min + (Number(event.target.value) / RANGE) * span);
              if (keyFrom.current === null && !drag.current) commit(from);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={endKeys}
            onBlur={endKeys}
          />
          <span className="vfader-fill" aria-hidden="true" />
          <span className="vfader-home" aria-hidden="true" title="The track's own level" />
          <span className="vfader-cap" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
});
