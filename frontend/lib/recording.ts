/**
 * Performance recording, v1 (docs/PERFORMANCE_EVENTS.md, contracts/performance.json).
 *
 * An in-memory take of what the performer actually did: the scenes, fills, Rises and
 * Fill intos the engine applied, each at the engine step it applied on. Queued,
 * canceled, rejected and replaced requests never enter the take; they go to the
 * developer log only, tagged with their status, so the difference can be seen.
 *
 * Pure: no React, no engine, no clock. The host feeds it engine events (`fromEngine`)
 * and what each request asked for (`RequestCatalog`); a test can feed it by hand.
 * Musical positions come from engine steps only, never `performance.now()`.
 */

export const PERFORMANCE_FORMAT = 'bckgrnd-msc/performance';
export const PERFORMANCE_VERSION = 1;
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

// ---- The take -------------------------------------------------------------------

/** Kinds captured in v1. `repeat`, `filter`, `echo` and `gesture` are reserved. */
export type RecordedKind = 'scene' | 'fill' | 'rise' | 'fillInto';
export const RESERVED_KINDS = ['repeat', 'filter', 'echo', 'gesture'] as const;

export type Timing = 'now' | 'beat' | 'bar';
export type FillLink = 'none' | 'fillInto' | 'rise';

type Common = Position & {
  /** 1, 2, 3... in the order applied. Ties on a step keep the engine's order. */
  seq: number;
  /** The host's request id: session-local, links a fill to its Rise or Fill into. */
  requestId: number;
};

export type SceneRecord = Common & {
  kind: 'scene';
  slot: string;
  name: string;
  timing: Timing;
  /** The crash accent fired with it. */
  crash: boolean;
};

export type FillRecord = Common & {
  kind: 'fill';
  style: string | null;
  /** 0: the next bar; 2, 4, 8 or 16: the phrase it ended. */
  phraseBars: number;
  link: FillLink;
  /** The request it led into (the Fill into's scene, or the Rise), if linked. */
  partner?: number;
  /** `played`: ran its bar; `cutShort`: stopped early; `open`: still playing when the take stopped. */
  outcome: 'played' | 'cutShort' | 'open';
  /** The step the track's drums resumed on (`played` only). */
  endStep?: number;
  /** `ENGINE_REASON` it was cut short for. */
  reason?: number;
};

export type RiseRecord = Common & {
  kind: 'rise';
  /** The landing scene. */
  slot: string;
  name: string;
  bars: number;
  withFill: boolean;
  /** The fill's request id, for Rise + Fill. */
  fillRequestId?: number;
  /**
   * `landed`: the scene landed; `ended`: the Rise ended without landing it;
   * `cancelled`/`replaced`: stopped mid-rise; `open`: still rising when the take stopped.
   * The start was applied either way: what was heard is part of the take.
   */
  outcome: 'landed' | 'ended' | 'cancelled' | 'replaced' | 'open';
  endStep?: number;
  reason?: number;
  crash: boolean;
};

export type FillIntoRecord = Common & {
  kind: 'fillInto';
  /** The scene it landed. */
  slot: string;
  name: string;
  fillRequestId: number;
  crash: boolean;
};

export type PerformanceEvent = SceneRecord | FillRecord | RiseRecord | FillIntoRecord;

export type StopReason = 'user' | 'stop' | 'panic' | 'track' | 'mix' | 'cap';

export type PerformanceRecording = {
  format: typeof PERFORMANCE_FORMAT;
  version: typeof PERFORMANCE_VERSION;
  track: string;
  bpm: number;
  stepsPerBar: typeof STEPS_PER_BAR;
  /** The song step sounding when Record was pressed; -1 if the transport was stopped. */
  startedAtStep: number;
  /** Why the take ended; null while it is still recording. */
  stoppedBy: StopReason | null;
  /** True if the cap stopped it. */
  truncated: boolean;
  events: PerformanceEvent[];
};

// ---- Inputs and the developer log ----------------------------------------------

export type InputStatus = 'queued' | 'canceled' | 'rejected' | 'replaced' | 'applied' | 'ended' | 'unlinked' | 'crash';

/** What the session is told. Only `applied` can add an event; `ended`, `unlinked` and `crash` amend one. */
export type PerformanceInput = {
  status: InputStatus;
  kind: RecordedKind;
  requestId: number;
  /** The engine's step (-1 for none). */
  step?: number;
  /** The transport's step from telemetry, to place an off-grid apply. */
  transportStep?: number;
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
  requestId: number;
  step: number;
  /** In the take: true only for an applied event that was recorded. */
  recorded: boolean;
  detail: string;
};

export type RecordingState = 'idle' | 'recording' | 'stopped';

/** The in-memory recording session: Start, Stop, Clear, and what was applied. */
export class RecordingSession {
  state: RecordingState = 'idle';
  private take: PerformanceRecording | null = null;
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start a new take. A take already recording, or a stopped one, is replaced. */
  start(track: string, bpm: number, transportStep: number): void {
    const startedAtStep = Number.isInteger(transportStep) && transportStep >= 0 ? transportStep % SONG_STEPS : -1;
    this.take = {
      format: PERFORMANCE_FORMAT,
      version: PERFORMANCE_VERSION,
      track,
      bpm,
      stepsPerBar: STEPS_PER_BAR,
      startedAtStep,
      stoppedBy: null,
      truncated: false,
      events: [],
    };
    this.state = 'recording';
    this.note('session', startedAtStep, `start ${track} at ${bpm} BPM`);
  }

  /** End the take, keeping it. Nothing is added after this. */
  stop(reason: StopReason = 'user'): void {
    if (this.state !== 'recording' || !this.take) return;
    this.take.stoppedBy = reason;
    if (reason === 'cap') this.take.truncated = true;
    this.state = 'stopped';
    this.note('session', -1, `stop: ${reason}`);
  }

  /** Drop the take. The developer log stays, so the clear itself can be seen. */
  clear(): void {
    this.take = null;
    this.state = 'idle';
    this.note('session', -1, 'clear');
  }

  /**
   * Something outside the take moved the transport. Stop, Panic, a track load and an
   * auto-mix end the take (positions start over or the track changes); a cue or a seek
   * keeps it, because song positions are already absolute within the song.
   */
  interrupt(what: 'stop' | 'panic' | 'track' | 'mix' | 'cue' | 'seek'): void {
    if (this.state !== 'recording') return;
    if (what === 'cue' || what === 'seek') {
      this.note('session', -1, `${what}: still recording`);
      return;
    }
    this.stop(what);
  }

  /** Tell the session one thing that happened. Every input is logged; only applied ones are kept. */
  record(input: PerformanceInput): void {
    const step = input.step ?? -1;
    const recording = this.state === 'recording' && this.take !== null;
    if (input.status === 'applied') {
      if (!recording) return this.logInput(input, step, false, 'not recording');
      if (this.take!.events.length >= this.cap) {
        this.logInput(input, step, false, `dropped: cap of ${this.cap} events`);
        this.stop('cap');
        return;
      }
      const at = positionOf(step, input.transportStep);
      const event = {
        seq: this.take!.events.length + 1,
        kind: input.kind,
        requestId: input.requestId,
        ...at,
        ...defaults(input.kind),
        ...(input.payload ?? {}),
      } as PerformanceEvent;
      this.take!.events.push(event);
      return this.logInput(input, at.step, true, at.offGrid ? 'off grid' : '');
    }
    const amends = input.status === 'ended' || input.status === 'unlinked' || input.status === 'crash' || input.outcome !== undefined;
    if (amends) {
      const target = recording ? this.find(input.kind, input.requestId) : null;
      if (target) amend(target, input);
      const why = input.reason !== undefined ? `reason ${input.reason}` : '';
      return this.logInput(input, step, false, [why, target ? `amends #${target.seq}` : ''].filter(Boolean).join('; '));
    }
    this.logInput(input, step, false, input.reason !== undefined ? `reason ${input.reason}` : '');
  }

  private find(kind: RecordedKind, requestId: number): PerformanceEvent | null {
    const events = this.take?.events ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.requestId === requestId && e.kind === kind) return e;
    }
    return null;
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
    case 'fillInto':
      return { crash: false };
    case 'fill':
      return { link: 'none', outcome: 'open' };
    case 'rise':
      return { withFill: false, outcome: 'open', crash: false };
  }
}

function amend(e: PerformanceEvent, input: PerformanceInput) {
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
  // `ended` (or a Rise's cancel or replace): a fill's or a Rise's outcome, once.
  if ((e.kind === 'fill' || e.kind === 'rise') && e.outcome === 'open') {
    e.outcome = input.outcome as never;
    if (input.step !== undefined && input.step >= 0) e.endStep = input.step;
    if (input.reason !== undefined) e.reason = input.reason;
  }
}

// ---- From engine events -----------------------------------------------------------

/** What one request asked for, remembered when it was sent. */
export type Asked =
  | { kind: 'scene'; requestId: number; target: string; timing: Timing }
  | { kind: 'fillInto'; requestId: number; target: string; fillId: number }
  | { kind: 'rise'; requestId: number; target: string; bars: number; fillId?: number }
  | { kind: 'fill'; requestId: number; style: string | null; phrase: number; link: FillLink; partner?: number };

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

/** Remember a fill as first sent (`FillJob` in fills.ts): its style, phrase and link. */
export function rememberFill(
  catalog: RequestCatalog,
  f: { requestId: number; kind: 'plain' | 'into' | 'rise'; phrase: number; style?: string; partner?: number },
): void {
  if (catalog.find(f.requestId)) return;
  catalog.remember({ kind: 'fill', requestId: f.requestId, style: f.style ?? null, phrase: f.phrase,
    link: f.kind === 'into' ? 'fillInto' : f.kind === 'rise' ? 'rise' : 'none', ...(f.partner !== undefined ? { partner: f.partner } : {}) });
}

/** The engine event kinds this reads (`EVENT` in scenes.ts, docs/NIGHT3_PROTOCOL.md). */
const K = {
  sceneQueued: 1, sceneApplied: 2, sceneCancelled: 3, sceneReplaced: 4, sceneRejected: 5,
  fillQueued: 11, fillStarted: 12, fillEnded: 13, fillCancelled: 14, fillRejected: 15,
  buildQueued: 41, buildApplied: 42, buildCancelled: 43, buildReplaced: 44, buildRejected: 45, buildStarted: 46,
  fillUnlinked: 52, accentFired: 53,
} as const;

/** A scene slot, not Compare A/B or a restore: only those are performance. */
const SLOT = /^(full|sparse|build|drop)$/;

/**
 * One engine event as a session input, or null when it is not about a performance
 * request (patterns, gestures, progress, Compare, restores, an unknown id).
 * `nameOf` gives the slot's name as shown; `transportStep` places an off-grid apply.
 */
export function fromEngine(
  e: { kind: number; requestId: number; a: number; b: number },
  catalog: RequestCatalog,
  nameOf: (slot: string) => string,
  transportStep: number,
): PerformanceInput | null {
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
        return { status: 'applied', kind, requestId: id, step: e.a, transportStep,
          payload: { slot: asked.target, name: nameOf(asked.target), fillRequestId: asked.fillId } };
      }
      return null;
    case K.fillStarted:
      if (asked.kind !== 'fill') return null;
      return { status: 'applied', kind, requestId: id, step: e.a, transportStep,
        payload: { style: asked.style, phraseBars: asked.phrase, link: asked.link, ...(asked.partner !== undefined ? { partner: asked.partner } : {}) } };
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
      return { status: 'ended', kind, requestId: id, step: e.a, outcome: e.b === 1 ? 'landed' : 'ended' };
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
