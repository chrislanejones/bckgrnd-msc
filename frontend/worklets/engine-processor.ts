/**
 * The audio thread.
 *
 * This processor owns two Rust/WASM engines (deck A and deck B) and renders both
 * every block. Deck A is live; the idle deck is loaded with the cued track and
 * silent. An auto-mix crossfades their output gains and swaps which is live at the
 * end, so the handover is beat-matched without the audio thread ever stalling.
 *
 * ## Why the wasm bytes come from the main thread
 *
 * `AudioWorkletGlobalScope` has no `fetch`, so the processor cannot load the
 * `.wasm` binary itself. The main thread fetches it and posts the `ArrayBuffer`
 * in; `initSync` accepts raw bytes and compiles them synchronously here.
 *
 * ## Allocation
 *
 * `process()` is the audio callback and must not allocate. All buffers are sized
 * once in `startParam()` from the block size the host reports, and reused.
 */

import { initSync, Engine } from '@wasm';

/** Message protocol from the main thread. */
type Inbound =
  | { type: 'init'; wasm: ArrayBuffer; sampleRate: number }
  | { type: 'track'; deck: DeckId; json: string }
  | { type: 'transport'; deck: DeckId; action: 'play' | 'stop' }
  | { type: 'bpm'; value: number }
  | { type: 'swing'; value: number }
  | { type: 'master'; value: number }
  | { type: 'filter'; value: number }
  | { type: 'bands'; low: number; mid: number; high: number }
  | { type: 'echo'; on: boolean }
  | { type: 'loop'; bars: number }
  | { type: 'stereo'; mode: 0 | 1 | 2 }
  | { type: 'stereoBalance'; value: number }
  | { type: 'volume'; index: number; value: number }
  | { type: 'mute'; index: number; value: boolean }
  | { type: 'solo'; index: number; value: boolean }
  | { type: 'cue' }
  | { type: 'brake' }
  | { type: 'backspin' }
  | { type: 'scratchStart' }
  | { type: 'scratch'; rate: number }
  | { type: 'scratchEnd'; step: number }
  | { type: 'nudge'; dir: -1 | 0 | 1 }
  | { type: 'mix'; deck: DeckId; bpm: number; swing: number; json: string }
  | { type: 'promote'; deck: DeckId };

type DeckId = 'a' | 'b';

/**
 * Telemetry frame posted back to the UI.
 *
 * Layout: `[0..7]` stem levels, `[8]` visual step, `[9]` playing, `[10]` live deck
 * (0 = A, 1 = B). One array instead of an object because this crosses the thread
 * ~30 times a second and the meters are read every frame by React.
 */
const TELEMETRY_LEN = 12;

/** Stem indices, in the order of `Stem::ALL` in the engine. */
const STEM_KICK = 0;
const STEM_BASS = 3;

/**
 * How shut the filter is on a track entering a mix, and how far down its kick starts.
 * The incoming deck opens from here to the app's own settings across the crossfade.
 */
const MIX_ENTRY_FILTER = 0.22;
const MIX_ENTRY_KICK = 0.45;

class EngineProcessor extends AudioWorkletProcessor {
  /** Which deck the UI is listening to. */
  private live: DeckId = 'a';

  private engines: Record<DeckId, Engine | null> = { a: null, b: null };

  /** Scratch buffers, allocated once in `startParam`. */
  private left = new Float32Array(128);
  private right = new Float32Array(128);
  /**
   * A second pair, for the idle deck during a crossfade.
   *
   * `Engine::process` writes its buffers rather than adding to them, so both decks
   * rendering into one pair meant the second call threw the first deck's audio away.
   */
  private mixLeft = new Float32Array(128);
  private mixRight = new Float32Array(128);
  private levels = new Float32Array(8);
  private telemetry = new Float32Array(TELEMETRY_LEN);

  /**
   * The app's intended fader positions and filter, mirrored here.
   *
   * A mix brings the incoming deck in dark and bassless and has to open it back up
   * again, which means knowing what "open" is. The engine exposes setters but no
   * getters, so the last value the app sent is tracked instead.
   */
  private stemVol = new Float32Array(8).fill(0.8);
  private filterOpen = 1;

  /** Accumulated sample clock, used to schedule the auto-mix handover. */
  private frames = 0;

  /** Auto-mix state, or null when not crossfading. */
  private mix: MixJob | null = null;

  /** Frames until the next telemetry post, counted down by the block size. */
  private telemetryIn = 0;

  /** Set after the first render fault, so it is reported once and then parked. */
  private faulted = false;

  /** Set once the wasm has booted; `process` is a no-op until then. */
  private ready = false;

  constructor() {
    super();
    // AudioWorklet has no lifecycle hook for this, so sizing happens lazily in
    // `process`: the render quantum is fixed at 128 frames in every shipping
    // browser, but the allocation only happens once and never on the audio path
    // after that.
    this.port.onmessage = (event: MessageEvent<Inbound>) => {
      try {
        this.receive(event.data);
      } catch (error) {
        // The audio thread's `console` is not visible from the page, so a thrown
        // error here would otherwise present as unexplained silence. Report it
        // over the port, where `EngineHost` can surface it.
        this.port.postMessage({
          type: 'error',
          command: (event.data as { type?: string }).type ?? 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  private receive(message: Inbound): void {
    switch (message.type) {
      case 'init':
        this.boot(message.wasm, message.sampleRate);
        return;

      case 'track': {
        const engine = this.engines[message.deck];
        if (engine) engine.load_track_wasm(message.json);
        return;
      }

      case 'transport': {
        const engine = this.engines[message.deck];
        if (!engine) return;
        if (message.action === 'play') engine.play();
        else engine.stop();
        return;
      }

      case 'bpm':
        for (const engine of this.liveEngines()) engine.set_bpm(message.value);
        return;

      case 'swing':
        for (const engine of this.liveEngines()) engine.set_swing(message.value);
        return;

      case 'master':
        for (const engine of this.liveEngines()) engine.set_master(message.value);
        return;

      case 'filter':
        this.filterOpen = message.value;
        for (const engine of this.liveEngines()) engine.set_filter(message.value);
        return;

      case 'bands':
        for (const engine of this.liveEngines())
          engine.set_bands(message.low, message.mid, message.high);
        return;

      case 'echo':
        for (const engine of this.liveEngines()) engine.set_echo(message.on);
        return;

      case 'stereo':
        for (const engine of this.liveEngines()) engine.set_stereo_mode(message.mode);
        return;

      case 'stereoBalance':
        for (const engine of this.liveEngines()) engine.set_stereo_balance(message.value);
        return;

      case 'loop':
        for (const engine of this.liveEngines()) engine.set_loop(message.bars);
        return;

      case 'volume':
        if (message.index >= 0 && message.index < this.stemVol.length) {
          this.stemVol[message.index] = message.value;
        }
        for (const engine of this.liveEngines())
          engine.set_volume_index(message.index, message.value);
        return;

      case 'mute':
        for (const engine of this.liveEngines())
          engine.set_muted_index(message.index, message.value);
        return;

      case 'solo':
        for (const engine of this.liveEngines())
          engine.set_solo_index(message.index, message.value);
        return;

      case 'cue':
        this.engines[this.live]?.jump(0);
        return;

      case 'brake':
        this.engines[this.live]?.brake();
        return;

      case 'backspin':
        this.engines[this.live]?.backspin();
        return;

      // Scratch, like the other deck gestures, is the live deck's alone.
      case 'scratchStart':
        this.engines[this.live]?.scratch_start();
        return;

      case 'scratch':
        this.engines[this.live]?.scratch_rate(message.rate);
        return;

      case 'scratchEnd':
        this.engines[this.live]?.scratch_end(Math.max(0, Math.floor(message.step) || 0));
        return;

      case 'nudge':
        for (const engine of this.liveEngines()) engine.nudge(message.dir);
        return;

      case 'mix':
        this.startMix(message);
        return;

      case 'promote':
        this.promote(message.deck);
        return;
    }
  }

  /** Both engines once booted, so control changes reach the incoming deck too. */
  private *liveEngines(): Generator<Engine> {
    const a = this.engines.a;
    const b = this.engines.b;
    if (a) yield a;
    if (b) yield b;
  }

  private boot(wasm: ArrayBuffer, ctxSampleRate: number): void {
    // `initSync` compiles the bytes we were handed; there is no fetch here.
    initSync(wasm);

    // Two engines: the live deck and the cued deck. The output gain is the
    // crossfade handle, so both start with one at unity and one at zero.
    this.engines.a = new Engine(ctxSampleRate || sampleRate);
    this.engines.b = new Engine(ctxSampleRate || sampleRate);
    this.engines.a.set_output_gain(1);
    this.engines.b.set_output_gain(0);
    this.ready = true;
  }

  /**
   * Begin a beat-matched crossfade to the cued track.
   *
   * The incoming deck is matched to the outgoing tempo before it starts, so the
   * handover lands on a phrase boundary with no pitch jump.
   */
  private startMix(message: Extract<Inbound, { type: 'mix' }>): void {
    const from = this.engines[this.live];
    const to = this.engines[message.deck];
    if (!from || !to || message.deck === this.live) return;

    if (!from.is_playing()) {
      from.play();
    }
    // A held platter never reaches a downbeat, so the handover below would be timed
    // against a clock that is not moving. Let go first, where the hand had it.
    from.scratch_release();

    // Eight beats of crossfade, starting at the next four-bar boundary when that
    // is soon enough to be worth waiting for, otherwise the next bar.
    const phrase = from.samples_to_next_downbeat(4, 0.32);
    const bar = from.samples_to_next_downbeat(1, 0.32);
    const maxWait = (60 / Math.max(40, message.bpm)) * 2.1 * (ctxSr() || 48000);
    const start = phrase <= maxWait ? phrase : bar;

    to.load_track_wasm(message.json);
    to.set_bpm(message.bpm);
    to.set_swing(message.swing);
    // Enter dark and closed: no bass, a quiet kick, and a dark filter, so the track
    // fades up rather than appearing at full level mid-crossfade.
    to.set_volume_index(STEM_BASS, 0);
    to.set_volume_index(STEM_KICK, (this.stemVol[STEM_KICK] ?? 0.8) * MIX_ENTRY_KICK);
    to.set_filter(MIX_ENTRY_FILTER);
    to.set_echo(false);
    to.set_output_gain(0);
    // Deliberately *not* started here.
    //
    // Both decks run at the same tempo, but matching tempo is not matching beats. The
    // incoming deck used to be started the instant the mix was requested, which put
    // its bar 1 wherever the button happened to be pressed — so the two grids ran at
    // the same speed with a constant, arbitrary offset between them, and the kicks
    // landed against each other for the whole crossfade. It is started instead on the
    // outgoing deck's own downbeat, below, so bar 1 of the new track lands on a phrase
    // boundary of the old one and the two grids coincide.

    this.mix = {
      incoming: message.deck,
      outgoing: this.live,
      startFrame: this.frames + Math.floor(start),
      duration: Math.floor(((8 * 60) / Math.max(40, message.bpm)) * (ctxSr() || 48000)),
      started: false,
      done: false,
    };
  }

  private promote(deck: DeckId): void {
    this.live = deck;
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;

    // Every fault is funnelled through `runSafely`; see its note on why this is not
    // paranoia. Returning false parks the processor rather than spewing the same
    // error once per block.
    return this.runSafely(() => this.renderBlock(out[0], out.length > 1 ? out[1] : out[0]));
  }

  /** One render quantum. */
  private renderBlock(outL: Float32Array, outR: Float32Array): void {
    const frames = outL.length;

    if (!this.ready) {
      outL.fill(0);
      outR.fill(0);
      return;
    }

    // Sized on first use and then reused, so the audio path allocates at most once.
    if (this.left.length < frames) {
      this.left = new Float32Array(frames);
      this.right = new Float32Array(frames);
      this.mixLeft = new Float32Array(frames);
      this.mixRight = new Float32Array(frames);
    }
    const left = this.left.subarray(0, frames);
    const right = this.right.subarray(0, frames);

    this.applyMixGains();

    const live = this.engines[this.live];
    const idle = this.engines[this.live === 'a' ? 'b' : 'a'];

    if (live) live.process(left, right);
    else {
      left.fill(0);
      right.fill(0);
    }

    // The idle deck renders too while a mix is running, so its envelope and filter
    // have settled by the time it is promoted.
    //
    // Into its *own* buffers, then summed. `Engine::process` assigns rather than
    // accumulates, so rendering both decks into one pair silently discarded the
    // outgoing track: for the whole crossfade you heard only the incoming deck,
    // which starts at zero gain, so the mix played as a drop to silence followed by
    // the new track appearing. The crossfade gains were correct; there was simply
    // nothing left to fade out.
    if (idle && this.mix) {
      const mixL = this.mixLeft.subarray(0, frames);
      const mixR = this.mixRight.subarray(0, frames);
      idle.process(mixL, mixR);
      for (let i = 0; i < frames; i += 1) {
        left[i] += mixL[i];
        right[i] += mixR[i];
      }
    }

    for (let i = 0; i < frames; i += 1) {
      outL[i] = left[i];
      outR[i] = right[i];
    }

    this.frames += frames;
    this.publishTelemetry(live, frames);
  }

  /**
   * Run `process`, reporting any fault over the port.
   *
   * A throw inside `process()` is caught and discarded by the browser, and the
   * worklet's `console` is not visible from the page — so an unguarded bug here
   * presents as plain silence. This wrapper turns that class of failure into a
   * message the app can show.
   */
  private runSafely(inner: () => void): boolean {
    try {
      inner();
      return true;
    } catch (error) {
      if (!this.faulted) {
        this.faulted = true;
        // Drop back to silence rather than raising every block, but say why once.
        this.port.postMessage({
          type: 'error',
          command: 'process',
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    }
  }

  /**
   * Crossfade the two decks' output gains over the handover window.
   *
   * Shaped with a smoothstep so the sum stays roughly constant through the middle
   * of the fade instead of dipping where the two curves cross.
   */
  private applyMixGains(): void {
    const job = this.mix;
    if (!job) return;

    const elapsed = this.frames - job.startFrame;
    if (elapsed < 0) return;

    // The downbeat has arrived: start the incoming deck from the top, in phase with
    // the deck it is replacing. Alignment is good to one render quantum, under 3 ms.
    if (!job.started) {
      job.started = true;
      const to = this.engines[job.incoming];
      to?.jump(0);
      to?.play();
    }

    if (elapsed >= job.duration) {
      const from = this.engines[job.outgoing];
      const to = this.engines[job.incoming];
      to?.set_output_gain(1);
      from?.set_output_gain(0);
      from?.stop();
      // Land the incoming deck exactly on the app's settings. `startMix` brought it
      // in with no bass, a half kick and a near-shut filter, and nothing used to put
      // those back: every track that arrived by auto mix stayed bassless and dark for
      // as long as it played, because the only thing that would have restored them
      // was the user happening to touch a fader.
      this.openIncoming(job.incoming, 1);
      this.live = job.incoming;
      this.mix = null;
      this.port.postMessage({ type: 'mixEnd', deck: job.incoming });
      return;
    }

    const p = elapsed / job.duration;
    const shaped = p * p * (3 - 2 * p);
    this.engines[job.outgoing]?.set_output_gain(Math.cos((shaped * Math.PI) / 2));
    this.engines[job.incoming]?.set_output_gain(Math.sin((shaped * Math.PI) / 2));
    // Open the incoming track up across the fade, which is the gesture the entry
    // settings were there to set up in the first place.
    this.openIncoming(job.incoming, shaped);
  }

  /**
   * Move the incoming deck from its "entering" state toward the app's real settings.
   *
   * `t` is 0 at the start of the crossfade and 1 at the end. The bass arrives, the
   * kick comes up to full and the filter opens, so the track rises into the mix
   * instead of being pasted over it.
   */
  private openIncoming(deck: DeckId, t: number): void {
    const engine = this.engines[deck];
    if (!engine) return;
    const k = Math.min(1, Math.max(0, t));
    const bass = this.stemVol[STEM_BASS] ?? 0.8;
    const kick = this.stemVol[STEM_KICK] ?? 0.8;
    engine.set_volume_index(STEM_BASS, bass * k);
    engine.set_volume_index(STEM_KICK, kick * (MIX_ENTRY_KICK + (1 - MIX_ENTRY_KICK) * k));
    engine.set_filter(MIX_ENTRY_FILTER + (this.filterOpen - MIX_ENTRY_FILTER) * k);
  }

  private publishTelemetry(live: Engine | null, frames: number): void {
    // ~30 Hz. Counted down in frames rather than derived from the frame counter
    // with a modulo: the block size does not divide the period, so `frames % 1600`
    // is never within one block of zero and telemetry silently never arrives.
    this.telemetryIn -= frames;
    if (this.telemetryIn <= 0) {
      this.telemetryIn = TELEMETRY_EVERY;
      if (live) live.levels_into(this.levels);
      this.telemetry.set(this.levels.subarray(0, 8), 0);
      this.telemetry[8] = live ? live.visual_step() : -1;
      this.telemetry[9] = live && live.is_playing() ? 1 : 0;
      this.telemetry[10] = this.live === 'a' ? 0 : 1;
      this.telemetry[11] = this.mix ? 1 : 0;
      this.port.postMessage({ type: 'telemetry', frame: this.telemetry.slice() });
    }
  }
}

/** Frames between telemetry posts: ~27 Hz at 44.1 kHz, ~33 Hz at 48 kHz. */
const TELEMETRY_EVERY = 1600;

type MixJob = {
  incoming: DeckId;
  outgoing: DeckId;
  startFrame: number;
  duration: number;
  /** Set once the incoming deck has been started, on the outgoing deck's downbeat. */
  started: boolean;
  done: boolean;
};

/** `sampleRate` is a worklet global; guard for the bundler's static analysis. */
function ctxSr(): number {
  return typeof sampleRate === 'number' ? sampleRate : 48000;
}

registerProcessor('bckgrnd-msc-engine', EngineProcessor);