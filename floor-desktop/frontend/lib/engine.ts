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
};

type WorkletMessage =
  | { type: 'telemetry'; frame: Float32Array }
  | { type: 'mixEnd'; deck: Deck }
  | { type: 'error'; command: string; message: string };

type Listener = (telemetry: Telemetry) => void;
type ErrorListener = (message: string) => void;

const WASM_URL = '/wasm/floor_engine_bg.wasm';
const WORKLET_URL = '/build/engine-worklet.js';

export class EngineHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<Listener>();
  private errorListeners = new Set<ErrorListener>();

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
  };

  private booted: Promise<void> | null = null;

  private mixEndHandler: (() => void) | null = null;

  /**
   * Boot the audio graph. Safe to call repeatedly; the work is done once.
   *
   * Must be called from a user gesture — an `AudioContext` created outside one
   * starts suspended, and a suspended context cannot run the processor.
   */
  async boot(): Promise<void> {
    this.booted ??= this.create();
    return this.booted;
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

    await ctx.audioWorklet.addModule(WORKLET_URL);

    // `fetch` exists here even though it does not in the worklet, so the binary is
    // pulled down on this thread and handed over as bytes.
    const response = await fetch(WASM_URL);
    if (!response.ok) {
      throw new Error(`could not load the audio engine: ${response.status} ${WASM_URL}`);
    }
    const wasm = await response.arrayBuffer();

    const node = new AudioWorkletNode(ctx, 'floor-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    node.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.onMessage(event.data);
    node.connect(ctx.destination);
    this.node = node;

    // The processor needs the context's real rate, which it also knows as a global;
    // passing it explicitly keeps the two from disagreeing after a device change.
    this.post({ type: 'init', wasm, sampleRate: ctx.sampleRate }, [wasm]);
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
      };
      for (const listener of this.listeners) listener(this.telemetry);
      return;
    }
    if (message.type === 'mixEnd') {
      this.mixEndHandler?.();
    }
  }

  private post(message: unknown, transfer: Transferable[] = []): void {
    this.node?.port.postMessage(message, transfer);
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
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  async close(): Promise<void> {
    this.node?.disconnect();
    this.node = null;
    await this.ctx?.close();
    this.ctx = null;
    this.booted = null;
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

  /** Load an arranged track into a deck. The idle deck should stay silent. */
  loadTrack(deck: Deck, arrangement: TrackArrangement): void {
    this.post({ type: 'track', deck, json: JSON.stringify(arrangement) });
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
  ): void {
    this.mixEndHandler = onEnd;
    this.post({ type: 'mix', deck, bpm, swing, json: JSON.stringify(arrangement) });
  }

  /**
   * Collect the diagnostic report.
   *
   * Exposed as `window.__FLOOR_DIAG__` by `main.tsx` so it can be run from DevTools
   * without a rebuild.
   */
  async diagnose(): Promise<Record<string, unknown>> {
    return this.buildDiagnostic();
  }

  // -- Mixer ----------------------------------------------------------------

  setVolume(index: number, value: number): void {
    this.post({ type: 'volume', index, value });
  }

  setMuted(index: number, value: boolean): void {
    this.post({ type: 'mute', index, value });
  }

  setSolo(index: number, value: boolean): void {
    this.post({ type: 'solo', index, value });
  }

  setMaster(value: number): void {
    this.post({ type: 'master', value });
  }

  setBpm(value: number): void {
    this.post({ type: 'bpm', value });
  }

  setSwing(value: number): void {
    this.post({ type: 'swing', value });
  }

  setBands(low: number, mid: number, high: number): void {
    this.post({ type: 'bands', low, mid, high });
  }

  setFilter(value: number): void {
    this.post({ type: 'filter', value });
  }

  setEcho(on: boolean): void {
    this.post({ type: 'echo', on });
  }

  setStereo(mode: 0 | 1 | 2): void {
    this.post({ type: 'stereo', mode });
  }

  setLoop(bars: number): void {
    this.post({ type: 'loop', bars });
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

  nudge(dir: -1 | 0 | 1): void {
    this.post({ type: 'nudge', dir });
  }
}

export const engine = new EngineHost();