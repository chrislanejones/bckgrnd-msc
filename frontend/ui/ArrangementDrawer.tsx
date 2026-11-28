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
 * pointer in place).
 *
 * Night 12, the editor: "Arrange this take" makes a working arrangement
 * (`inst.arrangement`, lib/arrangement), a separate document, so the take is never
 * edited; Take | Edit switches between them. A compact toolbar (no menus): insert a
 * Scene or a Fill (at bar 1, or one snap after the selection), Duplicate, Delete, Undo,
 * Redo, Snap (Bar, Beat, 1/16), Save and Open. Select is implicit. Drag a marker and a
 * ghost follows on the snap grid; a refused drop glides back and the status line says
 * why. Keys on a marker: ← → nudge by the snap, Shift a bar, Alt ← → and Home/End move
 * between events, Delete removes, Ctrl/⌘ D duplicates; Ctrl/⌘ Z undoes, Ctrl/⌘ Shift Z
 * and Ctrl Y redo, anywhere in the drawer; Esc deselects, then closes. "?" lists them.
 * The inspector edits the selection with the app's own controls (refusals inline);
 * on touch it has ◀ ▶ nudges. An opened file's conflicts are listed, the events in them
 * marked in the warning color; a conflict selects its first event. The top edge is a
 * resize handle (a separator: drag, or the arrows), remembered as
 * `bckgrnd-msc:arrangement-height`.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { ChevronLeft, ChevronRight, CopyPlus, Download, FolderOpen, Minus, Plus, Redo2, Trash2, Undo2, X } from 'lucide-react';
import { describeEvent, STEPS_PER_BAR, type PerformanceEvent, type PerformanceRecording } from '../lib/recording';
import { SCENE_SLOTS } from '../lib/contract';
import { FILL_LENGTHS, FILL_LENGTH_LABEL, FILL_STYLES, FILL_STYLE_LABEL } from '../lib/fills';
import { Segmented } from './controls';
import type { TakeSource } from './EventsDrawer';
import { SNAP_STEPS, sourceName, spanOf, type Arrangement, type ArrangementApi, type ArrangementEvent, type EditResult, type Snap } from './arrangementApi';

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

// ---- Marks: one shape for a take's events and a working arrangement's ----------------

type Mark = {
  key: string;
  kind: string;
  lane: Lane;
  start: number;
  end: number;
  span: boolean;
  open: boolean;
  flag: boolean;
  conflict: boolean;
  text: string;
  name: string;
  /** The working arrangement's event, when this is one (editable). */
  w?: ArrangementEvent;
  /** The take's event, when this is one (read only). */
  t?: Placed;
};

const takeKey = (p: Placed) => `take:${p.e.seq}`;

function marksOfTake(layout: Layout): Mark[] {
  return layout.placed.map((p) => ({
    key: takeKey(p),
    kind: p.e.kind,
    lane: p.lane,
    start: p.start,
    end: p.end,
    span: p.span,
    open: p.open,
    flag: p.flag,
    conflict: false,
    text: whatOf(p.e),
    name: nameOf(p),
    t: p,
  }));
}

const W_KIND: Record<ArrangementEvent['kind'], string> = { scene: 'Scene', fill: 'Fill', rise: 'Rise', repeat: 'Repeat' };

function fillWord(style: string | null, length: 'bar' | 'beat'): string {
  const word = style ? style.charAt(0).toUpperCase() + style.slice(1) : null;
  return length === 'beat' ? (word ? `${word} beat` : 'Beat fill') : (word ?? 'Fill');
}

/** What a working event is, in a few words: "Sparse", "Busy beat → Drop", "Drop · 4 bars", "1/8". */
function textOf(e: ArrangementEvent, sceneName: (slot: string) => string): string {
  switch (e.kind) {
    case 'scene':
      return sceneName(e.slot);
    case 'fill':
      return `${fillWord(e.style, e.length)}${e.into ? ` → ${sceneName(e.into)}` : ''}`;
    case 'rise':
      return `${sceneName(e.slot)} · ${e.bars} bars`;
    case 'repeat':
      return `1/${e.division}`;
  }
}

function beatName(start: number): string {
  const inBar = ((start % STEPS_PER_BAR) + STEPS_PER_BAR) % STEPS_PER_BAR;
  return `bar ${Math.floor(start / STEPS_PER_BAR) + 1} beat ${Math.floor(inBar / 4) + 1}`;
}

function marksOfWorking(a: Arrangement, conflicted: ReadonlySet<string>, sceneName: (slot: string) => string): Mark[] {
  const marks = a.events.map((e): Mark => {
    const len = spanOf(e);
    const text = textOf(e, sceneName);
    return {
      key: e.id,
      kind: e.kind,
      lane: e.kind,
      start: e.at,
      end: e.at + len,
      span: len > 0,
      open: false,
      flag: false,
      conflict: conflicted.has(e.id),
      text,
      name: `${W_KIND[e.kind]}, ${text}, ${beatName(e.at)}`,
      w: e,
    };
  });
  return marks.sort((x, y) => x.start - y.start || LANES.findIndex((l) => l.id === x.lane) - LANES.findIndex((l) => l.id === y.lane));
}

// ---- The height ------------------------------------------------------------------------

export const ARRANGEMENT_HEIGHT_PREF = 'bckgrnd-msc:arrangement-height';
const MIN_H = 180;
const DEFAULT_H = 300;
/** The tallest it may be: the window under the transport, less a margin for the page. */
const maxHeight = () =>
  Math.max(
    MIN_H,
    Math.round(
      window.innerHeight -
        (document.querySelector('.transport')?.getBoundingClientRect().height ?? 56) -
        (document.querySelector('.phone-dock')?.getBoundingClientRect().height ?? 0) -
        24,
    ),
  );

function readHeight(): number {
  try {
    const n = Number(window.localStorage.getItem(ARRANGEMENT_HEIGHT_PREF));
    return Number.isFinite(n) && n >= MIN_H ? n : DEFAULT_H;
  } catch {
    return DEFAULT_H;
  }
}

// ---- The drawer ----------------------------------------------------------------------

type Status = { text: string; tone: 'refused' | 'note' | 'done' } | null;

const SNAP_OPTIONS: { value: Snap; label: string; aria: string }[] = [
  { value: 'bar', label: 'Bar', aria: 'Snap to the bar' },
  { value: 'beat', label: 'Beat', aria: 'Snap to the beat' },
  { value: 'sixteenth', label: '1/16', aria: 'Snap to the sixteenth' },
];

const isMod = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

export function ArrangementDrawer({
  id,
  open,
  source,
  editor,
  sceneName,
  onClose,
  returnFocus,
}: {
  id: string;
  open: boolean;
  source: ArrangementSource;
  /** `inst.arrangement` (Night 12): the working arrangement and its edits. Absent: view only. */
  editor?: ArrangementApi;
  /** A scene slot's name as the pads show it. */
  sceneName: (slot: string) => string;
  onClose: () => void;
  /** Where focus goes back on Esc or Close: the toggle, or the Events toggle if it is folded away. */
  returnFocus: () => HTMLElement | null;
}) {
  const headingId = useId();
  const inspectorId = useId();
  const statusId = useId();
  const helpId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
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

  // Which document shows: the take (read only) or the working arrangement.
  const working = editor?.working ?? null;
  const [view, setView] = useState<'take' | 'working'>('working');
  const editing = working !== null && view === 'working';
  const lastWorking = useRef(working);
  useEffect(() => {
    // A new working arrangement (Arrange this take, Open) shows itself.
    if (working && !lastWorking.current) setView('working');
    lastWorking.current = working;
  }, [working]);

  const conflicts = useMemo(() => (editing ? (editor?.conflicts ?? []) : []), [editing, editor?.conflicts]);
  const conflicted = useMemo(() => new Set(conflicts.flatMap((c) => c.ids)), [conflicts]);
  const marks = useMemo(
    () => (editing && working ? marksOfWorking(working, conflicted, sceneName) : marksOfTake(layout)),
    [editing, working, conflicted, sceneName, layout],
  );
  const bars = editing && working ? Math.max(1, working.lengthBars, Math.ceil(Math.max(0, ...marks.map((m) => m.end)) / STEPS_PER_BAR)) : layout.bars;

  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const pps = ZOOMS[zoom]!;
  const barPx = pps * STEPS_PER_BAR;
  const every = labelEvery(barPx);
  const snap: Snap = editor?.snap ?? 'beat';
  const snapSteps = SNAP_STEPS[snap];

  const [chosen, setChosen] = useState<string | null>(null);
  const selected = marks.find((m) => m.key === chosen) ?? null;
  const tabStop = selected ?? marks[0] ?? null;

  // The status line: a refusal's reason, the conversion's notes (once), what was done.
  const [status, setStatus] = useState<Status>(null);
  const notesShown = useRef<readonly string[] | null>(null);
  const notes = editor?.notes;
  useEffect(() => {
    if (!notes || notes.length === 0 || notesShown.current === notes) return;
    notesShown.current = notes;
    setStatus({ text: notes.join(' · '), tone: 'note' });
  }, [notes]);
  const [inlineRefusal, setInlineRefusal] = useState<string | null>(null);

  const [helpOpen, setHelpOpen] = useState(false);

  // ---- Height (resizable, remembered) ----
  const [height, setHeight] = useState(readHeight);
  const [limit, setLimit] = useState(() => maxHeight());
  useEffect(() => {
    const on = () => setLimit(maxHeight());
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [open]);
  const shown = Math.min(Math.max(height, MIN_H), limit);
  const commitHeight = useCallback((h: number) => {
    const v = Math.round(Math.min(Math.max(h, MIN_H), maxHeight()));
    setHeight(v);
    try {
      window.localStorage.setItem(ARRANGEMENT_HEIGHT_PREF, String(v));
    } catch {
      /* storage unavailable: it lasts for this visit */
    }
  }, []);
  const resizing = useRef<{ y: number; h: number } | null>(null);

  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) headingRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const close = useCallback(() => {
    onClose();
    returnFocus()?.focus();
  }, [onClose, returnFocus]);

  // ---- Zoom: Ctrl/⌘ + wheel over the lanes, keeping the step under the pointer. ----
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
  }, [open, marks.length]);
  useLayoutEffect(() => {
    const el = scroller.current;
    const p = pending.current;
    if (!el || !p) return;
    el.scrollLeft = Math.max(0, p.step * pps + laneLabelPx(el) - p.px);
    pending.current = null;
  }, [pps]);

  // ---- Selection and focus ----
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusKey = useRef<string | null>(null);
  const select = (key: string | null, focus = false) => {
    setChosen(key);
    if (focus && key) focusKey.current = key;
  };
  // Focus follows an edit's result after the marks re-render (a duplicate's new id, a nudge).
  useLayoutEffect(() => {
    const k = focusKey.current;
    if (!k) return;
    const b = buttons.current.get(k);
    if (b) {
      focusKey.current = null;
      if (document.activeElement !== b) b.focus();
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });

  /** Apply an edit: a refusal's reason to the status line (and inline when asked); else select its result. */
  const act = (r: EditResult | boolean | void, opts: { select?: string | null; inline?: boolean; done?: string } = {}) => {
    if (r && typeof r === 'object' && r.ok === false) {
      setStatus({ text: r.reason, tone: 'refused' });
      if (opts.inline) setInlineRefusal(r.reason);
      return false;
    }
    setInlineRefusal(null);
    setStatus(opts.done ? { text: opts.done, tone: 'done' } : null);
    const next = r && typeof r === 'object' && r.ok && r.id ? r.id : opts.select;
    if (next !== undefined) select(next, true);
    return true;
  };

  const sel = selected?.w ?? null;
  const insertAt = sel ? sel.at + snapSteps : 0;
  const neighbor = (key: string) => {
    const i = marks.findIndex((m) => m.key === key);
    return (marks[i + 1] ?? marks[i - 1])?.key ?? null;
  };
  const doRemove = (key: string) => {
    const next = neighbor(key);
    act(editor!.remove(key), { select: next, done: 'Deleted' });
  };

  // ---- Keys: on a marker, and anywhere in the drawer while editing. ----
  const onMarkerKey = (event: KeyboardEvent<HTMLButtonElement>, m: Mark) => {
    const i = marks.indexOf(m);
    const go = (to: Mark | undefined) => {
      if (!to) return;
      event.preventDefault();
      select(to.key, true);
    };
    if (editing && m.w && editor) {
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.altKey && !isMod(event)) {
        event.preventDefault();
        act(editor.nudge(m.key, event.key === 'ArrowLeft' ? -1 : 1, event.shiftKey ? 'bar' : undefined), { select: m.key });
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        doRemove(m.key);
        return;
      }
      if (isMod(event) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        act(editor.duplicate(m.key), { done: 'Duplicated' });
        return;
      }
      // Moving between events: Alt with the arrows, Home and End.
      if (event.altKey && event.key === 'ArrowRight') return go(marks[i + 1]);
      if (event.altKey && event.key === 'ArrowLeft') return go(marks[i - 1]);
    } else {
      if (event.key === 'ArrowRight') return go(marks[i + 1]);
      if (event.key === 'ArrowLeft') return go(marks[i - 1]);
    }
    if (event.key === 'Home') return go(marks[0]);
    if (event.key === 'End') return go(marks[marks.length - 1]);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (helpOpen) return setHelpOpen(false);
      if (chosen !== null) {
        setChosen(null);
        return;
      }
      close();
      return;
    }
    if (!editing || !editor) return;
    const target = event.target as HTMLElement;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
    const key = event.key.toLowerCase();
    if (isMod(event) && key === 'z') {
      event.preventDefault();
      act(event.shiftKey ? editor.redo() : editor.undo());
    } else if (event.ctrlKey && !event.metaKey && key === 'y') {
      event.preventDefault();
      act(editor.redo());
    }
  };

  // ---- Drag: a ghost on the snap grid; a refused drop springs back with the reason. ----
  const drag = useRef<{ key: string; x0: number; at0: number; at: number; moved: boolean; pointer: number } | null>(null);
  const [ghost, setGhost] = useState<{ key: string; at: number; back: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, m: Mark) => {
    if (!editing || !m.w || event.button !== 0) return;
    drag.current = { key: m.key, x0: event.clientX, at0: m.start, at: m.start, moved: false, pointer: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const dx = event.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 4) return;
    d.moved = true;
    const at = Math.max(0, Math.round((d.at0 + dx / pps) / snapSteps) * snapSteps);
    if (at !== d.at || !ghost) {
      d.at = at;
      setGhost({ key: d.key, at, back: false });
    }
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>, cancel = false) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null;
    if (!d.moved) return; // a click: it selects (onClick)
    suppressClick.current = true;
    select(d.key, true);
    if (cancel || d.at === d.at0) {
      setGhost(null);
      return;
    }
    const r = editor!.move(d.key, d.at);
    if (r.ok) {
      setGhost(null);
      act(r, { select: d.key });
      return;
    }
    act(r);
    // Spring back: the ghost glides home from where it was dropped, then goes.
    setGhost({ key: d.key, at: d.at, back: false });
    requestAnimationFrame(() => requestAnimationFrame(() => setGhost({ key: d.key, at: d.at0, back: true })));
    window.setTimeout(() => setGhost((g) => (g && g.back && g.key === d.key ? null : g)), 260);
  };
  const suppressClick = useRef(false);

  // ---- Files ----
  const onOpenFile = async (file: File | undefined) => {
    if (!file || !editor) return;
    const text = await file.text();
    const r = await editor.open(text, file.name);
    if (act(r, { select: null, done: `Opened ${file.name}` })) setView('working');
  };

  // ---- Header words ----
  const empty = marks.length === 0;
  const width = Math.max(bars, 1) * barPx;
  const summary = editing
    ? `${marks.length} event${marks.length === 1 ? '' : 's'} · ${bars} bar${bars === 1 ? '' : 's'}`
    : empty
      ? take ? 'Empty take' : 'No take'
      : `${marks.length} event${marks.length === 1 ? '' : 's'} · ${bars} bar${bars === 1 ? '' : 's'}${!isOpened && state === 'recording' ? ' · recording' : ''}`;
  const noTakeReason = take && layout.placed.length ? null : 'No take to arrange yet: press Rec, then perform';

  return (
    <section
      id={id}
      className="arrangement"
      aria-labelledby={headingId}
      hidden={!open}
      data-source={editing ? 'working' : isOpened ? 'opened' : 'current'}
      data-editor={editing || undefined}
      data-dragging={ghost && !ghost.back ? true : undefined}
      style={{ height: shown }}
      onKeyDown={onKeyDown}
    >
      <div
        className="arrangement-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the arrangement"
        aria-valuemin={MIN_H}
        aria-valuemax={limit}
        aria-valuenow={shown}
        aria-valuetext={`${shown} pixels tall`}
        tabIndex={0}
        onKeyDown={(event) => {
          const by = event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : event.key === 'PageUp' ? 64 : event.key === 'PageDown' ? -64 : 0;
          if (by) {
            event.preventDefault();
            commitHeight(shown + by);
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            commitHeight(event.key === 'Home' ? MIN_H : limit);
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          resizing.current = { y: event.clientY, h: shown };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const r = resizing.current;
          if (r) setHeight(Math.min(Math.max(r.h + (r.y - event.clientY), MIN_H), limit));
        }}
        onPointerUp={(event) => {
          const r = resizing.current;
          resizing.current = null;
          if (r) commitHeight(r.h + (r.y - event.clientY));
        }}
        onPointerCancel={() => {
          resizing.current = null;
        }}
      >
        <span className="arrangement-grip" aria-hidden="true" />
      </div>

      <header className="arrangement-head">
        <div className="arrangement-title">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="panel-title">
            Arrangement
          </h2>
          {editing && working ? (
            <>
              <span className="arrangement-source" title={`Arrangement from ${sourceName(working)}`}>
                from {sourceName(working)}
              </span>
              {editor?.dirty ? (
                <span className="arrangement-dirty" title="Unsaved changes">
                  <span aria-hidden="true">●</span>
                  <span className="sr-only">Unsaved changes</span>
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className="arrangement-source">{isOpened ? 'Opened' : 'Current take'}</span>
              {opened ? (
                <span className="arrangement-file" title={source.openedFile ?? opened.track}>
                  {source.openedFile ?? opened.track}
                </span>
              ) : null}
            </>
          )}
          <span className="arrangement-summary">{summary}</span>
        </div>
        {working ? (
          <div className="segmented arrangement-view" role="radiogroup" aria-label="Show">
            {(['take', 'working'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                className="segment tap"
                aria-checked={view === v}
                tabIndex={view === v ? 0 : -1}
                onClick={() => {
                  setView(v);
                  setChosen(null);
                }}
                onKeyDown={(event) => {
                  if (!/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
                  event.preventDefault();
                  const next = view === 'take' ? 'working' : 'take';
                  setView(next);
                  setChosen(null);
                  (event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`))?.focus();
                }}
                data-view={v}
              >
                {v === 'take' ? 'Take' : 'Edit'}
              </button>
            ))}
          </div>
        ) : editor ? (
          <button
            type="button"
            className="arrangement-action is-primary tap"
            aria-disabled={noTakeReason ? true : undefined}
            title={noTakeReason ?? 'Make an editable arrangement from this take (the take stays as it is)'}
            onClick={() => {
              if (noTakeReason) return setStatus({ text: noTakeReason, tone: 'refused' });
              act(editor.fromTake(), { select: null });
              setView('working');
            }}
          >
            Arrange this take
          </button>
        ) : null}
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

      {editor ? (
        <div className="arrangement-toolbar" role="toolbar" aria-label="Arrangement tools" aria-orientation="horizontal">
          {editing ? (
            <>
              <button type="button" className="arrangement-action tap" title={`Insert a scene at ${takePosition(insertAt)}`}
                onClick={() => act(editor.insert('scene', insertAt), { done: 'Scene inserted' })}>
                <Plus aria-hidden="true" size={12} strokeWidth={2.5} /> Scene
              </button>
              <button type="button" className="arrangement-action tap" title={`Insert a fill at ${takePosition(insertAt)}`}
                onClick={() => act(editor.insert('fill', insertAt), { done: 'Fill inserted' })}>
                <Plus aria-hidden="true" size={12} strokeWidth={2.5} /> Fill
              </button>
              <span className="arrangement-sep" aria-hidden="true" />
              <button type="button" className="arrangement-icon tap" aria-label="Duplicate" title="Duplicate (Ctrl or ⌘ D)"
                aria-disabled={!sel || undefined}
                onClick={() => (sel ? act(editor.duplicate(sel.id), { done: 'Duplicated' }) : setStatus({ text: 'Select an event to duplicate', tone: 'refused' }))}>
                <CopyPlus aria-hidden="true" size={14} strokeWidth={2.25} />
              </button>
              <button type="button" className="arrangement-icon tap" aria-label="Delete" title="Delete (Delete or Backspace)"
                aria-disabled={!sel || undefined}
                onClick={() => (sel ? doRemove(sel.id) : setStatus({ text: 'Select an event to delete', tone: 'refused' }))}>
                <Trash2 aria-hidden="true" size={14} strokeWidth={2.25} />
              </button>
              <span className="arrangement-sep" aria-hidden="true" />
              <button type="button" className="arrangement-icon tap" aria-label="Undo" title="Undo (Ctrl or ⌘ Z)"
                aria-disabled={!editor.canUndo || undefined} onClick={() => editor.canUndo && act(editor.undo())}>
                <Undo2 aria-hidden="true" size={14} strokeWidth={2.25} />
              </button>
              <button type="button" className="arrangement-icon tap" aria-label="Redo" title="Redo (Ctrl or ⌘ Shift Z, Ctrl Y)"
                aria-disabled={!editor.canRedo || undefined} onClick={() => editor.canRedo && act(editor.redo())}>
                <Redo2 aria-hidden="true" size={14} strokeWidth={2.25} />
              </button>
              <span className="arrangement-sep" aria-hidden="true" />
              <div className="segmented arrangement-snap" role="radiogroup" aria-label="Snap">
                <span className="arrangement-snap-label" aria-hidden="true">Snap</span>
                {SNAP_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    className="segment tap"
                    aria-checked={snap === o.value}
                    aria-label={o.aria}
                    tabIndex={snap === o.value ? 0 : -1}
                    onClick={() => editor.setSnap(o.value)}
                    onKeyDown={(event) => {
                      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                      if (!step) return;
                      event.preventDefault();
                      const i = (SNAP_OPTIONS.findIndex((x) => x.value === snap) + step + SNAP_OPTIONS.length) % SNAP_OPTIONS.length;
                      editor.setSnap(SNAP_OPTIONS[i]!.value);
                      (event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[i])?.focus();
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <span className="arrangement-sep" aria-hidden="true" />
              <button type="button" className="arrangement-action tap" title="Save the arrangement as a file"
                onClick={() => act(editor.save(), { done: 'Saved' })}>
                <Download aria-hidden="true" size={12} strokeWidth={2.5} /> Save
              </button>
            </>
          ) : null}
          <button type="button" className="arrangement-action tap" title="Open an arrangement file, or a take (v2)" onClick={() => fileInput.current?.click()}>
            <FolderOpen aria-hidden="true" size={12} strokeWidth={2.5} /> Open
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-label="Open an arrangement file"
            onChange={(event) => {
              void onOpenFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
          {editing ? (
            <button
              type="button"
              className="arrangement-icon arrangement-help-toggle tap"
              aria-label="Keyboard shortcuts"
              aria-expanded={helpOpen}
              aria-controls={helpId}
              onClick={() => setHelpOpen((o) => !o)}
            >
              ?
            </button>
          ) : null}
          <p id={statusId} className="arrangement-status" role="status" aria-live="polite" data-tone={status?.tone}>
            {status?.text ?? ''}
          </p>
          {helpOpen ? (
            <div id={helpId} className="arrangement-help" role="note" aria-label="Keyboard shortcuts">
              <dl>
                <div><dt>← →</dt><dd>Nudge by the snap</dd></div>
                <div><dt>Shift ← →</dt><dd>Nudge a bar</dd></div>
                <div><dt>Alt ← →, Home, End</dt><dd>Next, previous, first, last event</dd></div>
                <div><dt>Delete</dt><dd>Delete</dd></div>
                <div><dt>Ctrl/⌘ D</dt><dd>Duplicate</dd></div>
                <div><dt>Ctrl/⌘ Z</dt><dd>Undo</dd></div>
                <div><dt>Ctrl/⌘ Shift Z, Ctrl Y</dt><dd>Redo</dd></div>
                <div><dt>Esc</dt><dd>Deselect, then close</dd></div>
              </dl>
            </div>
          ) : null}
        </div>
      ) : null}

      {empty && !editing ? (
        <div className="arrangement-empty">
          <p>{take ? 'Nothing in this take yet: scenes, fills, Rises and repeats show here as they apply.' : 'No take yet: press Rec, then perform.'}</p>
          {editor && !working ? (
            <button type="button" className="arrangement-action tap" onClick={() => act(editor.startEmpty(), { select: null })}>
              Start an empty arrangement
            </button>
          ) : null}
        </div>
      ) : (
        <div
          className="arrangement-scroll"
          ref={scroller}
          data-beats={barPx >= 64 || undefined}
          style={{ ['--bar-px' as string]: `${barPx}px`, ['--step-px' as string]: `${pps}px` }}
        >
          <div className="arrangement-grid" style={{ width: `calc(var(--lane-label) + ${width}px)` }}>
            <div className="arrangement-ruler" aria-hidden="true">
              <span className="arrangement-corner">Bar</span>
              <div className="arrangement-ruler-track" style={{ width }}>
                {Array.from({ length: bars }, (_, i) => i).filter((i) => i % every === 0).map((i) => (
                  <span key={i} className="arrangement-bar-number" style={{ left: i * barPx }}>
                    {i + 1}
                  </span>
                ))}
              </div>
            </div>
            {LANES.map((lane) => {
              const items = marks.filter((m) => m.lane === lane.id);
              const g = ghost ? marks.find((m) => m.key === ghost.key && m.lane === lane.id) : undefined;
              return (
                <div key={lane.id} className="arrangement-lane" data-lane={lane.id}>
                  <span className="arrangement-lane-label" aria-hidden="true">{lane.label}</span>
                  <ul className="arrangement-track" aria-label={`${lane.label} lane`} style={{ width }}>
                    {items.map((m) => {
                      const isSel = selected === m;
                      return (
                        <li
                          key={m.key}
                          className="arrangement-item"
                          style={{ left: m.start * pps, width: m.span ? (m.end - m.start) * pps : undefined }}
                          data-ghosted={ghost?.key === m.key && !ghost.back ? true : undefined}
                        >
                          <button
                            ref={(b) => {
                              if (b) buttons.current.set(m.key, b);
                              else buttons.current.delete(m.key);
                            }}
                            type="button"
                            className="arrangement-marker"
                            data-kind={m.kind}
                            data-key={m.key}
                            data-span={m.span || undefined}
                            data-open={m.open || undefined}
                            data-flag={m.flag || undefined}
                            data-conflict={m.conflict || undefined}
                            aria-current={isSel || undefined}
                            aria-controls={inspectorId}
                            aria-describedby={m.conflict ? statusId : undefined}
                            tabIndex={tabStop === m ? 0 : -1}
                            aria-label={m.conflict ? `${m.name}, in conflict` : m.name}
                            title={m.name}
                            onClick={() => {
                              if (suppressClick.current) {
                                suppressClick.current = false;
                                return;
                              }
                              select(m.key);
                            }}
                            onFocus={() => setChosen(m.key)}
                            onKeyDown={(event) => onMarkerKey(event, m)}
                            onPointerDown={(event) => onPointerDown(event, m)}
                            onPointerMove={onPointerMove}
                            onPointerUp={(event) => endDrag(event)}
                            onPointerCancel={(event) => endDrag(event, true)}
                          >
                            {m.kind === 'fillInto' ? <span aria-hidden="true">→ </span> : null}
                            <span className="arrangement-marker-text" aria-hidden="true">{m.text}</span>
                          </button>
                        </li>
                      );
                    })}
                    {g && ghost ? (
                      <li
                        className="arrangement-item arrangement-ghost"
                        aria-hidden="true"
                        data-back={ghost.back || undefined}
                        style={{ left: ghost.at * pps, width: g.span ? (g.end - g.start) * pps : undefined }}
                      >
                        <span className="arrangement-marker" data-span={g.span || undefined}>
                          <span className="arrangement-marker-text">{g.text}</span>
                        </span>
                      </li>
                    ) : null}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {conflicts.length ? (
        <div className="arrangement-conflicts" role="group" aria-label="Conflicts">
          <span className="arrangement-conflicts-label" aria-hidden="true">Conflicts</span>
          {conflicts.map((c, i) => (
            <button
              key={`${i}:${c.ids.join(',')}`}
              type="button"
              className="arrangement-conflict tap"
              title={`Select the ${c.ids.length === 1 ? 'event' : `${c.ids.length} events`} in it`}
              onClick={() => {
                const first = c.ids[0];
                if (first) select(first, true);
                setStatus({ text: c.message, tone: 'refused' });
              }}
            >
              <span aria-hidden="true">! </span>
              {c.message}
            </button>
          ))}
        </div>
      ) : null}

      {editing && editor ? (
        <EditInspector
          id={inspectorId}
          mark={selected}
          editor={editor}
          sceneName={sceneName}
          refusal={inlineRefusal}
          act={(r) => act(r, { inline: true })}
          onNudge={(dir) => selected?.w && act(editor.nudge(selected.key, dir), { inline: true, select: selected.key })}
        />
      ) : (
        <Inspector id={inspectorId} placed={selected?.t ?? null} />
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

const REPEAT_LENGTHS = [
  { value: 2, label: '2 steps' },
  { value: 4, label: '1 beat' },
  { value: 8, label: '2 beats' },
  { value: 16, label: '1 bar' },
  { value: 32, label: '2 bars' },
];

/** The selected working event's properties, edited with the app's own controls. */
function EditInspector({
  id,
  mark,
  editor,
  sceneName,
  refusal,
  act,
  onNudge,
}: {
  id: string;
  mark: Mark | null;
  editor: ArrangementApi;
  sceneName: (slot: string) => string;
  refusal: string | null;
  act: (r: EditResult) => void;
  onNudge: (dir: -1 | 1) => void;
}) {
  const e = mark?.w;
  if (!e) {
    return (
      <section id={id} className="arrangement-inspector" aria-label="Selected event">
        <p className="arrangement-inspector-hint">Select an event to edit it: drag it, or use the arrows. Insert adds at bar 1, or after the selection.</p>
      </section>
    );
  }
  const set = (props: Record<string, unknown>) => act(editor.update(e.id, props));
  const slots = SCENE_SLOTS.map((s) => ({ value: s as string, label: sceneName(s), aria: `Scene ${sceneName(s)}` }));
  return (
    <section id={id} className="arrangement-inspector is-edit" aria-label="Selected event" data-conflict={mark.conflict || undefined}>
      <p className="arrangement-inspector-title">
        <span className="arrangement-inspector-kind">{W_KIND[e.kind]}</span>
        <span className="arrangement-inspector-label">{mark.text}</span>
      </p>
      <div className="arrangement-field arrangement-at">
        <span className="control-label">At</span>
        <span className="arrangement-at-value">{takePosition(e.at)}</span>
        <button type="button" className="arrangement-nudge tap" aria-label="Nudge earlier" title="Nudge earlier by the snap" onClick={() => onNudge(-1)}>
          <ChevronLeft aria-hidden="true" size={14} strokeWidth={2.5} />
        </button>
        <button type="button" className="arrangement-nudge tap" aria-label="Nudge later" title="Nudge later by the snap" onClick={() => onNudge(1)}>
          <ChevronRight aria-hidden="true" size={14} strokeWidth={2.5} />
        </button>
      </div>
      {e.kind === 'scene' ? (
        <div className="arrangement-field">
          <Segmented<string> radio label="Scene" value={e.slot} onPick={(slot) => set({ slot })} options={slots} />
        </div>
      ) : null}
      {e.kind === 'fill' ? (
        <>
          <label className="arrangement-field">
            <span className="control-label">Style</span>
            <select className="fill-style-select" value={e.style ?? 'classic'} onChange={(ev) => set({ style: ev.target.value })}>
              {FILL_STYLES.map((st) => (
                <option key={st} value={st}>{FILL_STYLE_LABEL[st]}</option>
              ))}
            </select>
          </label>
          <div className="arrangement-field">
            <Segmented<'bar' | 'beat'> radio label="Length" value={e.length} onPick={(length) => set({ length })}
              options={FILL_LENGTHS.map((l) => ({ value: l, label: FILL_LENGTH_LABEL[l], aria: l === 'beat' ? 'The last beat' : 'The whole bar' }))} />
          </div>
          <label className="arrangement-field">
            <span className="control-label">Into</span>
            <select className="fill-style-select" value={e.into ?? ''} onChange={(ev) => set({ into: ev.target.value || null })}>
              <option value="">No scene</option>
              {SCENE_SLOTS.map((s) => (
                <option key={s} value={s}>{sceneName(s)}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {e.kind === 'rise' ? (
        <>
          <div className="arrangement-field">
            <Segmented<number> radio label="Bars" value={e.bars} onPick={(b) => set({ bars: b })}
              options={[2, 4, 8].map((b) => ({ value: b, label: String(b), aria: `Rise over ${b} bars` }))} />
          </div>
          <label className="arrangement-field">
            <span className="control-label">Into</span>
            <select className="fill-style-select" value={e.slot} onChange={(ev) => set({ slot: ev.target.value })}>
              {SCENE_SLOTS.map((s) => (
                <option key={s} value={s}>{sceneName(s)}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {e.kind === 'repeat' ? (
        <>
          <div className="arrangement-field">
            <Segmented<number> radio label="Division" value={e.division} onPick={(division) => set({ division })}
              options={[4, 8, 16].map((d) => ({ value: d, label: `1/${d}`, aria: `Repeat 1/${d}` }))} />
          </div>
          <label className="arrangement-field">
            <span className="control-label">Length</span>
            <select className="fill-style-select" value={e.length} onChange={(ev) => set({ length: Number(ev.target.value) })}>
              {(REPEAT_LENGTHS.some((l) => l.value === e.length) ? REPEAT_LENGTHS : [...REPEAT_LENGTHS, { value: e.length, label: `${e.length} steps` }]).map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </label>
        </>
      ) : null}
      {refusal ? <p className="arrangement-refusal">{refusal}</p> : null}
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
