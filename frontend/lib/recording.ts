/**
 * Performance recording, v2 (docs/PERFORMANCE_EVENTS.md, contracts/performance.json).
 *
 * An in-memory take of what the performer actually did: the scenes, fills, Rises, Fill
 * intos and Beat Repeats the engine applied, each at the engine step it applied on and
 * at its onset (the engine's monotonic onset serial, counted from the take's first
 * event). Queued, canceled, rejected and replaced requests never enter the take, nor
 * does a Beat Repeat released before its grid line; they go to the developer log only,
 * tagged with their status, so the difference can be seen.
 *
 * Pure: no React, no engine, no clock for positions. The host feeds it engine events
 * (`fromEngine`) and what each request asked for (`RequestCatalog`); a test can feed it
 * by hand. Musical positions come from engine steps and serials only, never
 * `performance.now()`. The one wall-clock value is `recordedAt`, a label for the file.
 *
 * ## For the event inspector (the drawer)
 *
 * Read these names; they are kept stable.
 *
 * | Name | What it is |
 * |---|---|
 * | `inst.recording.state` | `'idle' \| 'recording' \| 'stopped'` |
 * | `inst.recording.count` | Events in the take |
 * | `inst.recording.log` | The developer log. A new array whenever anything happens to the take, so it is the memo key |
 * | `inst.recording.recording()` | A copy of the take (`PerformanceRecording`), or null. `.events` is the list to show |
 * | `inst.recording.exportTake()` | `{ filename, json }` (`TakeExport`), or null with no take |
 * | `inst.recording.downloadTake(t?)` | Saves `t` (or a fresh export) as a file in the browser; false with no take |
 * | `describeEvent(e)` | `{ label, position, detail }` for one event: "Busy beat", "Bar 8.4 · pass 2", "4-bar phrase" |
 * | `downloadTake(t)` | The browser download on its own, for a `TakeExport` |
 *
 * ```ts
 * const take = useMemo(() => inst.recording.recording(), [inst.recording.log]);
 * take?.events.map((e) => { const d = describeEvent(e); return `${d.position}  ${d.label}  ${d.detail}`; });
 * ```
 *
 * Export works while recording too: the document then has `stoppedBy: null`, and a
 * repeat still held says `endedBy: 'open'`.
 */

export const PERFORMANCE_FORMAT = 'bckgrnd-msc/performance';
export const PERFORMANCE_VERSION = 2;
export const STEPS_PER_BAR = 16;
/** The engine's song: 16 bars of 16 steps. Song steps are 0..255. */
export const SONG_STEPS = 256;
/** A take holds at most this many events; the next applied one stops the take. */
export const MAX_EVENTS = 10_000;
/** The developer log keeps the newest this many entries. */
export const MAX_LOG = 500;

// ---- Positions ------------------------------------------------------------------

/** Where an event sits in the 16-bar song. Bars, beats and sixteenths are 1-based. */
export type Position = {
  /** Song step, 0..255: the engine's own step, or for an off-grid apply the transport's. */
  step: number;
  bar: number;
  beat: number;
  sixteenth: number;
  /**
   * Applied off the grid (a Now launch, or anything while stopped): the engine gave no
   * step (-1), so `step` is the transport's step from telemetry, or 0 when stopped.
   */
  offGrid?: true;
  /**
   * Onsets since the take's first event (which is 0): the engine's monotonic onset
   * serial `s`, less the first event's. Never wraps or jumps, so it orders and spaces
   * events across song wraps, loops, cues and seeks. Required in v2; absent only when
   * the engine sent no serial, and such a take does not validate.
   */
  onset?: number;
  /**
   * 1-based run through the song, for people: it goes up when the song wraps, and by at
   * least one across a loop, a cue or a seek between this event and the one before. A
   * label; `onset` is the position.
   */
  pass?: number;
};

/**
 * The position of an engine step. `engineStep` -1 (Now, stopped) is placed at
 * `transportStep`, the step sounding per telemetry, or at 0 when the transport is
 * stopped (Play starts at step 0), and flagged `offGrid`.
 */
export function positionOf(engineStep: number, transportStep = -1): Position {
  const onGrid = Number.isInteger(engineStep) && engineStep >= 0;
  const raw = onGrid ? engineStep : Number.isInteger(transportStep) && transportStep >= 0 ? transportStep : 0;
  const step = ((raw % SONG_STEPS) + SONG_STEPS) % SONG_STEPS;
  const inBar = step % STEPS_PER_BAR;
  return {
    step,
    bar: Math.floor(step / STEPS_PER_BAR) + 1,
    beat: Math.floor(inBar / 4) + 1,
    sixteenth: (inBar % 4) + 1,
    ...(onGrid ? {} : { offGrid: true as const }),
  };
}

const wrapStep = (n: number) => ((n % SONG_STEPS) + SONG_STEPS) % SONG_STEPS;
const isSerial = (s: unknown): s is number => typeof s === 'number' && Number.isInteger(s) && s >= 0;

// ---- The take -------------------------------------------------------------------

/** Kinds captured in v2. `filter`, `echo` and `gesture` are reserved. */
export type RecordedKind = 'scene' | 'fill' | 'rise' | 'fillInto' | 'repeat';
export const RESERVED_KINDS = ['filter', 'echo', 'gesture'] as const;

export type Timing = 'now' | 'beat' | 'bar';
export type FillLink = 'none' | 'fillInto' | 'rise';
/** What a fill played: the whole bar, or only its last beat (steps 12-15). */
export type FillLength = 'bar' | 'beat';

type Common = Position & {
  /** 1, 2, 3... in the order applied. Ties on a step keep the engine's order. */
  seq: number;
};

type Requested = Common & {
  /** The host's request id: session-local, links a fill to its Rise or Fill into. */
  requestId: number;
};

export type SceneRecord = Requested & {
  kind: 'scene';
  slot: string;
  name: string;
  timing: Timing;
  /** The crash accent fired with it. */
  crash: boolean;
};

export type FillRecord = Requested & {
  kind: 'fill';
  style: string | null;
  /**
   * The length it played: `bar`, or `beat` (only the bar's last beat, so it starts on
   * beat 4). The effective one: Bar when the track has no beat fills.
   */
  length: FillLength;
  /** 0: the next bar; 2, 4, 8 or 16: the phrase it ended. */
  phraseBars: number;
  link: FillLink;
  /** The request it led into (the Fill into's scene, or the Rise), if linked. */
  partner?: number;
  /** `played`: ran its bar; `cutShort`: stopped early; `open`: still playing when the take stopped. */
  outcome: 'played' | 'cutShort' | 'open';
  /** The step the track's drums resumed on (`played` only). */
  endStep?: number;
  /** The onset of `endStep`. */
  endOnset?: number;
  /** `ENGINE_REASON` it was cut short for. */
  reason?: number;
};

export type RiseRecord = Requested & {
  kind: 'rise';
  /** The landing scene. */
  slot: string;
  name: string;
  bars: number;
  withFill: boolean;
  /** The fill's request id, for Rise + Fill. */
  fillRequestId?: number;
  /**
   * `landed`: it ran its bars and reached the scene (`buildApplied`); `cancelled` or
   * `replaced`: stopped mid-rise; `open`: still rising when the take stopped.
   * The start was applied either way: what was heard is part of the take.
   */
  outcome: 'landed' | 'cancelled' | 'replaced' | 'open';
  endStep?: number;
  /** The onset of `endStep`. */
  endOnset?: number;
  reason?: number;
  crash: boolean;
};

export type FillIntoRecord = Requested & {
  kind: 'fillInto';
  /** The scene it landed. */
  slot: string;
  name: string;
  fillRequestId: number;
  /** The length its fill played (`FillRecord.length`). */
  length: FillLength;
  crash: boolean;
};

export type RepeatDivision = 4 | 8 | 16;

/**
 * `engine`: the engine said it ended (event 62: a release, Release FX, a brake, the
 * lease); `recapture`: the same hold captured again (a division change, Play from step
 * 0), and the next `repeat` with this token carries on; `take`: the take stopped while
 * it was held, so it is closed at the stop; `open`: still held, in a take still recording.
 */
export type RepeatEnd = 'engine' | 'recapture' | 'take' | 'open';

/** A Beat Repeat that engaged: its start (the grid line it captured on) and its end. */
export type RepeatRecord = Common & {
  kind: 'repeat';
  /** The gesture token: session-local, one hold. Not a request id. */
  token: number;
  /** 4, 8 or 16: a quarter, eighth or sixteenth note. */
  division: RepeatDivision;
  endedBy: RepeatEnd;
  /** Where it ended (absent while `open`). For `take`, the transport step at the stop. */
  endStep?: number;
  /** The onset of `endStep`. For `take`, counted forward from the last engine event to the stop. */
  endOnset?: number;
  /** The engine's reason code from event 62 (`engine` only). */
  reason?: number;
};

export type PerformanceEvent = SceneRecord | FillRecord | RiseRecord | FillIntoRecord | RepeatRecord;

export type StopReason = 'user' | 'stop' | 'panic' | 'track' | 'mix' | 'cap';

/** One stem's settings, by contracts/parameters.json stem-parameter id. */
export type InitialStem = { volume: number; send: number; muted: boolean; solo: boolean };

/**
 * What the performer started from when Record was pressed: the track, tempo and swing,
 * the active scene, the whole mix by contracts/parameters.json ids, the Fill style and
 * length, Beat Repeat's division and the loop. Optional for a reader (a v2 take written
 * before Night 11B lacks it); the app always writes it. Never a project.
 */
export type InitialState = {
  track: string;
  bpm: number;
  swing: number;
  /** The active scene slot (null: none), and whether the mix had moved away from it. */
  scene: { slot: string | null; modified: boolean };
  mix: {
    /** Every contracts/parameters.json parameter, by id; a toggle is 0 or 1. */
    params: Record<string, number>;
    /** Every stem, by id. */
    stems: Record<string, InitialStem>;
  };
  /** The Fill style menu's choice (a style, or random or rotate), and the length a press plays. */
  fill: { style: string; length: FillLength };
  repeatDivision: RepeatDivision;
  /** The loop in bars, 0 for none (`performance.loopBars`). */
  loopBars: number;
};

export type PerformanceRecording = {
  format: typeof PERFORMANCE_FORMAT;
  version: typeof PERFORMANCE_VERSION;
  track: string;
  bpm: number;
  stepsPerBar: typeof STEPS_PER_BAR;
  /** When Record was pressed, ISO 8601 UTC. A label for the file; never a position. */
  recordedAt: string;
  /** The song step sounding when Record was pressed; -1 if none had sounded yet (stopped, or before Play's first onset). */
  startedAtStep: number;
  /** Why the take ended; null while it is still recording. */
  stoppedBy: StopReason | null;
  /** True if the cap stopped it. */
  truncated: boolean;
  /** What the performer started from. Always written; a reader treats it as optional. */
  initial?: InitialState;
  events: PerformanceEvent[];
};

// ---- Inputs and the developer log ----------------------------------------------

export type InputStatus =
  | 'queued' | 'canceled' | 'rejected' | 'replaced' | 'applied' | 'ended' | 'unlinked' | 'crash'
  | 'pressed' | 'released';

/**
 * What the session is told. Only `applied` can add an event; `ended`, `unlinked` and
 * `crash` amend one. `pressed` and `released` (a Beat Repeat's hold, from the host)
 * are log only.
 */
export type PerformanceInput = {
  status: InputStatus;
  kind: RecordedKind;
  /** The request id, or for `repeat` the gesture token. */
  requestId: number;
  /** The engine's step (-1 for none). */
  step?: number;
  /** The transport's step from telemetry, to place an off-grid apply. */
  transportStep?: number;
  /** The engine's onset serial `s` on the event. */
  serial?: number;
  reason?: number;
  /** The kind-specific fields of an applied event. */
  payload?: Record<string, unknown>;
  /** For `ended`, or a Rise's `canceled`/`replaced`: what a recorded event's outcome becomes, if it was recorded. */
  outcome?: string;
};

export type LogEntry = {
  /** Running count of log entries this session, never reset by Clear. */
  n: number;
  status: InputStatus | 'session';
  kind: RecordedKind | 'session';
  /** The request id, or for `repeat` the gesture token. */
  requestId: number;
  step: number;
  /** In the take: true only for an applied event that was recorded. */
  recorded: boolean;
  detail: string;
};

export type RecordingState = 'idle' | 'recording' | 'stopped';

/** Where the take's onsets are counted from, and the last on-grid event, for `pass`. */
type Clock = { origin: number; last: { onset: number; step: number; pass: number } | null };

/** The in-memory recording session: Start, Stop, Clear, and what was applied. */
export class RecordingSession {
  state: RecordingState = 'idle';
  private take: PerformanceRecording | null = null;
  private clock: Clock | null = null;
  /** The latest engine position seen in this take (any input with a step and a serial). */
  private seen: { serial: number; step: number } | null = null;
  private entries: LogEntry[] = [];
  private logged = 0;
  private listeners = new Set<() => void>();
  constructor(private readonly cap = MAX_EVENTS, private readonly logCap = MAX_LOG) {}

  get count(): number {
    return this.take?.events.length ?? 0;
  }

  get log(): readonly LogEntry[] {
    return this.entries;
  }

  /** The take, as the contract describes it: a copy, null before the first Start. */
  recording(): PerformanceRecording | null {
    return this.take ? structuredClone(this.take) : null;
  }

  /**
   * The take as its own file (`TakeExport`), or null with no take, or when an event has
   * no onset (an engine without serials): such a file would claim v2 and not be one.
   */
  exportTake(): TakeExport | null {
    const take = this.recording();
    return take && hasOnsets(take) ? exportTake(take) : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start a new take. A take already recording, or a stopped one, is replaced. */
  start(track: string, bpm: number, transportStep: number, recordedAt: string = new Date().toISOString(), initial?: InitialState): void {
    const startedAtStep = Number.isInteger(transportStep) && transportStep >= 0 ? transportStep % SONG_STEPS : -1;
    this.take = {
      format: PERFORMANCE_FORMAT,
      version: PERFORMANCE_VERSION,
      track,
      bpm,
      stepsPerBar: STEPS_PER_BAR,
      recordedAt,
      startedAtStep,
      stoppedBy: null,
      truncated: false,
      ...(initial ? { initial: structuredClone(initial) } : {}),
      events: [],
    };
    this.clock = null;
    this.seen = null;
    this.state = 'recording';
    this.note('session', startedAtStep, `start ${track} at ${bpm} BPM`);
  }

  /**
   * End the take, keeping it. Nothing is added after this. A Beat Repeat still held is
   * closed here (`endedBy: 'take'`), at `transportStep`, the song step sounding at the
   * stop per telemetry (-1: unknown, so the last engine position seen).
   */
  stop(reason: StopReason = 'user', transportStep = -1): void {
    if (this.state !== 'recording' || !this.take) return;
    for (const e of this.take.events) {
      if (e.kind === 'repeat' && e.endedBy === 'open') this.closeAtStop(e, transportStep);
    }
    this.take.stoppedBy = reason;
    if (reason === 'cap') this.take.truncated = true;
    this.state = 'stopped';
    this.note('session', -1, `stop: ${reason}`);
  }

  /** Drop the take. The developer log stays, so the clear itself can be seen. */
  clear(): void {
    this.take = null;
    this.clock = null;
    this.seen = null;
    this.state = 'idle';
    this.note('session', -1, 'clear');
  }

  /**
   * Something outside the take moved the transport. Stop, Panic, a track load and an
   * auto-mix end the take (positions start over or the track changes); a cue or a seek
   * keeps it: song positions stay right, and onsets never jump.
   */
  interrupt(what: 'stop' | 'panic' | 'track' | 'mix' | 'cue' | 'seek', transportStep = -1): void {
    if (this.state !== 'recording') return;
    if (what === 'cue' || what === 'seek') {
      this.note('session', -1, `${what}: still recording`);
      return;
    }
    this.stop(what, transportStep);
  }

  /** Tell the session one thing that happened. Every input is logged; only applied ones are kept. */
  record(input: PerformanceInput): void {
    const step = input.step ?? -1;
    const recording = this.state === 'recording' && this.take !== null;
    if (recording && isSerial(input.serial) && step >= 0) this.seen = { serial: input.serial, step: wrapStep(step) };
    if (input.status === 'pressed' || input.status === 'released') return this.logHold(input, recording);
    if (input.status === 'applied') {
      if (!recording) return this.logInput(input, step, false, 'not recording');
      if (this.take!.events.length >= this.cap) {
        this.logInput(input, step, false, `dropped: cap of ${this.cap} events`);
        this.stop('cap');
        return;
      }
      const at = this.place(step, input.transportStep, input.serial);
      const notes: string[] = [];
      if (input.kind === 'repeat') {
        // The same hold capturing again: the earlier capture ends where this one starts.
        const held = this.find('repeat', input.requestId);
        if (held && held.kind === 'repeat') {
          held.endedBy = 'recapture';
          held.endStep = at.step;
          if (at.onset !== undefined) held.endOnset = at.onset;
          notes.push(`recaptures #${held.seq}`);
        }
      }
      const event = {
        seq: this.take!.events.length + 1,
        kind: input.kind,
        ...(input.kind === 'repeat' ? { token: input.requestId } : { requestId: input.requestId }),
        ...at,
        ...defaults(input.kind),
        ...(input.payload ?? {}),
      } as PerformanceEvent;
      this.take!.events.push(event);
      if (at.offGrid) notes.unshift('off grid');
      return this.logInput(input, at.step, true, notes.join('; '));
    }
    const amends = input.status === 'ended' || input.status === 'unlinked' || input.status === 'crash' || input.outcome !== undefined;
    if (amends) {
      const target = recording ? this.find(input.kind, input.requestId) : null;
      if (target) this.amend(target, input);
      const why = input.reason !== undefined ? `reason ${input.reason}` : '';
      return this.logInput(input, step, false, [why, target ? `amends #${target.seq}` : ''].filter(Boolean).join('; '));
    }
    this.logInput(input, step, false, input.reason !== undefined ? `reason ${input.reason}` : '');
  }

  /**
   * The position of an applied event: song step, bar, beat and sixteenth as v1, plus
   * the onset and the pass when the engine sent a serial. The first event fixes the
   * origin. An off-grid event takes the onset of its serial (the onset sounding when it
   * applied) and the pass that onset falls in, counting wraps from the last on-grid
   * event, and does not move that reference: its telemetry step can trail the engine.
   */
  private place(step: number, transportStep: number | undefined, serial: number | undefined): Position {
    const at = positionOf(step, transportStep);
    if (!isSerial(serial)) return at;
    this.clock ??= { origin: serial, last: null };
    const onset = Math.max(0, serial - this.clock.origin);
    const last = this.clock.last;
    let pass = 1;
    if (last) {
      const d = Math.max(0, onset - last.onset);
      const reach = last.step + d;
      const wraps = Math.floor(reach / SONG_STEPS);
      const continuous = wrapStep(reach) === at.step;
      pass = last.pass + (at.offGrid || continuous ? wraps : Math.max(1, wraps));
    }
    if (!at.offGrid) this.clock.last = { onset, step: at.step, pass };
    return { ...at, onset, pass };
  }

  /** The onset of a song step given with an end event's serial, if the take has an origin. */
  private onsetOf(serial: number | undefined): number | undefined {
    if (!isSerial(serial) || !this.clock) return undefined;
    return Math.max(0, serial - this.clock.origin);
  }

  /**
   * Close a held repeat at the take's stop: the transport step at the stop, and its
   * onset counted forward from the last engine position seen. A telemetry step that
   * trails that position (output latency) counts as no time at all.
   */
  private closeAtStop(e: RepeatRecord, transportStep: number) {
    e.endedBy = 'take';
    const seen = this.seen;
    const stopStep = Number.isInteger(transportStep) && transportStep >= 0 ? wrapStep(transportStep) : -1;
    if (!seen) {
      e.endStep = stopStep >= 0 ? stopStep : e.step;
      if (e.onset !== undefined) e.endOnset = e.onset;
      return;
    }
    let ahead = stopStep >= 0 ? wrapStep(stopStep - seen.step) : 0;
    if (ahead > SONG_STEPS - 64) ahead = 0;
    e.endStep = wrapStep(seen.step + ahead);
    const onset = this.onsetOf(seen.serial);
    if (onset !== undefined) e.endOnset = Math.max(e.onset ?? 0, onset + ahead);
  }

  private amend(e: PerformanceEvent, input: PerformanceInput) {
    if (input.status === 'crash') {
      if ('crash' in e) e.crash = true;
      return;
    }
    if (input.status === 'unlinked') {
      if (e.kind === 'fill') {
        e.link = 'none';
        delete e.partner;
      }
      return;
    }
    if (e.kind === 'repeat') {
      if (input.status !== 'ended') return;
      e.endedBy = 'engine';
      e.endStep = input.step !== undefined && input.step >= 0 ? wrapStep(input.step) : (this.seen?.step ?? e.step);
      const onset = this.onsetOf(input.serial);
      if (onset !== undefined) e.endOnset = Math.max(e.onset ?? 0, onset);
      if (input.reason !== undefined) e.reason = input.reason;
      return;
    }
    // `ended` (or a Rise's cancel or replace): a fill's or a Rise's outcome, once.
    if ((e.kind === 'fill' || e.kind === 'rise') && e.outcome === 'open') {
      e.outcome = input.outcome as never;
      if (input.step !== undefined && input.step >= 0) {
        e.endStep = input.step;
        const onset = this.onsetOf(input.serial);
        if (onset !== undefined) e.endOnset = onset;
      }
      if (input.reason !== undefined) e.reason = input.reason;
    }
  }

  /** The newest event of a kind for an id. For `repeat`, only one still held. */
  private find(kind: RecordedKind, id: number): PerformanceEvent | null {
    const events = this.take?.events ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.kind !== kind) continue;
      if (e.kind === 'repeat' ? e.token === id && e.endedBy === 'open' : e.requestId === id) return e;
    }
    return null;
  }

  /** A Beat Repeat's press or release, from the host: log only. */
  private logHold(input: PerformanceInput, recording: boolean) {
    const held = recording ? this.find('repeat', input.requestId) : null;
    const detail = input.status === 'pressed'
      ? (recording ? 'held: waits for its grid line' : 'not recording')
      : !recording ? 'not recording'
        : held ? `release sent: #${held.seq} ends on the engine's word`
          : 'released with no engage seen: before its grid line, so not in the take';
    this.logInput(input, -1, false, detail);
  }

  private logInput(input: PerformanceInput, step: number, recorded: boolean, detail: string) {
    this.push({ status: input.status, kind: input.kind, requestId: input.requestId, step, recorded, detail });
  }

  private note(status: 'session', step: number, detail: string) {
    this.push({ status, kind: 'session', requestId: 0, step, recorded: false, detail });
  }

  private push(entry: Omit<LogEntry, 'n'>) {
    this.logged += 1;
    this.entries = [...this.entries.slice(-(this.logCap - 1)), { n: this.logged, ...entry }];
    for (const listener of this.listeners) listener();
  }
}

function defaults(kind: RecordedKind): Record<string, unknown> {
  switch (kind) {
    case 'scene':
      return { crash: false };
    case 'fillInto':
      return { length: 'bar', crash: false };
    case 'fill':
      return { length: 'bar', link: 'none', outcome: 'open' };
    case 'rise':
      return { withFill: false, outcome: 'open', crash: false };
    case 'repeat':
      return { endedBy: 'open' };
  }
}

// ---- Export, import and the inspector's labels -------------------------------------

/** A take as its own document: what Export saves. */
export type TakeExport = { filename: string; json: string };

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * `bckgrnd-take-<track>-<YYYY-MM-DD-HHmm>.json`, in local time at `recordedAt` (when
 * Record was pressed), so exporting one take twice names it the same.
 */
export function takeFilename(track: string, recordedAt: string): string {
  const id = track.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'track';
  const t = new Date(recordedAt);
  const when = Number.isNaN(t.getTime())
    ? 'undated'
    : `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}-${pad2(t.getHours())}${pad2(t.getMinutes())}`;
  return `bckgrnd-take-${id}-${when}.json`;
}

/** A take as a standalone, versioned JSON document. Never part of a project. */
/** Whether every event carries an onset, which a v2 export needs. */
export function hasOnsets(take: PerformanceRecording): boolean {
  return take.events.every((e) => typeof (e as { onset?: unknown }).onset === 'number');
}

export function exportTake(take: PerformanceRecording): TakeExport {
  return { filename: takeFilename(take.track, take.recordedAt), json: `${JSON.stringify(take, null, 2)}\n` };
}

/**
 * Read an exported take. Refuses another format, a newer version and version 1 (it was
 * never exported, and has no onsets to recover). Checks the header only; the full
 * shape is `contracts/performance.json` (tools/check-recording.mjs validates it).
 */
export function parseTake(text: string): PerformanceRecording {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not a performance take: not JSON.');
  }
  const d = doc as Partial<PerformanceRecording> | null;
  if (!d || typeof d !== 'object' || d.format !== PERFORMANCE_FORMAT) throw new Error('Not a performance take.');
  if (typeof d.version !== 'number' || !Number.isInteger(d.version)) throw new Error('This take has no version.');
  if (d.version > PERFORMANCE_VERSION) throw new Error(`This take is version ${d.version}, newer than this app reads (${PERFORMANCE_VERSION}).`);
  if (d.version < PERFORMANCE_VERSION) throw new Error(`This is a version ${d.version} take. This app opens version ${PERFORMANCE_VERSION} takes only: version ${d.version} has no onsets.`);
  if (!Array.isArray(d.events)) throw new Error('This take has no events.');
  const missing = d.events.findIndex((e) => typeof (e as { onset?: unknown } | null)?.onset !== 'number');
  if (missing >= 0) throw new Error(`Event ${missing + 1} has no onset, so it can't be placed. The take may be from an engine before Night 11.`);
  return d as PerformanceRecording;
}

export type OpenResult = { ok: true; take: PerformanceRecording } | { ok: false; error: string };

const KNOWN_KINDS: readonly string[] = ['scene', 'fill', 'rise', 'fillInto', 'repeat'];

/**
 * Open a take file: `parseTake`, then the whole of contracts/performance.json
 * (`validate`, frontend/lib/take-schema.ts). The error is plain English and names the
 * first problem: not JSON, another format, a version, an event kind this app does not
 * know, an event with no onset, or anything else the schema refuses.
 */
export function openTakeText(text: string, validate: (doc: unknown) => string[]): OpenResult {
  let take: PerformanceRecording;
  try {
    take = parseTake(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  for (const [i, raw] of take.events.entries()) {
    const e = raw as { kind?: unknown; onset?: unknown } | null;
    const n = i + 1;
    if (!e || typeof e !== 'object') return { ok: false, error: `Event ${n} is not an event.` };
    if (typeof e.kind === 'string' && (RESERVED_KINDS as readonly string[]).includes(e.kind)) {
      return { ok: false, error: `Event ${n} is a ${e.kind} event, which this app does not record yet.` };
    }
    if (typeof e.kind !== 'string' || !KNOWN_KINDS.includes(e.kind)) {
      return { ok: false, error: `Event ${n} is of a kind this app does not know (${JSON.stringify(e.kind ?? null)}).` };
    }
  }
  const errors = validate(take);
  if (errors.length > 0) {
    const first = errors[0]!.replace(/^\$\.?/, '') || 'the document';
    return { ok: false, error: `This take doesn't match the take format (${first}${errors.length > 1 ? `, and ${errors.length - 1} more` : ''}).` };
  }
  return { ok: true, take };
}

/** "Opened: <file>", or the track and when it was recorded: "warehouse · 11-26-2026 21:07". */
export function openedLabel(take: PerformanceRecording, filename?: string | null): string {
  if (filename) return filename;
  const t = new Date(take.recordedAt);
  const when = Number.isNaN(t.getTime())
    ? ''
    : ` · ${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}-${t.getFullYear()} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  return `${take.track}${when}`;
}

/** Save an export as a file in the browser. */
export function downloadTake(t: TakeExport, doc: Document = document): void {
  const url = URL.createObjectURL(new Blob([t.json], { type: 'application/json' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = t.filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type EventDescription = {
  /** What it was: "Scene Sparse", "Busy" (a bar fill), "Busy beat", "Rise to Drop", "Fill into Drop", "Repeat 1/8". */
  label: string;
  /** Where: "Bar 9.1 · pass 2"; "Bar 9.2.3" off a beat; "· off grid" for a Now launch. */
  position: string;
  /** How it went, short: "crash", "4-bar phrase · cut short", "2 bars · landed", "held 6 steps". */
  detail: string;
};

/** Bar.beat (and .sixteenth when it is not the first), the pass, and off grid. */
export function describePosition(p: Position): string {
  const at = `Bar ${p.bar}.${p.beat}${p.sixteenth > 1 ? `.${p.sixteenth}` : ''}`;
  return [at, p.pass !== undefined ? `pass ${p.pass}` : '', p.offGrid ? 'off grid' : ''].filter(Boolean).join(' · ');
}

/** "Busy" for a bar fill, "Busy beat" for a beat fill; "Fill" or "Beat fill" with no style. */
function fillLabel(style: string | null, length: FillLength): string {
  if (!style) return length === 'beat' ? 'Beat fill' : 'Fill';
  const word = style.charAt(0).toUpperCase() + style.slice(1);
  return length === 'beat' ? `${word} beat` : word;
}

const steps = (n: number) => (n === 1 ? '1 step' : `${n} steps`);

/** A short label, position and detail for one event, for the inspector. */
export function describeEvent(e: PerformanceEvent): EventDescription {
  const position = describePosition(e);
  const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' · ');
  switch (e.kind) {
    case 'scene':
      return { label: `Scene ${e.name}`, position, detail: join(e.timing === 'now' && 'now', e.crash && 'crash') };
    case 'fillInto':
      return { label: `Fill into ${e.name}`, position, detail: join(e.length === 'beat' && 'beat fill', e.crash && 'crash') };
    case 'fill':
      return {
        label: fillLabel(e.style, e.length),
        position,
        detail: join(e.phraseBars > 0 && `${e.phraseBars}-bar phrase`, e.link === 'rise' && 'with Rise',
          e.link === 'fillInto' && 'into a scene', e.outcome === 'cutShort' ? 'cut short' : e.outcome === 'open' && 'open'),
      };
    case 'rise':
      return { label: `Rise to ${e.name}`, position, detail: join(`${e.bars} bars`, e.withFill && 'with fill', e.outcome, e.crash && 'crash') };
    case 'repeat': {
      const held = e.endOnset !== undefined && e.onset !== undefined ? e.endOnset - e.onset : undefined;
      const how = e.endedBy === 'open' ? 'held' : e.endedBy === 'take' ? 'to the end of the take'
        : e.endedBy === 'recapture' ? 'recaptured' : '';
      return { label: `Repeat 1/${e.division}`, position, detail: join(held !== undefined && e.endedBy !== 'open' && `held ${steps(held)}`, how) };
    }
  }
}

// ---- From engine events -----------------------------------------------------------

/** What one request asked for, remembered when it was sent. */
export type Asked =
  | { kind: 'scene'; requestId: number; target: string; timing: Timing }
  | { kind: 'fillInto'; requestId: number; target: string; fillId: number }
  | { kind: 'rise'; requestId: number; target: string; bars: number; fillId?: number }
  | { kind: 'fill'; requestId: number; style: string | null; length: FillLength; phrase: number; link: FillLink; partner?: number };

/** The requests the host sent, by id. Bounded: the oldest are forgotten first. */
export class RequestCatalog {
  private byId = new Map<number, Asked>();
  constructor(private readonly size = 64) {}

  remember(asked: Asked): void {
    if (this.byId.has(asked.requestId)) this.byId.delete(asked.requestId);
    this.byId.set(asked.requestId, asked);
    while (this.byId.size > this.size) this.byId.delete(this.byId.keys().next().value!);
  }

  find(id: number): Asked | null {
    return this.byId.get(id) ?? null;
  }
}

/** A launch as the host's request book holds it (`SceneRequest` in scenes.ts), as much as this needs. */
type BookRequest = {
  requestId: number;
  target: string;
  timing: Timing;
  build?: { bars: number; fill?: { fillId: number } };
  fillInto?: { fillId: number };
};

/** Remember the launches a request book holds: call it whenever the book changes. */
export function rememberBook(catalog: RequestCatalog, book: { pending: readonly BookRequest[]; shown: BookRequest | null }): void {
  for (const r of book.shown ? [...book.pending, book.shown] : book.pending) {
    if (r.build) {
      catalog.remember({ kind: 'rise', requestId: r.requestId, target: r.target, bars: r.build.bars,
        ...(r.build.fill ? { fillId: r.build.fill.fillId } : {}) });
    } else if (r.fillInto) {
      catalog.remember({ kind: 'fillInto', requestId: r.requestId, target: r.target, fillId: r.fillInto.fillId });
    } else {
      catalog.remember({ kind: 'scene', requestId: r.requestId, target: r.target, timing: r.timing });
    }
  }
}

/**
 * Remember a fill as first sent (`FillJob` in fills.ts): its style, length, phrase and
 * link. The job's `length` is already the effective one (absent: the bar), and a fill
 * keeps the length it was sent with, so it is the length that plays.
 */
export function rememberFill(
  catalog: RequestCatalog,
  f: { requestId: number; kind: 'plain' | 'into' | 'rise'; phrase: number; style?: string; length?: FillLength; partner?: number },
): void {
  if (catalog.find(f.requestId)) return;
  catalog.remember({ kind: 'fill', requestId: f.requestId, style: f.style ?? null, length: f.length === 'beat' ? 'beat' : 'bar', phrase: f.phrase,
    link: f.kind === 'into' ? 'fillInto' : f.kind === 'rise' ? 'rise' : 'none', ...(f.partner !== undefined ? { partner: f.partner } : {}) });
}

/** The engine event kinds this reads (`EVENT` in scenes.ts, docs/NIGHT3_PROTOCOL.md; 61 and 62: Night 11). */
const K = {
  sceneQueued: 1, sceneApplied: 2, sceneCancelled: 3, sceneReplaced: 4, sceneRejected: 5,
  fillQueued: 11, fillStarted: 12, fillEnded: 13, fillCancelled: 14, fillRejected: 15,
  buildQueued: 41, buildApplied: 42, buildCancelled: 43, buildReplaced: 44, buildRejected: 45, buildStarted: 46,
  fillUnlinked: 52, accentFired: 53,
  repeatStarted: 61, repeatEnded: 62,
} as const;

/** A scene slot, not Compare A/B or a restore: only those are performance. */
const SLOT = /^(full|sparse|build|drop)$/;

const DIVISIONS: readonly number[] = [4, 8, 16];

/**
 * One engine event as a session input, or null when it is not about a performance
 * request (patterns, progress, Compare, restores, an unknown id). `s` is the engine's
 * onset serial on the event, carried through as `serial`.
 * `nameOf` gives the slot's name as shown; `transportStep` places an off-grid apply.
 */
export function fromEngine(
  e: { kind: number; requestId: number; a: number; b: number; s?: number },
  catalog: RequestCatalog,
  nameOf: (slot: string) => string,
  transportStep: number,
): PerformanceInput | null {
  const input = readEngine(e, catalog, nameOf, transportStep);
  return input && isSerial(e.s) ? { ...input, serial: e.s } : input;
}

function readEngine(
  e: { kind: number; requestId: number; a: number; b: number },
  catalog: RequestCatalog,
  nameOf: (slot: string) => string,
  transportStep: number,
): PerformanceInput | null {
  // Beat Repeat: the id is a gesture token, not a request, so no catalog.
  if (e.kind === K.repeatStarted) {
    const division = DIVISIONS.includes(e.b) ? e.b : 8;
    return { status: 'applied', kind: 'repeat', requestId: e.requestId, step: e.a, transportStep, payload: { division } };
  }
  if (e.kind === K.repeatEnded) return { status: 'ended', kind: 'repeat', requestId: e.requestId, step: e.a, reason: e.b };
  const asked = catalog.find(e.requestId);
  if (!asked) return null;
  if (asked.kind !== 'fill' && !SLOT.test(asked.target)) return null;
  const id = e.requestId;
  const kind = asked.kind;
  switch (e.kind) {
    case K.sceneQueued:
    case K.fillQueued:
    case K.buildQueued:
      return { status: 'queued', kind, requestId: id, step: e.b };
    case K.sceneCancelled:
    case K.fillCancelled:
      return { status: 'canceled', kind, requestId: id, reason: e.a };
    case K.sceneRejected:
    case K.fillRejected:
    case K.buildRejected:
      return { status: 'rejected', kind, requestId: id, reason: e.a };
    case K.sceneReplaced:
      return { status: 'replaced', kind, requestId: id };
    case K.sceneApplied:
      if (asked.kind === 'scene') {
        return { status: 'applied', kind, requestId: id, step: e.a, transportStep,
          payload: { slot: asked.target, name: nameOf(asked.target), timing: asked.timing } };
      }
      if (asked.kind === 'fillInto') {
        const itsFill = catalog.find(asked.fillId);
        const length = itsFill?.kind === 'fill' && itsFill.length === 'beat' ? 'beat' : 'bar';
        return { status: 'applied', kind, requestId: id, step: e.a, transportStep,
          payload: { slot: asked.target, name: nameOf(asked.target), fillRequestId: asked.fillId, length } };
      }
      return null;
    case K.fillStarted:
      if (asked.kind !== 'fill') return null;
      return { status: 'applied', kind, requestId: id, step: e.a, transportStep,
        payload: { style: asked.style, length: asked.length === 'beat' ? 'beat' : 'bar', phraseBars: asked.phrase, link: asked.link, ...(asked.partner !== undefined ? { partner: asked.partner } : {}) } };
    case K.fillEnded:
      return e.a >= 0
        ? { status: 'ended', kind, requestId: id, step: e.a, outcome: 'played' }
        : { status: 'ended', kind, requestId: id, step: -1, outcome: 'cutShort', reason: e.b };
    case K.fillUnlinked:
      return { status: 'unlinked', kind, requestId: id, reason: e.a };
    case K.buildStarted:
      if (asked.kind !== 'rise') return null;
      return { status: 'applied', kind, requestId: id, step: e.a, transportStep,
        payload: { slot: asked.target, name: nameOf(asked.target), bars: e.b || asked.bars, withFill: asked.fillId !== undefined,
          ...(asked.fillId !== undefined ? { fillRequestId: asked.fillId } : {}) } };
    case K.buildApplied:
      // The Rise reached its scene: `b` only says whether a separate landing vector was
      // committed too (engine-core/src/build.rs), which the host's Rise need not send.
      return { status: 'ended', kind, requestId: id, step: e.a, outcome: 'landed' };
    case K.buildCancelled:
      // Before it started this is a plain cancel; after, it also closes the Rise.
      return { status: 'canceled', kind, requestId: id, outcome: 'cancelled', reason: e.a };
    case K.buildReplaced:
      return { status: 'replaced', kind, requestId: id, outcome: 'replaced' };
    case K.accentFired:
      return { status: 'crash', kind, requestId: id, step: e.a };
    default:
      return null;
  }
}
