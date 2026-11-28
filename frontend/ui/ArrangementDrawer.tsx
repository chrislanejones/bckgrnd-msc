/**
 * The Arrangement drawer (Night 11B): a read-only timeline of a performance take.
 *
 * A bottom sheet, like the pattern drawer, opened from the Timeline toggle in the Take
 * events drawer and folded by default (`bckgrnd-msc:arrangement-open`). Fixed to the
 * window, so it adds no page height and never moves the scenes toolbar; its lanes
 * scroll sideways inside it.
 *
 * Time runs left to right on the take's onsets (steps since its first event, from the
 * engine's onset serial, so a song wrap never folds it back). Bar 1 starts on the bar
 * line of the first event's song bar, so the bar lines are the music's; bars are
 * labeled 1…N of the take, every one, two, four or eight bars as the zoom allows.
 *
 * Lanes for what a take captures: Scenes (points), Fills (spans, with Fill → scene as
 * a point and an arrow where the fill ends), Rise and Repeat (spans). Echo and Filter
 * are not captured, so they have no lanes. A span still open at the take's end runs to
 * it, with an open edge.
 *
 * Every event is a button named like "Fill, Busy beat, bar 5 beat 4" (the take's bar).
 * The timeline is one tab stop: Left and Right step through events in time, Home and
 * End go to the first and last; selection follows focus. The inspector under the lanes
 * shows `describeEvent`'s label, position (the song's) and detail, plus the take bar
 * and the length. It is a labeled region, not a live one: the button's name is what
 * is heard as focus moves.
 *
 * Zoom: − and + (and Ctrl or ⌘ with the wheel over the lanes, keeping the bar under the
 * pointer in place). No editing, no replay, no export: it only draws the take.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Minus, Plus, X } from 'lucide-react';
import { describeEvent, STEPS_PER_BAR, type PerformanceEvent, type PerformanceRecording } from '../lib/recording';
import type { TakeSource } from './EventsDrawer';

// ---- The source ---------------------------------------------------------------------
//
// `inst.recording.opened` (a take opened from a file, from the recorder's branch) wins
// over the current take. Optional here, so this builds without it.

export type ArrangementSource = TakeSource & { opened?: PerformanceRecording | null; openedFile?: string | null };

// ---- Layout -------------------------------------------------------------------------

export type Lane = 'scene' | 'fill' | 'rise' | 'repeat';
export const LANES: readonly { id: Lane; label: string }[] = [
  { id: 'scene', label: 'Scenes' },
  { id: 'fill', label: 'Fills' },
  { id: 'rise', label: 'Rise' },
  { id: 'repeat', label: 'Repeat' },
];

export type Placed = {
  e: PerformanceEvent;
  lane: Lane;
  /** Steps from bar 1's line. */
  start: number;
  /** Steps from bar 1's line; equal to `start` for a point. */
  end: number;
  span: boolean;
  /** Still running when the take ended: drawn to the take's end with an open edge. */
  open: boolean;
  /** A fill cut short, a Rise canceled or replaced. */
  flag: boolean;
  /** The take's bar and beat: "bar 5 beat 4". */
  takeBar: number;
};

export type Layout = { bars: number; placed: Placed[] };

const onsetOf = (e: PerformanceEvent) => (e as { onset?: number }).onset ?? 0;

/** Place a take's events on the timeline: lanes, spans in steps from bar 1's line, and the bar count. */
export function layoutTake(take: PerformanceRecording | null): Layout {
  const events = take?.events ?? [];
  if (events.length === 0) return { bars: 0, placed: [] };
  const first = events.reduce((a, b) => (onsetOf(b) < onsetOf(a) ? b : a));
  // Bar 1's line: the first event's onset, less how far into its song bar it fell.
  const lead = ((first.step % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR - onsetOf(first);
  const x = (onset: number) => onset + lead;
  let last = 0;
  for (const e of events) {
    const end = (e as { endOnset?: number }).endOnset;
    last = Math.max(last, x(onsetOf(e)) + 1, end !== undefined ? x(end) : 0);
  }
  const takeEnd = last;
  const placed = events.map((e): Placed => {
    const start = x(onsetOf(e));
    const takeBar = Math.floor(start / STEPS_PER_BAR) + 1;
    const endOnset = (e as { endOnset?: number }).endOnset;
    switch (e.kind) {
      case 'scene':
        return { e, lane: 'scene', start, end: start, span: false, open: false, flag: false, takeBar };
      case 'fillInto':
        return { e, lane: 'fill', start, end: start, span: false, open: false, flag: false, takeBar };
      case 'fill': {
        const open = endOnset === undefined;
        // A cut-short fill has no end onset: draw the bar it was asked to play, flagged.
        const end = open ? (e.outcome === 'cutShort' ? start + (e.length === 'beat' ? 4 : STEPS_PER_BAR) : takeEnd) : x(endOnset);
        return { e, lane: 'fill', start, end: Math.max(end, start + 1), span: true, open: open && e.outcome !== 'cutShort', flag: e.outcome === 'cutShort', takeBar };
      }
      case 'rise': {
        const open = endOnset === undefined;
        return { e, lane: 'rise', start, end: Math.max(open ? takeEnd : x(endOnset), start + 1), span: true, open,
          flag: e.outcome === 'cancelled' || e.outcome === 'replaced', takeBar };
      }
      case 'repeat': {
        const open = endOnset === undefined;
        return { e, lane: 'repeat', start, end: Math.max(open ? takeEnd : x(endOnset), start + 1), span: true, open, flag: false, takeBar };
      }
    }
  });
  placed.sort((a, b) => a.start - b.start || LANES.findIndex((l) => l.id === a.lane) - LANES.findIndex((l) => l.id === b.lane) || a.e.seq - b.e.seq);
  return { bars: Math.max(1, Math.ceil(takeEnd / STEPS_PER_BAR)), placed };
}

const KIND_WORD: Record<PerformanceEvent['kind'], string> = { scene: 'Scene', fill: 'Fill', fillInto: 'Fill into', rise: 'Rise', repeat: 'Repeat' };
/** `describeEvent`'s label less the kind's own word, which the kind already says. */
const whatOf = (e: PerformanceEvent) => describeEvent(e).label.replace(/^(Scene|Fill into|Rise to|Repeat) /, '');

/** "Fill, Busy beat, bar 5 beat 4": the button's name, in the take's bars. */
export function nameOf(p: Placed): string {
  const beat = Math.floor(((p.start % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR / 4) + 1;
  return `${KIND_WORD[p.e.kind]}, ${whatOf(p.e)}, bar ${p.takeBar} beat ${beat}`;
}

/** Take bar.beat(.sixteenth) of a position in steps from bar 1's line. */
function takePosition(steps: number): string {
  const inBar = ((steps % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  const bar = Math.floor(steps / STEPS_PER_BAR) + 1;
  const beat = Math.floor(inBar / 4) + 1;
  const six = (inBar % 4) + 1;
  return `Bar ${bar}.${beat}${six > 1 ? `.${six}` : ''}`;
}

const stepsWord = (n: number) => {
  const bars = n / STEPS_PER_BAR;
  const s = `${n} step${n === 1 ? '' : 's'}`;
  return Number.isInteger(bars) && bars > 0 ? `${s} · ${bars} bar${bars === 1 ? '' : 's'}` : s;
};

// ---- Zoom ---------------------------------------------------------------------------

/** Pixels per step: a bar is 8px (a long take's overview) to 256px. */
export const ZOOMS = [0.5, 1, 2, 3, 4, 6, 8, 12, 16] as const;
const DEFAULT_ZOOM = 5; // 6px a step, 96px a bar

/** Label every 1, 2, 4, 8 or 16 bars, so labels stay at least 32px apart. */
export function labelEvery(barPx: number): number {
  for (const k of [1, 2, 4, 8, 16]) if (barPx * k >= 32) return k;
  return 16;
}

// ---- The open state ------------------------------------------------------------------

export const ARRANGEMENT_OPEN_PREF = 'bckgrnd-msc:arrangement-open';

export function useArrangementOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(ARRANGEMENT_OPEN_PREF) === 'open';
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(ARRANGEMENT_OPEN_PREF, next ? 'open' : 'closed');
    } catch {
      /* storage unavailable: it lasts for this visit */
    }
  }, []);
  return [open, set];
}

// ---- The drawer ----------------------------------------------------------------------

export function ArrangementDrawer({
  id,
  open,
  source,
  onClose,
  returnFocus,
}: {
  id: string;
  open: boolean;
  source: ArrangementSource;
  onClose: () => void;
  /** Where focus goes back on Esc or Close: the toggle, or the Events toggle if it is folded away. */
  returnFocus: () => HTMLElement | null;
}) {
  const headingId = useId();
  const inspectorId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const { state, count, log, recording: read, opened } = source;

  const take = useMemo(() => {
    void log;
    void count;
    void state;
    if (!open) return null;
    if (opened !== undefined && opened !== null) return opened;
    return read ? read() : (window.__BCKGRND_RECORDING__?.recording() ?? null);
  }, [open, opened, read, log, count, state]);
  const isOpened = opened !== undefined && opened !== null;
  const layout = useMemo(() => layoutTake(take), [take]);

  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const pps = ZOOMS[zoom]!;
  const barPx = pps * STEPS_PER_BAR;
  const every = labelEvery(barPx);

  // Selection by seq (stable as a recording take grows); the first event until chosen.
  const [chosen, setChosen] = useState<number | null>(null);
  const selected = layout.placed.find((p) => p.e.seq === chosen) ?? null;
  const tabStop = selected ?? layout.placed[0] ?? null;

  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) headingRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const close = useCallback(() => {
    onClose();
    returnFocus()?.focus();
  }, [onClose, returnFocus]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };

  // Ctrl/⌘ + wheel over the lanes zooms, keeping the step under the pointer in place.
  const pending = useRef<{ step: number; px: number } | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !open) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom((z) => {
        const next = Math.min(ZOOMS.length - 1, Math.max(0, z + (event.deltaY < 0 ? 1 : -1)));
        if (next !== z) {
          const px = event.clientX - el.getBoundingClientRect().left;
          pending.current = { step: (el.scrollLeft + px - laneLabelPx(el)) / ZOOMS[z]!, px };
        }
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open]);
  useLayoutEffect(() => {
    const el = scroller.current;
    const p = pending.current;
    if (!el || !p) return;
    el.scrollLeft = Math.max(0, p.step * pps + laneLabelPx(el) - p.px);
    pending.current = null;
  }, [pps]);

  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const moveTo = (p: Placed | undefined) => {
    if (!p) return;
    setChosen(p.e.seq);
    const b = buttons.current.get(p.e.seq);
    b?.focus();
    b?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const onMarkerKey = (event: KeyboardEvent<HTMLButtonElement>, p: Placed) => {
    const list = layout.placed;
    const i = list.indexOf(p);
    const to = event.key === 'ArrowRight' ? list[i + 1] : event.key === 'ArrowLeft' ? list[i - 1]
      : event.key === 'Home' ? list[0] : event.key === 'End' ? list[list.length - 1] : undefined;
    if (!to) return;
    event.preventDefault();
    moveTo(to);
  };

  const empty = layout.placed.length === 0;
  const width = Math.max(layout.bars, 1) * barPx;
  const summary = empty
    ? take ? 'Empty take' : 'No take'
    : `${layout.placed.length} event${layout.placed.length === 1 ? '' : 's'} · ${layout.bars} bar${layout.bars === 1 ? '' : 's'}${!isOpened && state === 'recording' ? ' · recording' : ''}`;

  return (
    <section
      id={id}
      className="arrangement"
      aria-labelledby={headingId}
      hidden={!open}
      data-source={isOpened ? 'opened' : 'current'}
      onKeyDown={onKeyDown}
    >
      <header className="arrangement-head">
        <div className="arrangement-title">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="panel-title">
            Arrangement
          </h2>
          <span className="arrangement-source">{isOpened ? 'Opened' : 'Current take'}</span>
          {opened ? (
            <span className="arrangement-file" title={source.openedFile ?? opened.track}>
              {source.openedFile ?? opened.track}
            </span>
          ) : null}
          <span className="arrangement-summary">{summary}</span>
        </div>
        <div className="arrangement-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="arrangement-zoom-button tap"
            aria-label="Zoom out"
            title="Zoom out (Ctrl or ⌘ and the wheel)"
            aria-disabled={zoom === 0 || undefined}
            onClick={() => setZoom((z) => Math.max(0, z - 1))}
          >
            <Minus aria-hidden="true" size={12} strokeWidth={2.5} />
          </button>
          <span className="arrangement-zoom-value" aria-live="off">
            {barPx}
            <span className="value-unit">px/bar</span>
          </span>
          <button
            type="button"
            className="arrangement-zoom-button tap"
            aria-label="Zoom in"
            title="Zoom in (Ctrl or ⌘ and the wheel)"
            aria-disabled={zoom === ZOOMS.length - 1 || undefined}
            onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}
          >
            <Plus aria-hidden="true" size={12} strokeWidth={2.5} />
          </button>
        </div>
        <button type="button" className="arrangement-close tap" aria-label="Close the arrangement" title="Close (Esc)" onClick={close}>
          <X aria-hidden="true" size={14} strokeWidth={2.5} />
        </button>
      </header>

      {empty ? (
        <p className="arrangement-empty">
          {take ? 'Nothing in this take yet: scenes, fills, Rises and repeats show here as they apply.' : 'No take yet: press Rec, then perform.'}
        </p>
      ) : (
        <>
          <div className="arrangement-scroll" ref={scroller} data-beats={barPx >= 64 || undefined} style={{ ['--bar-px' as string]: `${barPx}px`, ['--step-px' as string]: `${pps}px` }}>
            <div className="arrangement-grid" style={{ width: `calc(var(--lane-label) + ${width}px)` }}>
              <div className="arrangement-ruler" aria-hidden="true">
                <span className="arrangement-corner">Bar</span>
                <div className="arrangement-ruler-track" style={{ width }}>
                  {Array.from({ length: layout.bars }, (_, i) => i).filter((i) => i % every === 0).map((i) => (
                    <span key={i} className="arrangement-bar-number" style={{ left: i * barPx }}>
                      {i + 1}
                    </span>
                  ))}
                </div>
              </div>
              {LANES.map((lane) => {
                const items = layout.placed.filter((p) => p.lane === lane.id);
                return (
                  <div key={lane.id} className="arrangement-lane" data-lane={lane.id}>
                    <span className="arrangement-lane-label" aria-hidden="true">{lane.label}</span>
                    <ul className="arrangement-track" aria-label={`${lane.label} lane`} style={{ width }}>
                      {items.map((p) => {
                        const left = p.start * pps;
                        const w = p.span ? (p.end - p.start) * pps : undefined;
                        const isSel = selected === p;
                        return (
                          <li key={p.e.seq} className="arrangement-item" style={{ left, width: w }}>
                            <button
                              ref={(b) => {
                                if (b) buttons.current.set(p.e.seq, b);
                                else buttons.current.delete(p.e.seq);
                              }}
                              type="button"
                              className="arrangement-marker"
                              data-kind={p.e.kind}
                              data-span={p.span || undefined}
                              data-open={p.open || undefined}
                              data-flag={p.flag || undefined}
                              aria-current={isSel || undefined}
                              aria-controls={inspectorId}
                              tabIndex={tabStop === p ? 0 : -1}
                              aria-label={nameOf(p)}
                              title={nameOf(p)}
                              onClick={() => setChosen(p.e.seq)}
                              onFocus={() => setChosen(p.e.seq)}
                              onKeyDown={(event) => onMarkerKey(event, p)}
                            >
                              {p.e.kind === 'fillInto' ? <span aria-hidden="true">→ </span> : null}
                              <span className="arrangement-marker-text" aria-hidden="true">{whatOf(p.e)}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
          <Inspector id={inspectorId} placed={selected} />
        </>
      )}
    </section>
  );
}

function laneLabelPx(scroller: HTMLElement): number {
  return parseFloat(getComputedStyle(scroller).getPropertyValue('--lane-label')) * parseFloat(getComputedStyle(document.documentElement).fontSize) || 72;
}

/** What the selected event was, where, and how it went: a labeled region, not a live one. */
function Inspector({ id, placed }: { id: string; placed: Placed | null }) {
  if (!placed) {
    return (
      <section id={id} className="arrangement-inspector" aria-label="Selected event">
        <p className="arrangement-inspector-hint">Select an event to inspect it. Left and Right step through them.</p>
      </section>
    );
  }
  const d = describeEvent(placed.e);
  const length = placed.span ? (placed.open ? `${stepsWord(placed.end - placed.start)} so far · open` : stepsWord(placed.end - placed.start)) : null;
  return (
    <section id={id} className="arrangement-inspector" aria-label="Selected event" data-flag={placed.flag || undefined}>
      <p className="arrangement-inspector-title">
        {/* The kind, unless describeEvent's label already starts with it ("Scene Sparse"). */}
        {d.label.startsWith(KIND_WORD[placed.e.kind]) ? null : <span className="arrangement-inspector-kind">{KIND_WORD[placed.e.kind]}</span>}
        <span className="arrangement-inspector-label">{d.label}</span>
      </p>
      <dl className="arrangement-facts">
        <div>
          <dt>Take</dt>
          <dd>{takePosition(placed.start)}</dd>
        </div>
        <div>
          <dt>Song</dt>
          <dd>{d.position}</dd>
        </div>
        {length ? (
          <div>
            <dt>Length</dt>
            <dd>{length}</dd>
          </div>
        ) : null}
        {d.detail ? (
          <div>
            <dt>How</dt>
            <dd>{d.detail}</dd>
          </div>
        ) : null}
        <div>
          <dt>Event</dt>
          <dd>#{placed.e.seq}</dd>
        </div>
      </dl>
    </section>
  );
}

/** The Timeline disclosure, for the Take events drawer's header. */
export function TimelineToggle({
  open,
  onToggle,
  controls,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="events-action timeline-toggle tap"
      aria-expanded={open}
      aria-controls={controls}
      title={open ? 'Hide the arrangement timeline' : 'Show the take as a timeline'}
      onClick={onToggle}
    >
      Timeline
    </button>
  );
}
