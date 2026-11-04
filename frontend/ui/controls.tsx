/**
 * The control shells. Every control in the app is built from these, so labels,
 * readouts, sizes, states and focus look and behave the same everywhere
 * (docs/DESIGN_PHILOSOPHY.md, "Control shells").
 *
 * They are presentational: they take values and callbacks and know nothing about the
 * engine. The one exception is `StemMeter`, which subscribes to telemetry itself so a
 * 30 Hz stream is written straight to the DOM instead of re-rendering the tree.
 */

import { useEffect, useId, useRef } from 'react';
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import { engine } from '../lib/engine';
import { editHistory } from '../lib/history';
import type { StemState } from '../lib/stems';

export function cx(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(' ');
}

/** The uppercase name of a control. */
export function ControlLabel({
  children,
  htmlFor,
  id,
}: {
  children: ReactNode;
  htmlFor?: string;
  id?: string;
}) {
  return htmlFor ? (
    <label className="control-label" htmlFor={htmlFor} id={id}>
      {children}
    </label>
  ) : (
    <span className="control-label" id={id}>
      {children}
    </span>
  );
}

/** A control's current value, in tabular figures, with words where a number says nothing. */
export function ValueReadout({
  children,
  unit,
  htmlFor,
}: {
  children: ReactNode;
  unit?: string;
  htmlFor?: string;
}) {
  return (
    <output className="value-readout" htmlFor={htmlFor}>
      {children}
      {unit ? <span className="value-unit"> {unit}</span> : null}
    </output>
  );
}

/**
 * A titled panel: the unit of layout.
 *
 * `views` names the phone views (perform, mix, edit) that show it. Below the phone
 * breakpoint a panel outside the current view is not rendered visibly at all, so it
 * leaves the tab order too. On wider screens every panel shows.
 */
export function InstrumentPanel({
  title,
  actions,
  children,
  className,
  views,
  hideTitle = false,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  views?: Array<'perform' | 'mix' | 'edit'>;
  hideTitle?: boolean;
}) {
  const id = useId();
  return (
    <section
      className={cx('panel', className)}
      aria-labelledby={id}
      data-views={views?.join(' ')}
    >
      <header className={cx('panel-head', hideTitle && 'sr-only')}>
        <h2 id={id} className="panel-title">
          {title}
        </h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * A raised pad. Three behaviors:
 *
 * - a plain press (`onPress`)
 * - latching (`latched` set): reads as on while latched
 * - momentary (`onHoldStart`/`onHoldEnd`): fires while held. Pointer capture keeps the
 *   hold when the finger slides off, and cancel and lost-capture release it too, so a
 *   held gesture always lets go.
 */
export function PerformancePad({
  label,
  hint,
  ariaLabel,
  latched,
  onPress,
  onHoldStart,
  onHoldEnd,
  keys,
  size = 'lg',
}: {
  label: string;
  hint?: string;
  ariaLabel?: string;
  latched?: boolean;
  onPress?: () => void;
  onHoldStart?: () => void;
  onHoldEnd?: () => void;
  keys?: string;
  size?: 'md' | 'lg';
}) {
  const held = useRef(false);
  const momentary = Boolean(onHoldStart);
  const release = () => {
    if (!held.current) return;
    held.current = false;
    onHoldEnd?.();
  };
  // The pointer and key paths above cover the pad itself. These cover the rest: the
  // window losing focus (alt-tab, a dialog), the tab being hidden, and the pad going
  // away while held. Without them a held gesture outlives the hand that held it.
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    if (!momentary) return;
    const onBlur = () => releaseRef.current();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') releaseRef.current();
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseRef.current();
    };
  }, [momentary]);
  return (
    <button
      type="button"
      className={cx('pad tap', size === 'md' && 'pad-md')}
      aria-label={ariaLabel}
      aria-pressed={latched}
      aria-keyshortcuts={keys}
      data-own-space={momentary ? '' : undefined}
      onClick={momentary ? undefined : onPress}
      onPointerDown={
        momentary
          ? (event: ReactPointerEvent<HTMLButtonElement>) => {
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                /* pointer already released */
              }
              held.current = true;
              onHoldStart?.();
            }
          : undefined
      }
      onPointerUp={momentary ? release : undefined}
      onPointerCancel={momentary ? release : undefined}
      onLostPointerCapture={momentary ? release : undefined}
      onKeyDown={
        momentary
          ? (event) => {
              if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                event.preventDefault();
                held.current = true;
                onHoldStart?.();
              }
            }
          : undefined
      }
      onKeyUp={
        momentary
          ? (event) => {
              if (event.key === ' ' || event.key === 'Enter') release();
            }
          : undefined
      }
      onBlur={momentary ? release : undefined}
    >
      <span className="pad-label">{label}</span>
      {hint ? <span className="pad-hint">{hint}</span> : null}
    </button>
  );
}

/** A dot and words for one state from the stem state vocabulary. */
export function StatusIndicator({
  state,
  label,
  compact = false,
}: {
  state: StemState | 'ok' | 'warn' | 'error' | 'idle';
  label: string;
  compact?: boolean;
}) {
  return (
    <span className={cx('status', compact && 'status-compact')} data-state={state}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">{label}</span>
    </span>
  );
}

/**
 * A labelled fader with a value readout and a reset badge.
 *
 * The reset badge sits outside the label, so clicking it never also focuses the fader.
 * It stays in the row when the fader is already home — disabled and dimmed — so the
 * row doesn't jump as you move off the default and back.
 */
export function Fader({
  label,
  value,
  display,
  unit,
  min,
  max,
  step,
  atDefault,
  onChange,
  onReset,
  valueText,
  ends,
}: {
  label: string;
  value: number;
  display: ReactNode;
  unit?: string;
  min: number;
  max: number;
  step: number;
  atDefault?: boolean;
  onChange: (value: number) => void;
  onReset?: () => void;
  valueText?: string;
  ends?: [string, string, string];
}) {
  const id = useId();
  return (
    <div className="fader-block">
      <div className="fader-head">
        <ControlLabel htmlFor={id}>{label}</ControlLabel>
        <span className="fader-head-right">
          <ValueReadout htmlFor={id} unit={unit}>
            {display}
          </ValueReadout>
          {onReset ? (
            <button
              type="button"
              className="badge badge-reset"
              disabled={atDefault}
              aria-label={`Reset ${label.toLowerCase()}`}
              onClick={onReset}
            >
              Reset
            </button>
          ) : null}
        </span>
      </div>
      <input
        id={id}
        className="fader"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={valueText}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {ends ? (
        <span className="fader-ends" aria-hidden="true">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
          <span>{ends[2]}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * A row of mutually exclusive pills. Picking the lit one again is passed through to
 * `onPick` so a caller can make it mean "off" (Loop and Echo time do).
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onPick,
  hideLabel = false,
  perKnobColumn,
}: {
  label: string;
  options: Array<{ value: T; label: string; aria?: string }>;
  value: T;
  onPick: (value: T) => void;
  hideLabel?: boolean;
  /**
   * Lay the pills on the knob rack's three columns, this many to a column, so a row of
   * pills above or below knobs lines up with them (Echo's Time over Feedback/Return).
   */
  perKnobColumn?: number;
}) {
  const id = useId();
  const pill = (o: { value: T; label: string; aria?: string }) => (
    <button
      key={String(o.value)}
      type="button"
      className="segment tap"
      aria-pressed={value === o.value}
      aria-label={o.aria}
      onClick={() => onPick(o.value)}
    >
      {o.label}
    </button>
  );
  const cells: Array<typeof options> = [];
  if (perKnobColumn) {
    for (let i = 0; i < options.length; i += perKnobColumn) cells.push(options.slice(i, i + perKnobColumn));
  }
  return (
    <div className="segmented-block">
      <span id={id} className={cx('control-label', hideLabel && 'sr-only')}>
        {label}
      </span>
      {perKnobColumn ? (
        <div className="segmented segmented-knob-columns" role="group" aria-labelledby={id}>
          {cells.map((cell, i) => (
            <div
              key={i}
              className="segmented-cell"
              style={{ gridTemplateColumns: `repeat(${perKnobColumn}, minmax(0, 1fr))` }}
            >
              {cell.map(pill)}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="segmented"
          role="group"
          aria-labelledby={id}
          style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
        >
          {options.map(pill)}
        </div>
      )}
    </div>
  );
}

/**
 * Gesture boundaries for a native range input, so a fader drag or a held arrow key is
 * recorded as one edit rather than one per value.
 */
export function useRangeGesture(historyId: string, value: number) {
  const from = useRef<number | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const start = () => {
    if (from.current === null) from.current = valueRef.current;
  };
  const end = () => {
    if (from.current === null) return;
    const f = from.current;
    from.current = null;
    // The value lands after the last change event, so read it after this frame.
    requestAnimationFrame(() => editHistory.record(historyId, f, valueRef.current));
  };
  return {
    onPointerDown: start,
    onPointerUp: end,
    onPointerCancel: end,
    onKeyDown: start,
    onKeyUp: end,
    onBlur: end,
  };
}

/** One stem's level meter, written from telemetry without a React render. */
export function StemMeter({ index }: { index: number }) {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      engine.subscribe((t) => {
        const el = bar.current;
        if (el) el.style.transform = `scaleX(${Math.max(0.035, t.levels[index] ?? 0)})`;
      }),
    [index],
  );
  return (
    <div className="meter" aria-hidden="true">
      <span ref={bar} />
    </div>
  );
}
