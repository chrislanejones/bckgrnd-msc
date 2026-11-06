import { verifyEngine } from './build-identity';
/**
 * Main-thread host for the Rust/WASM engine.
 *
 * The engine itself lives on the audio thread inside an `AudioWorkletProcessor`.
 * This module owns the `AudioContext`, loads the worklet module, fetches the wasm
 * binary, and translates the app's intent into the small message protocol the
 * processor understands.
 *
 * Two engines live inside the processor — deck A is live, deck B holds the cued
 * track — so a beat-matched auto-mix is a crossfade on the audio thread rather than
 * two `AudioContext`s fighting each other.
 */

import { usingStaticLibrary } from './api';
import type { TrackArrangement } from './types';

export type Deck = 'a' | 'b';

export type Telemetry = {
  /** Post-fader level per stem, 0..1, in stem order. */
  levels: Float32Array;
  /** Step index currently sounding, or -1 when stopped. */
  step: number;
  playing: boolean;
  /** Which deck is live. */
  deck: Deck;
  /** True while an auto-mix is crossfading. */
  mixing: boolean;
  /** Master output peak per channel since the last frame, linear (1 is full scale). */
  peak: [number, number];
  /** Some output sample since the last frame went past full scale. */
  clipped: boolean;
};

/** When a queued scene applies (docs/NIGHT3_PROTOCOL.md, Timing). */
export const SCENE_TIMING = { now: 0, beat: 1, bar: 2 } as const;
export type SceneTiming = (typeof SCENE_TIMING)[keyof typeof SCENE_TIMING];

/** Length of the engine's scene vector: 8 stems x 4 fields, then 12 effects. */
export const SCENE_VECTOR_LENGTH = 44;

/** Engine event kinds, the first number of each event. */
export const ENGINE_EVENT = {
  sceneQueued: 1,
  sceneApplied: 2,
  sceneCancelled: 3,
  sceneReplaced: 4,
  sceneRejected: 5,
  fillQueued: 11,
  fillStarted: 12,
  fillEnded: 13,
  fillCancelled: 14,
  fillRejected: 15,
  gestureExpired: 21,
} as const;

/** Why a request was cancelled or rejected. */
export const ENGINE_REASON = {
  invalid: 1,
  stopped: 2,
  transport: 3,
  track: 4,
  panic: 5,
  mixing: 6,
  notPlaying: 7,
  alreadyPlaying: 8,
  staleGeneration: 9,
  cancelledByUser: 10,
} as const;

/** Held-gesture kinds (docs/NIGHT3_PROTOCOL.md, Gestures). */
export const GESTURE_KIND = { echoThrow: 1, filterHold: 2 } as const;
export type GestureKind = (typeof GESTURE_KIND)[keyof typeof GESTURE_KIND];

/**
 * One outcome from the audio thread. What `a` and `b` mean depends on `kind`;
 * `requestId` is the gesture's token for `gestureExpired`:
 *
 * | kind | a | b |
 * |---|---|---|
 * | sceneQueued, fillQueued | predicted bar (1-based) | predicted step |
 * | sceneApplied | step it applied on (-1 for Now / stopped) | 0 |
 * | sceneCancelled, sceneRejected, fillCancelled, fillRejected | reason (`ENGINE_REASON`) | 0 |
 * | sceneReplaced | request id that replaced it | 0 |
 * | fillStarted | step | 0 |
 * | fillEnded | step the track's drums resume on (-1 when cut short) | 0, or the reason it was cut short |
 * | gestureExpired | gesture kind (`GESTURE_KIND`) | 0 |
 */
export type EngineEvent = {
  deck: Deck;
  kind: number;
  requestId: number;
  a: number;
  b: number;
};

type WorkletMessage =
  | { type: 'telemetry'; frame: Float32Array }
  | { type: 'mixEnd'; deck: Deck }
  | { type: 'error'; command: string; message: string }
  | { type: 'sceneEvents'; deck: Deck; events: number[] }
  | { type: 'sceneCancelResult'; deck: Deck; requestId: number; cancelled: boolean }
  | { type: 'fillCancelResult'; deck: Deck; requestId: number; cancelled: boolean }
  | { type: 'patternsCancelResult'; deck: Deck; requestId: number; cancelled: boolean }
  | { type: 'gestureBeginResult'; deck: Deck; token: number; accepted: boolean };

type Listener = (telemetry: Telemetry) => void;
type ErrorListener = (message: string) => void;
type SceneEventListener = (events: readonly EngineEvent[]) => void;

// Stamped with the build, because the file names never change and a browser that
// had cached the old engine kept playing it after a rebuild.
const WASM_URL = `/wasm/bckgrnd_msc_engine_bg.wasm?v=${__BUILD_ID__}`;
const WORKLET_URL = `/build/engine-worklet.js?v=${__BUILD_ID__}`;

export class EngineHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<Listener>();
  private errorListeners = new Set<ErrorListener>();
  private sceneListeners = new Set<SceneEventListener>();
  /** `cancelScene` callers waiting on the worklet's answer, by request id. */
  private cancelWaiters = new Map<number, Array<(cancelled: boolean) => void>>();
  /** `cancelFill` callers, kept apart: scene and fill ids may coincide. */
  private fillCancelWaiters = new Map<number, Array<(cancelled: boolean) => void>>();
  private patternsCancelWaiters = new Map<number, Array<(cancelled: boolean) => void>>();
  /** `gestureBegin` callers waiting to hear whether the engine took it, by token. */
  private gestureWaiters = new Map<number, Array<(accepted: boolean) => void>>();

  /**
   * The most recent fault from the audio thread, if any.
   *
   * A throw inside `process()` is swallowed by the browser and the worklet's console
   * is unreachable from the page, so without this the only symptom of an engine fault
   * is silence. Kept as state as well as an event so a late subscriber — or a
   * component that mounted after the fault — can still show it.
   */
  private lastError: string | null = null;

  /** Latest telemetry, kept so a new subscriber is not left blank. */
  private telemetry: Telemetry = {
    levels: new Float32Array(8),
    step: -1,
    playing: false,
    deck: 'a',
    mixing: false,
    peak: [0, 0],
    clipped: false,
  };

  private bootPromise: Promise<void> | null = null;

  private mixEndHandler: (() => void) | null = null;

  /**
   * Boot the audio graph. Safe to call repeatedly; the work is done once.
   *
   * Must be called from a user gesture — an `AudioContext` created outside one
   * starts suspended, and a suspended context cannot run the processor.
   */
  async boot(): Promise<void> {
    this.bootPromise ??= this.create().catch(async (error) => { await this.close(); throw error; });
    return this.bootPromise;
  }

  private async create(): Promise<void> {
    // `AudioWorklet` is secure-context-only, and it is undefined — not merely
    // non-functional — over plain http on anything other than localhost. The page still
    // renders in that state, because the track library is just JSON, so the symptom is
    // "the UI works but there is no sound" with a TypeError from deep in here. Fail
    // with the actual cause and the way out instead.
    if (typeof AudioWorklet === 'undefined') {
      throw new Error(
        location.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(location.hostname)
          ? `AudioWorklet needs a secure context, and http://${location.hostname} is not one. ` +
              `Open http://localhost:${location.port} instead, or serve the app over HTTPS.`
          : 'This browser does not support AudioWorklet, which the audio engine requires.',
      );
    }

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    ctx.onstatechange = () => {
      if (ctx.state !== 'running' && this.telemetry.playing) {
        this.lastError = 'Audio is interrupted. Check the output device, then Resume Audio.';
        for (const listener of this.errorListeners) listener(this.lastError);
      }
    };

    // `fetch` exists here even though it does not in the worklet, so the binary is
    // pulled down on this thread and handed over as bytes.
    const response = await fetch(WASM_URL);
    if (!response.ok) {
      throw new Error(`could not load the audio engine: ${response.status} ${WASM_URL}`);
    }
    const wasm = await response.arrayBuffer();
    const manifest = await verifyEngine(wasm);
    const worklet = await fetch(WORKLET_URL);
    if (!worklet.ok) throw new Error('Worklet asset missing. Reload the complete app build.');
    const digest = await crypto.subtle.digest('SHA-256', await worklet.arrayBuffer());
    if ([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') !== manifest.worklet) throw new Error('Worklet does not match this build. Reload the complete app.');
    await ctx.audioWorklet.addModule(WORKLET_URL);

    const node = new AudioWorkletNode(ctx, 'bckgrnd-msc-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.onMessage(event.data);
    node.connect(ctx.destination);
    this.node = node;

    // The processor needs the context's real rate, which it also knows as a global;
    // passing it explicitly keeps the two from disagreeing after a device change.
    // `send`, not `post`: `post` flushes the coalesced parameters first, which would
    // put every value moved before the first Play (and a pattern edit made then)
    // ahead of `init` and the track loads, where the worklet drops or refuses them.
    this.send({ type: 'init', wasm, sampleRate: ctx.sampleRate }, [wasm]);

    // Then everything the app said before there was anything to say it to, in order,
    // and only after that the latest value of every parameter moved since: a replayed
    // `track` load resets the faders, sends and tempo, so parameters sent first would
    // be overwritten by it. `send`, not `post`, so nothing is flushed in between.
    const queued = this.pending;
    this.pending = [];
    for (const item of queued) this.send(item.message, item.transfer);
    this.flushParams();
  }

  /**
   * Whether the worklet exists. Until the first Play there is none, so requests that
   * wait on an answer from the audio thread (a scene's `applied`) would sit in the
   * pre-boot queue; the UI applies those through the plain setters instead.
   */
  get booted(): boolean {
    return this.node !== null;
  }

  private onMessage(message: WorkletMessage): void {
    if (message.type === 'error') {
      this.lastError = `${message.command}: ${message.message}`;
      for (const listener of this.errorListeners) listener(this.lastError);
      return;
    }
    if (message.type === 'telemetry') {
      const f = message.frame;
      this.telemetry = {
        levels: f.slice(0, 8),
        step: f[8],
        playing: f[9] === 1,
        deck: f[10] === 0 ? 'a' : 'b',
        mixing: f[11] === 1,
        peak: [f[12] ?? 0, f[13] ?? 0],
        clipped: f[14] === 1,
      };
      for (const listener of this.listeners) listener(this.telemetry);
      return;
    }
    if (message.type === 'mixEnd') {
      this.mixEndHandler?.();
      return;
    }
    if (message.type === 'sceneEvents') {
      const raw = message.events;
      const events: EngineEvent[] = [];
      for (let k = 0; k + 3 < raw.length; k += 4) {
        events.push({
          deck: message.deck,
          kind: raw[k],
          requestId: raw[k + 1],
          a: raw[k + 2],
          b: raw[k + 3],
        });
      }
      if (events.length > 0) for (const listener of this.sceneListeners) listener(events);
      return;
    }
    if (message.type === 'sceneCancelResult') {
      settle(this.cancelWaiters, message.requestId, message.cancelled);
      return;
    }
    if (message.type === 'fillCancelResult') {
      settle(this.fillCancelWaiters, message.requestId, message.cancelled);
      return;
    }
    if (message.type === 'patternsCancelResult') {
      settle(this.patternsCancelWaiters, message.requestId, message.cancelled);
      return;
    }
    if (message.type === 'gestureBeginResult') {
      settle(this.gestureWaiters, message.token, message.accepted);
    }
  }

  /**
   * Messages sent before the worklet existed, replayed once it does.
   *
   * `boot()` needs a user gesture, but the app loads the opening track as soon as the
   * library arrives — well before anyone has clicked. Those posts used to go to
   * `this.node?`, which is null until boot, so they were dropped on the floor without
   * a word: deck A came up with no track loaded, play produced silence, and the app
   * only made a sound once you picked a *second* track, by which point booting had
   * happened and the load actually landed.
   */
  private pending: Array<{ message: unknown; transfer: Transferable[] }> = [];

  /**
   * Parameter changes waiting for the next frame, keyed by parameter. Of several
   * changes to one parameter within a frame only the last is sent: a fast drag or a
   * held arrow key produces far more values than the audio thread can use, and every
   * message is work in the worklet's message handler.
   */
  private queued = new Map<string, Record<string, unknown>>();
  private flushScheduled = false;

  /** The last message actually sent for each parameter, for diagnostics and tests. */
  private sent: Record<string, unknown> = {};

  private postParam(key: string, message: Record<string, unknown>): void {
    this.queued.set(key, message);
    if (this.flushScheduled || !this.node) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      this.flushParams();
    };
    // A frame, while the page is visible; a timer when it is hidden, where frames stop.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 16);
    }
  }

  private flushParams(): void {
    if (this.queued.size === 0) return;
    const messages = [...this.queued.entries()];
    this.queued.clear();
    for (const [key, message] of messages) {
      this.sent[key] = message;
      this.send(message, []);
    }
  }

  /** The last message sent for each parameter, after coalescing. */
  get lastSent(): Readonly<Record<string, unknown>> {
    return this.sent;
  }

  private post(message: unknown, transfer: Transferable[] = []): void {
    // Anything not coalesced goes after every parameter change made before it, so
    // order is kept: a fader moved and then a mix started arrive in that order.
    this.flushParams();
    this.send(message, transfer);
  }

  private send(message: unknown, transfer: Transferable[]): void {
    const node = this.node;
    if (!node) {
      // Bounded, so a page that never gets its gesture cannot grow this without end.
      // Far more than the handful of messages a cold start actually queues.
      if (this.pending.length < 256) this.pending.push({ message, transfer });
      return;
    }
    node.port.postMessage(message, transfer);
  }

  /**
   * Everything needed to work out why there is no sound.
   *
   * The browser test suite taps the worklet with an `AnalyserNode` and connects the node
   * to a muted sink, because a headless environment has no output device. That proves the
   * engine emits correct samples; it proves nothing about whether those samples reach a
   * speaker. This report separates "the engine is not running" from "the engine is
   * running and the signal is going somewhere else".
   */
  private async buildDiagnostic(): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    secureContext: typeof isSecureContext !== 'undefined' ? isSecureContext : null,
    hasAudioWorkletApi: typeof AudioWorklet !== 'undefined',
    staticBuild: usingStaticLibrary(),
    booted: this.node !== null,
  };

  // A throwaway context reports what the browser will actually hand out.
  try {
    const probe = new AudioContext();
    report.contextState = probe.state;
    report.sampleRate = probe.sampleRate;
    report.baseLatency = probe.baseLatency;
    report.outputLatency = probe.outputLatency;
    report.audioWorkletAvailable = Boolean(probe.audioWorklet);
    // An AudioContext created without a user gesture lands suspended, which is the
    // single most common cause of "it works in tests but I hear nothing".
    report.resumeWithoutGesture = await (async () => {
      try {
        if (probe.state === 'suspended') await probe.resume();
        return probe.state;
      } catch (e) {
        return `refused: ${(e as Error).message}`;
      }
    })();
    await probe.close();
  } catch (e) {
    report.contextError = (e as Error).message;
  }

  try {
    await this.boot();
    report.bootedAfterProbe = true;
    report.ctxState = this.ctx?.state ?? null;
    report.ctxRate = this.ctx?.sampleRate ?? null;
  } catch (e) {
    report.bootError = (e as Error).message;
  }

  const t = this.current;
  report.playing = t.playing;
  report.step = t.step;
  report.meters = Array.from(t.levels).map((v) => +v.toFixed(4));
  report.lastError = this.lastError;

  return report;
}

/** Subscribe to meter/playhead updates. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.telemetry);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to audio-thread faults. Returns an unsubscribe function. */
  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    if (this.lastError) listener(this.lastError);
    return () => this.errorListeners.delete(listener);
  }

  get error(): string | null {
    return this.lastError;
  }

  clearError(): void {
    this.lastError = null;
  }

  get current(): Telemetry {
    return this.telemetry;
  }

  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') throw new Error('The audio device closed. Save the project and reload to reconnect it.');
    if (ctx.state !== 'running') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([ctx.resume(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Audio could not resume. Check the output device and try Resume Audio.')), 4000); })]); }
      finally { clearTimeout(timer); }
    }
    if (ctx.state !== 'running') throw new Error('Audio remains suspended. Check the output device and try Resume Audio.');
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  async close(): Promise<void> {
    for (const map of [this.cancelWaiters, this.fillCancelWaiters, this.patternsCancelWaiters, this.gestureWaiters]) {
      for (const waiting of map.values()) for (const resolve of waiting) resolve(false);
      map.clear();
    }
    this.node?.disconnect();
    this.node = null;
    if (this.ctx) this.ctx.onstatechange = null;
    if (this.ctx?.state !== 'closed') await this.ctx?.close();
    this.ctx = null;
    this.bootPromise = null;
  }

  // -- Transport ------------------------------------------------------------

  async play(deck: Deck = 'a'): Promise<void> {
    await this.boot();
    await this.resume();
    this.post({ type: 'transport', deck, action: 'play' });
  }

  stop(deck: Deck = 'a'): void {
    this.post({ type: 'transport', deck, action: 'stop' });
  }

  // -- Track ----------------------------------------------------------------

  /**
   * Load an arranged track into a deck. The idle deck should stay silent.
   *
   * `generation` is the UI's counter for that deck's loaded track. Scene requests
   * carry the generation they were made for, and the worklet refuses one whose deck
   * has since loaded something else. Left out, the deck keeps its previous number.
   */
  loadTrack(deck: Deck, arrangement: TrackArrangement, generation?: number): void {
    this.post({
      type: 'track',
      deck,
      json: JSON.stringify(arrangement),
      ...(generation === undefined ? {} : { generation }),
    });
  }

  /**
   * Begin a beat-matched crossfade from the live deck to `deck`.
   *
   * `onEnd` fires once the handover completes, at which point `deck` is live.
   */
  mix(
    deck: Deck,
    arrangement: TrackArrangement,
    bpm: number,
    swing: number,
    onEnd: () => void,
    generation?: number,
  ): void {
    this.mixEndHandler = onEnd;
    this.post({
      type: 'mix',
      deck,
      bpm,
      swing,
      json: JSON.stringify(arrangement),
      ...(generation === undefined ? {} : { generation }),
    });
  }

  // -- Scenes ---------------------------------------------------------------

  /**
   * Ask the live deck to apply a scene (docs/NIGHT3_PROTOCOL.md).
   *
   * `values` is the 44-value scene vector, copied here, so changing the source after
   * the call changes nothing. `generation` is the live deck's track generation as
   * the UI knows it. The outcome arrives through `onSceneEvents`: `queued` (with the
   * bar), then `applied`, or `rejected`, `cancelled` or `replaced`. Only `applied`
   * means the scene is now the mix.
   */
  queueScene(
    requestId: number,
    timing: SceneTiming,
    values: ArrayLike<number>,
    generation: number,
    patterns?: { requestId: number; data: Float32Array },
  ): void {
    this.post({
      type: 'scene',
      requestId,
      generation,
      timing,
      values: Array.from(values),
      ...(patterns ? { patterns: patterns.data, patternsId: patterns.requestId } : {}),
    });
  }

  // -- Patterns (docs/NIGHT4_PROTOCOL.md) ----------------------------------

  /**
   * Stage a pattern revision on the live deck. `data` is the compiled payload
   * (`compileLanes`), holding every lane the revision sets. Coalesced like a
   * parameter: of several revisions posted before the next frame (or before the
   * engine has booted) only the latest is sent, which is what "latest wins" means
   * anyway. Outcomes arrive through `onSceneEvents` as kinds 31-35.
   */
  queuePatterns(requestId: number, timing: SceneTiming, data: Float32Array, generation: number): void {
    this.postParam('patterns', { type: 'patterns', requestId, generation, timing, data });
  }

  /** Withdraw a pending revision. Resolves true when it was still pending. */
  cancelPatterns(requestId: number): Promise<boolean> {
    return this.ask(this.patternsCancelWaiters, requestId, { type: 'cancelPatterns', requestId });
  }

  /**
   * Withdraw a queued scene. Resolves true when it was still pending (a `cancelled`
   * event follows), false when it was not: already applied, replaced, or unknown.
   */
  cancelScene(requestId: number): Promise<boolean> {
    return this.ask(this.cancelWaiters, requestId, { type: 'cancelScene', requestId });
  }

  // -- Fills ----------------------------------------------------------------

  /**
   * Ask the live deck to play fill `index` of its track (0 in Night 3) from the next
   * bar line, for one bar. Outcomes arrive through `onSceneEvents`: `fillQueued`,
   * `fillStarted`, `fillEnded`, or `fillRejected` (not playing, already queued or
   * playing, mixing, stale generation, no such fill) or `fillCancelled`.
   */
  queueFill(requestId: number, index: number, generation: number): void {
    this.post({ type: 'fill', requestId, generation, index });
  }

  /**
   * Withdraw a queued fill. Resolves true when it was still waiting for its bar (a
   * `fillCancelled` event follows), false otherwise; a fill already playing runs its bar.
   */
  cancelFill(requestId: number): Promise<boolean> {
    return this.ask(this.fillCancelWaiters, requestId, { type: 'cancelFill', requestId });
  }

  // -- Gestures -------------------------------------------------------------

  /**
   * Begin a held override on the live deck under a token unique to this press.
   * Resolves false when the engine refused it (four already held, the token in use,
   * or an unknown kind). The engine drops it after 3 s of audio unless renewed, and
   * reports that as `gestureExpired`; renew while held, and end on release, blur and
   * visibility change (a suspended context renders nothing, so the lease cannot run
   * out on its own there).
   */
  gestureBegin(token: number, kind: GestureKind): Promise<boolean> {
    return this.ask(this.gestureWaiters, token, { type: 'gestureBegin', token, kind });
  }

  /** End one held override; the next held one of its kind, or the base, is heard. */
  gestureEnd(token: number): void {
    this.post({ type: 'gestureEnd', token });
  }

  /** Restart a held override's 3 s lease. */
  gestureRenew(token: number): void {
    this.post({ type: 'gestureRenew', token });
  }

  /** Release FX: end every held override and the latched echo throw; the mix is untouched. */
  releaseGestures(): void {
    this.post({ type: 'releaseGestures' });
  }

  /**
   * Panic: cancel whatever is queued, end a playing fill, release every gesture and
   * the latched echo throw, stop both decks and clear the tails. An auto-mix in
   * progress is abandoned (no `mixEnd` follows).
   */
  panic(): void {
    this.post({ type: 'panic' });
  }

  /** Post `message` and resolve with the worklet's yes/no answer for `key`. */
  private ask(
    waiters: Map<number, Array<(answer: boolean) => void>>,
    key: number,
    message: Record<string, unknown>,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const waiting = waiters.get(key) ?? [];
      waiting.push(resolve);
      waiters.set(key, waiting);
      this.post(message);
    });
  }

  /**
   * Subscribe to scene, fill and gesture outcomes from the audio thread.
   * Each call delivers the events of one render block, oldest first. Returns an
   * unsubscribe function.
   */
  onSceneEvents(listener: SceneEventListener): () => void {
    this.sceneListeners.add(listener);
    return () => this.sceneListeners.delete(listener);
  }

  /**
   * Collect the diagnostic report.
   *
   * Exposed as `window.__BCKGRND_DIAG__` by `main.tsx` so it can be run from DevTools
   * without a rebuild.
   */
  async diagnose(): Promise<Record<string, unknown>> {
    return this.buildDiagnostic();
  }

  // -- Mixer ----------------------------------------------------------------

  setVolume(index: number, value: number): void {
    this.postParam(`volume:${index}`, { type: 'volume', index, value });
  }

  /** A stem's echo send, 0..1. */
  setSend(index: number, value: number): void {
    this.postParam(`send:${index}`, { type: 'send', index, value });
  }

  setMuted(index: number, value: boolean): void {
    this.post({ type: 'mute', index, value });
  }

  setSolo(index: number, value: boolean): void {
    this.post({ type: 'solo', index, value });
  }

  setMaster(value: number): void {
    this.postParam('master', { type: 'master', value });
  }

  setBpm(value: number): void {
    this.postParam('bpm', { type: 'bpm', value });
  }

  setSwing(value: number): void {
    this.postParam('swing', { type: 'swing', value });
  }

  setBands(low: number, mid: number, high: number): void {
    this.postParam('bands', { type: 'bands', low, mid, high });
  }

  setFilter(value: number): void {
    this.postParam('filter', { type: 'filter', value });
  }

  /** The filter's resonance as it closes, a Q from 0.5 to 6. */
  setFilterQ(value: number): void {
    this.postParam('filterQ', { type: 'filterQ', value });
  }

  /** The echo's feedback, 0..0.9. */
  setEchoFeedback(value: number): void {
    this.postParam('echoFeedback', { type: 'echoFeedback', value });
  }

  /** How loud the echo returns, 0..1. */
  setEchoReturn(value: number): void {
    this.postParam('echoReturn', { type: 'echoReturn', value });
  }

  /** How much room is mixed in, 0..0.5. */
  setReverbMix(value: number): void {
    this.postParam('reverbMix', { type: 'reverbMix', value });
  }

  /** The room's decay, 0.2..2.5 s. */
  setReverbDecay(value: number): void {
    this.postParam('reverbDecay', { type: 'reverbDecay', value });
  }

  /** Stereo width: 0 mono, 1 as mixed, 1.5 wider. */
  setWidth(value: number): void {
    this.postParam('width', { type: 'width', value });
  }

  setEcho(on: boolean): void {
    this.post({ type: 'echo', on });
  }

  setStereo(mode: 0 | 1 | 2): void {
    this.post({ type: 'stereo', mode });
  }

  /** Output balance: 0 hard left (right speaker silent), 0.5 both at full, 1 hard right. */
  setStereoBalance(balance: number): void {
    this.postParam('stereoBalance', { type: 'stereoBalance', value: balance });
  }

  /** Echo time in beats: 0.25 a sixteenth, 0.75 a dotted eighth (default), 1 a quarter; 0 is off. */
  setEchoTime(beats: number): void {
    this.post({ type: 'echoTime', beats });
  }

  setLoop(bars: number): void {
    this.post({ type: 'loop', bars });
  }

  /** Jump the live deck to `bar` (0-based) and loop that bar: Hear Bar in the editor. */
  audition(bar: number): void {
    this.post({ type: 'audition', bar });
  }

  // -- Deck gestures --------------------------------------------------------

  cue(): void {
    this.post({ type: 'cue' });
  }

  brake(): void {
    this.post({ type: 'brake' });
  }

  backspin(): void {
    this.post({ type: 'backspin' });
  }

  /**
   * Grab the platter: freeze the last ~4 s of output and pause the transport.
   * The music fades out over 15 ms; until `scratch()` moves it, the deck is silent.
   */
  scratchStart(): void {
    this.post({ type: 'scratchStart' });
  }

  /**
   * Platter speed while scratching: 1 forward at normal speed, -1 backward, 0 held.
   * Clamped to +/-4 in the engine, which glides toward it over ~20 ms.
   */
  scratch(rate: number): void {
    this.post({ type: 'scratch', rate });
  }

  /** Let go and resume playback from `step` (0..255, the song-step space of the playhead). */
  scratchEnd(step: number): void {
    this.post({ type: 'scratchEnd', step });
  }

  nudge(dir: -1 | 0 | 1): void {
    this.post({ type: 'nudge', dir });
  }
}

/** Resolve everyone waiting on `key` with `answer`. */
function settle(
  waiters: Map<number, Array<(answer: boolean) => void>>,
  key: number,
  answer: boolean,
): void {
  const waiting = waiters.get(key);
  waiters.delete(key);
  for (const resolve of waiting ?? []) resolve(answer);
}

export const engine = new EngineHost();
