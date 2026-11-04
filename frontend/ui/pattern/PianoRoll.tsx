/**
 * One melodic lane for one bar: a small keyboard down the side, sixteenth columns
 * across, notes as blocks.
 *
 * - **Click** an empty place to add a note there, at the last length used.
 * - **Drag a note** to move it (columns snap to sixteenths, rows to semitones); drag
 *   its **right edge** to change its length. Released, the change is one edit. A
 *   position that would overlap another note shows the clash while dragging and is
 *   refused on release: phrases here are one note at a time, and nothing is ever
 *   shortened or deleted to make room.
 * - **A chord stays a chord.** Its pitches are drawn on their rows as one outlined
 *   group; they move, transpose and resize together.
 * - Notes that began in an earlier bar show where they come in from, and notes that
 *   run on show that they continue; the song's end is a hard stop.
 * - **Keyboard** on a focused note: Left/Right move a step (Shift: a beat), Up/Down a
 *   semitone (Shift: an octave), Alt+Left/Right shorten or lengthen, Delete removes.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { overlapping } from '../../lib/editing';
import { STEPS, isNoteEvent, laneSpec, type NoteEvent, type Pattern } from '../../lib/patterns';
import { cx } from '../controls';
import { isBlackKey, noteName, stepLabel, viewEnd, viewStart, type Viewport } from './shared';

const ROW = 14;

type Change = { step?: number; semitones?: number; len?: number };

type Drag = {
  pointerId: number;
  id: string;
  kind: 'move' | 'resize';
  x: number;
  y: number;
  col: number;
  row: number;
  moved: boolean;
  dSteps: number;
  dSemis: number;
};

/** Pairs of notes that overlap already (a phrase that came that way), drawn as conflicts. */
function conflicts(p: Pattern): Set<string> {
  const out = new Set<string>();
  const notes = p.events.filter(isNoteEvent);
  for (const a of notes) {
    const other = overlapping(p, a.step, a.len, a.id);
    if (other) {
      out.add(a.id);
      out.add(other.id);
    }
  }
  return out;
}

export function PianoRoll({
  pattern,
  view,
  playStep,
  selected,
  readOnly,
  disabled,
  lockedEvents,
  onSelect,
  onAdd,
  onChange,
  onDelete,
  onRefused,
}: {
  pattern: Pattern;
  view: Viewport;
  playStep: number;
  selected: string | null;
  readOnly: boolean;
  disabled: boolean;
  lockedEvents: ReadonlySet<string>;
  onSelect: (id: string | null) => void;
  onAdd: (step: number, pitch: number) => void;
  onChange: (id: string, change: Change) => void;
  onDelete: (id: string) => void;
  /** Say why a gesture changed nothing. */
  onRefused: (why: string) => void;
}) {
  const spec = laneSpec(pattern.lane);
  const [lo, hi] = spec.range ?? [36, 96];
  const pitches: number[] = [];
  for (let n = hi; n >= lo; n -= 1) pitches.push(n);
  const start = viewStart(view);
  const end = viewEnd(view);
  const cols = view.cols.length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const clash = conflicts(pattern);
  const editable = !readOnly && !disabled;

  const visible = pattern.events.filter(
    (e): e is NoteEvent => isNoteEvent(e) && e.step < end && e.step + e.len > start,
  );

  // Bring the bar's notes into view when the bar or lane changes.
  const firstPitch = visible[0]?.notes[0];
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = firstPitch ?? Math.round((lo + hi) / 2);
    el.scrollTop = Math.max(0, (hi - target) * ROW - el.clientHeight / 2);
    // Only on a new bar or lane, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.bar, pattern.lane]);

  function cellAt(clientX: number, clientY: number): { col: number; pitch: number } | null {
    const r = bodyRef.current?.getBoundingClientRect();
    if (!r) return null;
    const col = Math.floor(((clientX - r.left) / r.width) * cols);
    const row = Math.floor((clientY - r.top) / ROW);
    if (col < 0 || col >= cols || row < 0 || row >= pitches.length) return null;
    return { col, pitch: pitches[row]! };
  }

  /** What a note would become under the current drag. */
  function proposed(e: NoteEvent, d: Drag): { step: number; len: number; notes: number[] } {
    if (d.kind === 'resize') return { step: e.step, len: Math.max(1, Math.min(STEPS - e.step, e.len + d.dSteps)), notes: e.notes };
    return {
      step: Math.max(0, Math.min(STEPS - 1, e.step + d.dSteps)),
      len: e.len,
      notes: e.notes.map((n) => n + d.dSemis),
    };
  }

  function beginNote(ev: PointerEvent<HTMLElement>, e: NoteEvent) {
    ev.stopPropagation();
    if (ev.button !== 0) return;
    onSelect(e.id);
    if (!editable) return;
    ev.preventDefault();
    bodyRef.current?.setPointerCapture(ev.pointerId);
    const rect = ev.currentTarget.getBoundingClientRect();
    const runsOn = e.step + e.len > end;
    const kind = !runsOn && ev.clientX > rect.right - 8 ? 'resize' : 'move';
    setDrag({ pointerId: ev.pointerId, id: e.id, kind, x: ev.clientX, y: ev.clientY, col: 0, row: 0, moved: false, dSteps: 0, dSemis: 0 });
  }

  function beginEmpty(ev: PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0) return;
    if (!editable) {
      onSelect(null);
      return;
    }
    const at = cellAt(ev.clientX, ev.clientY);
    if (!at) return;
    onAdd(start + at.col, at.pitch);
  }

  function move(ev: PointerEvent) {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.pointerId) return;
    const r = bodyRef.current?.getBoundingClientRect();
    if (!r) return;
    const colW = r.width / cols;
    const dSteps = Math.round((ev.clientX - d.x) / colW);
    const dSemis = d.kind === 'move' ? -Math.round((ev.clientY - d.y) / ROW) : 0;
    if (!d.moved && Math.abs(ev.clientX - d.x) < 4 && Math.abs(ev.clientY - d.y) < 4) return;
    if (d.moved && dSteps === d.dSteps && dSemis === d.dSemis) return;
    setDrag({ ...d, moved: true, dSteps, dSemis });
  }

  function end_(ev: PointerEvent, commit: boolean) {
    const d = dragRef.current;
    if (!d || ev.pointerId !== d.pointerId) return;
    setDrag(null);
    if (!commit || !d.moved || (d.dSteps === 0 && d.dSemis === 0)) return;
    const e = pattern.events.find((x) => x.id === d.id);
    if (!e || !isNoteEvent(e)) return;
    const next = proposed(e, d);
    const other = overlapping(pattern, next.step, next.len, e.id);
    if (other) {
      onRefused(`Not moved: it would overlap ${other.notes.map(noteName).join(' ')} at ${stepLabel(other.step)}`);
      return;
    }
    if (next.notes.some((n) => n < 0 || n > 127)) {
      onRefused('Not moved: out of range');
      return;
    }
    if (d.kind === 'resize') onChange(e.id, { len: next.len });
    else onChange(e.id, { step: next.step, semitones: d.dSemis });
  }

  function onKey(ev: KeyboardEvent, e: NoteEvent) {
    if (!editable) return;
    const big = ev.shiftKey;
    let change: Change | null = null;
    if (ev.altKey && ev.key === 'ArrowRight') change = { len: e.len + 1 };
    else if (ev.altKey && ev.key === 'ArrowLeft') change = { len: Math.max(1, e.len - 1) };
    else if (ev.key === 'ArrowRight') change = { step: e.step + (big ? 4 : 1) };
    else if (ev.key === 'ArrowLeft') change = { step: e.step - (big ? 4 : 1) };
    else if (ev.key === 'ArrowUp') change = { semitones: big ? 12 : 1 };
    else if (ev.key === 'ArrowDown') change = { semitones: big ? -12 : -1 };
    else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      onDelete(e.id);
      return;
    }
    if (!change) return;
    ev.preventDefault();
    const step = change.step ?? e.step;
    const len = Math.min(change.len ?? e.len, STEPS - Math.max(0, step));
    if (step < 0 || step >= STEPS) {
      onRefused('Not moved: that is past the edge of the song');
      return;
    }
    const other = overlapping(pattern, step, len, e.id);
    if (other) {
      onRefused(`Not moved: it would overlap ${other.notes.map(noteName).join(' ')} at ${stepLabel(other.step)}`);
      return;
    }
    onChange(e.id, change);
  }

  const playCol = playStep >= start && playStep < end ? playStep - start : -1;

  return (
    <div className={cx('piano-roll', readOnly && 'is-read-only', disabled && 'is-disabled')}>
      <div className="roll-scroll" ref={scrollRef}>
        <div className="roll-inner" style={{ height: pitches.length * ROW }}>
          <div className="roll-keys" aria-hidden>
            {pitches.map((n) => (
              <span key={n} className={cx('roll-key', isBlackKey(n) && 'is-black', n % 12 === 0 && 'is-c')}>
                {n % 12 === 0 ? noteName(n) : ''}
              </span>
            ))}
          </div>
          <div
            ref={bodyRef}
            className="roll-body"
            role="group"
            aria-label={`${spec.label} notes, ${stepLabel(start)} to ${stepLabel(end - 1)}`}
            style={{ '--cols': cols } as React.CSSProperties}
            onPointerDown={beginEmpty}
            onPointerMove={move}
            onPointerUp={(e) => end_(e, true)}
            onPointerCancel={(e) => end_(e, false)}
            onLostPointerCapture={(e) => end_(e, true)}
          >
            {pitches.map((n, i) =>
              isBlackKey(n) ? <span key={n} className="roll-row is-black" style={{ top: i * ROW }} aria-hidden /> : null,
            )}
            {view.cols.map((c, i) =>
              c % 4 === 0 && i > 0 ? (
                <span key={c} className="roll-beat" style={{ left: `${(i / cols) * 100}%` }} aria-hidden />
              ) : null,
            )}
            {playCol >= 0 ? (
              <span className="roll-playhead" style={{ left: `${(playCol / cols) * 100}%` }} aria-hidden />
            ) : null}
            {visible.map((e) => {
              const d = drag?.id === e.id && drag.moved ? drag : null;
              const shape = d ? proposed(e, d) : { step: e.step, len: e.len, notes: e.notes };
              const bad = d ? overlapping(pattern, shape.step, shape.len, e.id) !== null : clash.has(e.id);
              const a = Math.max(shape.step, start);
              const b = Math.min(shape.step + shape.len, end);
              if (b <= a) return null;
              const left = ((a - start) / cols) * 100;
              const width = ((b - a) / cols) * 100;
              const name = `${e.notes.map(noteName).join(' ')}, ${stepLabel(e.step)}, ${e.len} step${e.len === 1 ? '' : 's'}, velocity ${Math.round(e.vel * 100)}%${e.accent ? ', accent' : ''}${e.step < start ? ', continues from an earlier bar' : ''}${clash.has(e.id) ? ', overlaps another note' : ''}`;
              const topRow = Math.min(...shape.notes.map((n) => hi - n));
              const bottomRow = Math.max(...shape.notes.map((n) => hi - n));
              return (
                <button
                  key={e.id}
                  type="button"
                  data-note={e.id}
                  className={cx(
                    'roll-note',
                    selected === e.id && 'is-selected',
                    shape.step < start && 'from-before',
                    shape.step + shape.len > end && 'runs-on',
                    bad && 'is-conflict',
                    e.notes.length > 1 && 'is-chord',
                    lockedEvents.has(`${pattern.lane}:${e.id}`) && 'is-locked',
                    d && 'is-dragging',
                  )}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    top: topRow * ROW,
                    height: (bottomRow - topRow + 1) * ROW,
                    '--vel': e.vel,
                  } as React.CSSProperties}
                  aria-label={name}
                  aria-pressed={selected === e.id}
                  onPointerDown={(ev) => beginNote(ev, e)}
                  onKeyDown={(ev) => onKey(ev, e)}
                  onFocus={() => onSelect(e.id)}
                >
                  {shape.notes.map((n) => (
                    <span key={n} className="roll-pitch" style={{ top: (hi - n - topRow) * ROW }} aria-hidden />
                  ))}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
