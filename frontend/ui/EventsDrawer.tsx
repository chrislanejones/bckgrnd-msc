/**
 * The performance-events drawer (Night 11): a compact inspector for the current take.
 *
 * It opens from a small Events toggle beside the Record indicator, a real disclosure
 * (`aria-expanded`, `aria-controls`), and is folded by default; the open state is
 * remembered per viewer (`bckgrnd-msc:events-open`). Open, it is a sheet pinned under
 * the transport at the right edge (the inspector's side on the phone), so it never
 * pushes the scenes toolbar or adds page scroll; it scrolls inside itself.
 *
 * Inside: one row per applied event, newest first, each with its kind (Scene, Fill,
 * Rise, Into, Repeat), what it was (the scene, the fill's style and length, the
 * division), where it landed ("Bar 9.1 · pass 2") and how it went (Cut short, Landed,
 * Crash). Export downloads the take as JSON and is unavailable, with the reason, until
 * there is a take; Clear empties a stopped take, as the Record indicator's own Clear.
 *
 * Esc closes it from anywhere inside and gives focus back to the toggle; opening it
 * moves focus to its heading, so a screen reader lands in the labeled region.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Download, ListOrdered, X } from 'lucide-react';
import { describeEvent, type PerformanceEvent, type PerformanceRecording } from '../lib/recording';
import type { RecordingControls } from './RecordToggle';

// ---- The adapter ------------------------------------------------------------------
//
// The one place the drawer reads the take. The recorder's final API (night11/recording,
// defaae2) is `inst.recording.recording()`, `.exportTake()`, `.downloadTake()`, and
// `describeEvent(e)` exported from lib/recording.ts. The methods stay optional on
// `TakeSource`, with a fallback, for a host without them.

/** What the drawer needs of `inst.recording`. The optional names are the recorder's. */
export type TakeSource = RecordingControls & {
  /** A new array on every change to the take (outcomes included): the memo key. */
  log?: readonly unknown[];
  recording?: () => PerformanceRecording | null;
  exportTake?: () => TakeExport | null;
  downloadTake?: (t?: TakeExport | null) => boolean;
};

export type TakeExport = { filename: string; json: string };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type EventRow = {
  seq: number;
  kind: string;
  /** The kind tag: "Scene", "Fill", "Rise", "Into", "Repeat". */
  kindLabel: string;
  /** What it was, without the kind's own word: "Sparse", "Busy beat", "Drop", "1/16". */
  what: string;
  /** "Bar 9.1", "Bar 2.4 · pass 4", "Bar 1.1 · off grid". */
  position: string;
  /** How it went, short: "Cut short", "2 bars · landed", "Crash". Empty when nothing to say. */
  outcome: string;
  /** The outcome needs attention: a fill cut short, a Rise canceled or replaced. */
  flag: boolean;
};

const KIND_TAG: Record<string, string> = { scene: 'Scene', fill: 'Fill', fillInto: 'Into', rise: 'Rise', repeat: 'Repeat' };
/** The words `describeEvent` puts before the name, which the kind tag already says. */
const KIND_PREFIX = /^(Scene|Fill into|Rise to|Repeat) /;

/** One event as a row: the kind tag, then `describeEvent`'s label, position and detail. */
export function rowOf(e: PerformanceEvent): EventRow {
  const d = describeEvent(e);
  const kind = (e as { kind: string }).kind;
  const outcome = (e as { outcome?: string }).outcome;
  return {
    seq: e.seq,
    kind,
    kindLabel: KIND_TAG[kind] ?? cap(kind),
    what: d.label.replace(KIND_PREFIX, ''),
    position: d.position,
    outcome: d.detail ? cap(d.detail) : '',
    flag: outcome === 'cutShort' || outcome === 'cancelled' || outcome === 'replaced',
  };
}

function takeOf(read: TakeSource['recording']): PerformanceRecording | null {
  if (read) return read();
  return typeof window !== 'undefined' ? (window.__BCKGRND_RECORDING__?.recording() ?? null) : null;
}

/** Download the take: the recorder's `downloadTake` when there, else the same in place. */
function downloadOf(src: TakeSource, take: PerformanceRecording | null): void {
  if (src.downloadTake) {
    src.downloadTake();
    return;
  }
  if (!take) return;
  const t: TakeExport = src.exportTake?.() ?? {
    filename: `bckgrnd-take-${take.track.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'track'}.json`,
    json: `${JSON.stringify(take, null, 2)}\n`,
  };
  const url = URL.createObjectURL(new Blob([t.json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = t.filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---- The open state ---------------------------------------------------------------

export const EVENTS_OPEN_PREF = 'bckgrnd-msc:events-open';

/** The drawer's open state, remembered per viewer. Closed by default. */
export function useEventsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(EVENTS_OPEN_PREF) === 'open';
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(EVENTS_OPEN_PREF, next ? 'open' : 'closed');
    } catch {
      /* storage unavailable: it lasts for this visit */
    }
  }, []);
  return [open, set];
}

const events = (n: number) => `${n} event${n === 1 ? '' : 's'}`;

// ---- The toggle -------------------------------------------------------------------

/** The Events disclosure beside the Record indicator: a list icon, 32px (44 on touch). */
export function EventsToggle({
  open,
  onToggle,
  controls,
  count,
  buttonRef,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  count: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="events-toggle tap"
      aria-expanded={open}
      aria-controls={controls}
      aria-label="Take events"
      title={open ? 'Hide the take events' : `Show the take events (${events(count)})`}
      onClick={onToggle}
    >
      <ListOrdered aria-hidden="true" size={14} strokeWidth={2.25} />
    </button>
  );
}

// ---- The drawer -------------------------------------------------------------------

const NO_TAKE = 'No take yet: press Rec, then perform';

export function EventsDrawer({
  id,
  open,
  source,
  onClose,
  returnFocus,
}: {
  id: string;
  open: boolean;
  source: TakeSource;
  onClose: () => void;
  /** The toggle, which gets focus back when Esc or Close shuts the drawer. */
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const headingId = useId();
  const reasonId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { state, count, log, recording: read } = source;
  // Read only while open, and only when the take changed: `log` is a new array on every
  // change to it, outcomes included (`count` and `state` cover a source without it).
  // `read` has one identity for the life of the app.
  const take = useMemo(() => {
    void log;
    void count;
    void state;
    return open ? takeOf(read) : null;
  }, [open, read, log, count, state]);
  const rows = useMemo(() => (take ? take.events.map(rowOf).reverse() : []), [take]);

  // Opening moves focus to the heading, so the region is announced by its name.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) headingRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const close = useCallback(() => {
    onClose();
    returnFocus.current?.focus();
  }, [onClose, returnFocus]);

  // Esc from inside closes it (and only it: the app's own Escape sees it was handled).
  // From elsewhere the app's Escape closes it once nothing nearer is open.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
  };

  const noTake = take === null;
  const summary = noTake
    ? 'No take'
    : state === 'recording'
      ? `Recording · ${events(rows.length)}`
      : `Stopped · ${events(rows.length)}`;

  return (
    <section id={id} className="events-drawer" aria-labelledby={headingId} hidden={!open} data-state={state} onKeyDown={onKeyDown}>
      <header className="events-head">
        <div className="events-title">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="panel-title">
            Take events
          </h2>
          <p className="events-summary">{summary}</p>
        </div>
        <div className="events-actions">
          <button
            type="button"
            className="events-action tap"
            aria-disabled={noTake || undefined}
            aria-describedby={noTake ? reasonId : undefined}
            title={noTake ? NO_TAKE : 'Download the take as JSON'}
            onClick={() => {
              if (!noTake) downloadOf(source, take);
            }}
          >
            <Download aria-hidden="true" size={12} strokeWidth={2.5} />
            Export
          </button>
          {state === 'stopped' ? (
            <button
              type="button"
              className="events-action tap"
              aria-label={`Clear the take · ${events(count)}`}
              title={`Clear the take (${events(count)})`}
              onClick={source.clearRecording}
            >
              Clear
            </button>
          ) : null}
          <button type="button" className="events-close tap" aria-label="Close the take events" title="Close (Esc)" onClick={close}>
            <X aria-hidden="true" size={14} strokeWidth={2.5} />
          </button>
        </div>
      </header>
      {noTake ? (
        <p id={reasonId} className="events-empty">
          {NO_TAKE}. Applied scenes, fills, Rises and repeats appear here, newest first.
        </p>
      ) : rows.length === 0 ? (
        <p className="events-empty">
          {state === 'recording' ? 'Recording. Nothing applied yet.' : 'This take is empty.'}
        </p>
      ) : (
        <ol className="events-list" aria-label={`${events(rows.length)}, newest first`}>
          {rows.map((r) => (
            <li key={r.seq} className="events-row" data-kind={r.kind} data-flag={r.flag || undefined}>
              <span className="events-seq" aria-hidden="true">{r.seq}</span>
              <span className="events-kind">
                <span className="sr-only">{`Event ${r.seq}: `}</span>
                {r.kindLabel}
              </span>
              <span className="events-what">
                <span className="sr-only">, </span>
                {r.what}
              </span>
              <span className="events-pos">
                <span className="sr-only">, at </span>
                {r.position}
              </span>
              {r.outcome ? (
                <span className="events-outcome">
                  <span className="sr-only">, </span>
                  {r.outcome}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
