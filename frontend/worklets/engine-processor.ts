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
  | { type: 'track'; deck: DeckId; json: string; generation?: number }
  | { type: 'transport'; deck: DeckId; action: 'play' | 'stop' }
  | { type: 'bpm'; value: number }
  | { type: 'swing'; value: number }
  | { type: 'master'; value: number }
  | { type: 'filter'; value: number }
  | { type: 'bands'; low: number; mid: number; high: number }
  | { type: 'echo'; on: boolean }
  | { type: 'echoTime'; beats: number }
  | { type: 'loop'; bars: number }
  | { type: 'audition'; bar: number }
  | { type: 'stereo'; mode: 0 | 1 | 2 }
  | { type: 'stereoBalance'; value: number }
  | { type: 'width'; value: number }
  | { type: 'filterQ'; value: number }
  | { type: 'echoFeedback'; value: number }
  | { type: 'echoReturn'; value: number }
  | { type: 'reverbMix'; value: number }
  | { type: 'reverbDecay'; value: number }
  | { type: 'send'; index: number; value: number }
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
  | {
      type: 'mix';
      deck: DeckId;
      bpm: number;
      swing: number;
      json: string;
      generation?: number;
    }
  | { type: 'promote'; deck: DeckId }
  | {
      type: 'scene';
      requestId: number;
      generation: number;
      timing: number;
      values: ArrayLike<number>;
      deck?: DeckId;
      /** The lanes this scene sets, compiled (NIGHT4_PROTOCOL.md); applied with it. */
      patterns?: Float32Array;
      /** The request id those lanes carry in events. */
      patternsId?: number;
    }
  | { type: 'cancelScene'; requestId: number }
  | {
      type: 'patterns';
      requestId: number;
      generation: number;
      timing: number;
      data: Float32Array;
      deck?: DeckId;
    }
  | { type: 'cancelPatterns'; requestId: number }
  | { type: 'fill'; requestId: number; generation: number; index: number; deck?: DeckId }
  | { type: 'cancelFill'; requestId: number }
  | { type: 'gestureBegin'; token: number; kind: number }
  | { type: 'gestureEnd'; token: number }
  | { type: 'gestureRenew'; token: number }
  | { type: 'releaseGestures' }
  | { type: 'panic' };

type DeckId = 'a' | 'b';

/**
 * Telemetry frame posted back to the UI.
 *
 * Layout: `[0..7]` stem levels, `[8]` visual step, `[9]` playing, `[10]` live deck
 * (0 = A, 1 = B), `[11]` mixing, `[12]` / `[13]` master peak left / right since the
 * last frame (linear, of what actually leaves the worklet), `[14]` 1 if any sample
 * since the last frame went past full scale. One array instead of an object because
 * this crosses the thread ~30 times a second and the meters are read every frame.
 *
 * Telemetry is transient: none of it is ever saved (contracts/README.md).
 */
const TELEMETRY_LEN = 15;

/** Stem indices, in the order of `Stem::ALL` in the engine. */
const STEM_KICK = 0;
const STEM_BASS = 3;

/**
 * How shut the filter is on a track entering a mix, and how far down its kick starts.
 * The incoming deck opens from here to the app's own settings across the crossfade.
 */
const MIX_ENTRY_FILTER = 0.22;
const MIX_ENTRY_KICK = 0.45;

/**
 * Scene protocol constants (docs/NIGHT3_PROTOCOL.md). The engine owns the meaning;
 * these are the numbers the worklet itself needs.
 */
const SCENE_LEN = 44;
const SCENE_FX_FILTER = 32;
const EVENT_WIDTH = 4;
/** `EVENT_CAPACITY` in engine-core/src/scheduler.rs: one drain empties the ring. */
const EVENT_CAPACITY = 64;
const EVENT_SCENE_APPLIED = 2;
const EVENT_SCENE_CANCELLED = 3;
const EVENT_SCENE_REJECTED = 5;
const EVENT_FILL_REJECTED = 15;
const EVENT_PATTERNS_REJECTED = 35;
const REASON_INVALID = 1;
const REASON_TRACK = 4;
const REASON_MIXING = 6;
const REASON_NOT_PLAYING = 7;
const REASON_STALE = 9;

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

  /** Highest absolute output sample per channel since the last telemetry frame. */
  private peakL = 0;
  private peakR = 0;

  /**
   * The app's intended fader positions and filter, mirrored here.
   *
   * A mix brings the incoming deck in dark and bassless and has to open it back up
   * again, which means knowing what "open" is. The engine exposes setters but no
   * getters, so the last value the app sent is tracked instead.
   */
  private stemVol = new Float32Array(8).fill(0.8);
  /**
   * The echo send per stem as the UI last set it, or NaN for "the stem's own default".
   * A mix reloads the incoming deck, which puts its sends back to the defaults, so
   * these are re-applied to it the way the faders are carried across.
   */
  private stemSend = new Float32Array(8).fill(Number.NaN);
  private filterOpen = 1;

  /**
   * Each deck's loaded-track counter, as the UI numbered it in the `track` or `mix`
   * message that loaded it. A scene request carries the generation it was made for,
   * and one made for a track that has since been replaced is refused here.
   */
  private generation: Record<DeckId, number> = { a: 0, b: 0 };

  /** Where an inbound scene's values are copied before the engine sees them. */
  private sceneIn = new Float32Array(SCENE_LEN);
  /**
   * The values of the scene the live engine has accepted and not yet applied, and its
   * request id (-1 for none). When `applied` comes back for it, the mirrors above and
   * the idle deck are brought in line, so a later handover carries the scene's mix
   * rather than the one before it.
   */
  private scenePending = new Float32Array(SCENE_LEN);
  private scenePendingId = -1;
  /** Drained engine events, reused every block. */
  private eventBuf = new Float64Array(EVENT_CAPACITY * EVENT_WIDTH);

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
        if (typeof message.generation === 'number') {
          this.generation[message.deck] = message.generation;
        }
        // Loading cancels that deck's pending scene and fill, ends an active fill and
        // releases its held gestures, all inside the engine (`track`).
        if (engine) engine.load_track_wasm(message.json);
        if (message.deck === this.live) this.scenePendingId = -1;
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

      case 'echoTime':
        for (const engine of this.liveEngines()) engine.set_echo_time(message.beats);
        return;

      case 'stereo':
        for (const engine of this.liveEngines()) engine.set_stereo_mode(message.mode);
        return;

      case 'stereoBalance':
        for (const engine of this.liveEngines()) engine.set_stereo_balance(message.value);
        return;

      case 'width':
        for (const engine of this.liveEngines()) engine.set_width(message.value);
        return;

      case 'filterQ':
        for (const engine of this.liveEngines()) engine.set_filter_q(message.value);
        return;

      case 'echoFeedback':
        for (const engine of this.liveEngines()) engine.set_echo_feedback(message.value);
        return;

      case 'echoReturn':
        for (const engine of this.liveEngines()) engine.set_echo_return(message.value);
        return;

      case 'reverbMix':
        for (const engine of this.liveEngines()) engine.set_reverb_mix(message.value);
        return;

      case 'reverbDecay':
        for (const engine of this.liveEngines()) engine.set_reverb_decay(message.value);
        return;

      case 'send':
        if (message.index >= 0 && message.index < this.stemSend.length) {
          this.stemSend[message.index] = message.value;
        }
        for (const engine of this.liveEngines())
          engine.set_send_index(message.index, message.value);
        return;

      case 'loop':
        for (const engine of this.liveEngines()) engine.set_loop(message.bars);
        return;

      // Hear a bar: the one action that moves the playhead to what is being edited.
      // A jump is a seek, so a pending pattern edit applies first (the bar plays as
      // edited), then a one-bar loop snaps to the bar jumped to.
      case 'audition': {
        const live = this.engines[this.live];
        const bar = Math.max(0, Math.min(15, Math.floor(message.bar) || 0));
        live?.jump(bar * 16);
        for (const engine of this.liveEngines()) engine.set_loop(1);
        return;
      }

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

      case 'patterns':
        this.queuePatterns(message);
        this.drainEvents(this.live, this.engines[this.live]);
        return;

      case 'cancelPatterns': {
        const engine = this.engines[this.live];
        const id = message.requestId >>> 0;
        const cancelled = engine ? engine.cancel_patterns(id) : false;
        this.port.postMessage({ type: 'patternsCancelResult', deck: this.live, requestId: id, cancelled });
        this.drainEvents(this.live, engine);
        return;
      }

      case 'scene':
        this.queueScene(message);
        // A stopped deck applies a scene on the spot. Drain now rather than wait for
        // the next render call, which never comes while the context is suspended.
        this.drainEvents(this.live, this.engines[this.live]);
        return;

      case 'fill':
        this.queueFill(message);
        this.drainEvents(this.live, this.engines[this.live]);
        return;

      case 'cancelFill': {
        const engine = this.engines[this.live];
        const id = message.requestId >>> 0;
        const cancelled = engine ? engine.cancel_fill(id) : false;
        this.port.postMessage({ type: 'fillCancelResult', deck: this.live, requestId: id, cancelled });
        return;
      }

      // Gestures are the live deck's: they are something the performer is doing to
      // what they hear. The outgoing deck's are released when a mix starts.
      case 'gestureBegin': {
        const engine = this.engines[this.live];
        const token = message.token >>> 0;
        const kind = message.kind === 1 || message.kind === 2 ? message.kind : 255;
        const accepted = engine ? engine.gesture_begin(token, kind) : false;
        this.port.postMessage({ type: 'gestureBeginResult', deck: this.live, token, accepted });
        return;
      }

      case 'gestureEnd':
        this.engines[this.live]?.gesture_end(message.token >>> 0);
        return;

      case 'gestureRenew':
        this.engines[this.live]?.gesture_renew(message.token >>> 0);
        return;

      case 'releaseGestures':
        for (const engine of this.liveEngines()) engine.release_gestures();
        return;

      case 'panic':
        this.panic();
        return;

      case 'cancelScene': {
        const engine = this.engines[this.live];
        const id = message.requestId >>> 0;
        const cancelled = engine ? engine.cancel_scene(id) : false;
        if (cancelled && id === this.scenePendingId) this.scenePendingId = -1;
        // The engine reports a successful cancel as an event; a miss (already applied,
        // replaced, or never queued) is only visible here, so say so either way.
        this.port.postMessage({
          type: 'sceneCancelResult',
          deck: this.live,
          requestId: id,
          cancelled,
        });
        return;
      }
    }
  }

  /**
   * Hand a scene request to the live engine, or refuse it here: a vector of the
   * wrong length (`invalid`), an auto-mix in progress (`mixing`), or a request made
   * for a deck or track generation that is no longer live (`stale generation`).
   * The engine validates the values themselves and reports its own outcome.
   */
  private queueScene(message: Extract<Inbound, { type: 'scene' }>): void {
    const requestId = message.requestId >>> 0;
    const values = message.values;
    let refusal = 0;
    if (values == null || values.length !== SCENE_LEN) refusal = REASON_INVALID;
    else if (this.mix) refusal = REASON_MIXING;
    else if (
      (message.deck !== undefined && message.deck !== this.live) ||
      message.generation !== this.generation[this.live]
    )
      refusal = REASON_STALE;
    const engine = this.engines[this.live];
    if (refusal === 0 && !engine) refusal = REASON_NOT_PLAYING;
    if (refusal !== 0 || !engine) {
      this.postSceneEvents(this.live, [EVENT_SCENE_REJECTED, requestId, refusal, 0]);
      return;
    }
    // The lanes the scene sets go in first, linked to it, so a scene that applies on
    // the spot (stopped) takes them with it. If the lanes are refused, the scene is
    // refused too: half a scene would play something nobody captured.
    if (message.patterns && message.patterns.length > 0) {
      const linkId = (message.patternsId ?? 0) >>> 0;
      if (engine.queue_patterns(linkId, 2, requestId, message.patterns) !== 0) {
        this.postSceneEvents(this.live, [EVENT_SCENE_REJECTED, requestId, REASON_INVALID, 0]);
        return;
      }
    }
    // Copied, so the engine reads a Float32Array and nothing the UI still holds.
    for (let i = 0; i < SCENE_LEN; i += 1) this.sceneIn[i] = Number(values[i]);
    // Anything but 0, 1 or 2 goes in as 255, which the engine refuses (`invalid`),
    // rather than wrapping into a valid code on the way to a u8.
    const t = message.timing;
    const timing = t === 0 || t === 1 || t === 2 ? t : 255;
    const verdict = engine.queue_scene(requestId, timing, this.sceneIn);
    if (verdict === 0) {
      this.scenePending.set(this.sceneIn);
      this.scenePendingId = requestId;
    }
  }

  /**
   * Hand a pattern revision to the live engine, or refuse it here in the engine's own
   * `patterns rejected` shape: an auto-mix in progress (`mixing`: the live deck is on
   * its way out), a request made for a deck or track generation that is no longer live
   * (`stale generation`, so an edit for the old track never reaches a new one), or no
   * engine yet (`not playing`). The engine validates the payload itself.
   */
  private queuePatterns(message: Extract<Inbound, { type: 'patterns' }>): void {
    const requestId = message.requestId >>> 0;
    let refusal = 0;
    if (!(message.data instanceof Float32Array) || message.data.length === 0) refusal = REASON_INVALID;
    else if (this.mix) refusal = REASON_MIXING;
    else if (
      (message.deck !== undefined && message.deck !== this.live) ||
      message.generation !== this.generation[this.live]
    )
      refusal = REASON_STALE;
    const engine = this.engines[this.live];
    if (refusal === 0 && !engine) refusal = REASON_NOT_PLAYING;
    if (refusal !== 0 || !engine) {
      this.postSceneEvents(this.live, [EVENT_PATTERNS_REJECTED, requestId, refusal, 0]);
      return;
    }
    const t = message.timing;
    const timing = t === 0 || t === 1 || t === 2 ? t : 255;
    engine.queue_patterns(requestId, timing, 0, message.data);
  }

  /**
   * Hand a fill request to the live engine, or refuse it here, in the same shape as
   * the engine's own `fill rejected` (15): an auto-mix in progress (`mixing`), a
   * stale deck or generation, or no engine yet (`not playing`).
   */
  private queueFill(message: Extract<Inbound, { type: 'fill' }>): void {
    const requestId = message.requestId >>> 0;
    let refusal = 0;
    if (this.mix) refusal = REASON_MIXING;
    else if (
      (message.deck !== undefined && message.deck !== this.live) ||
      message.generation !== this.generation[this.live]
    )
      refusal = REASON_STALE;
    const engine = this.engines[this.live];
    if (refusal === 0 && !engine) refusal = REASON_NOT_PLAYING;
    if (refusal !== 0 || !engine) {
      this.postSceneEvents(this.live, [EVENT_FILL_REJECTED, requestId, refusal, 0]);
      return;
    }
    const index = Number.isInteger(message.index) && message.index >= 0 ? message.index : 0xffffffff;
    engine.queue_fill(requestId, index >>> 0);
  }

  /**
   * Panic: both decks. Any auto-mix is abandoned where it is, with the live deck
   * back at full trim and the other silent, and each engine cancels what it had
   * queued (`panic`), ends its fill, releases its gestures, stops and clears its
   * tails. The UI gets the engine's events; `mixEnd` is not sent for an abandoned mix.
   */
  private panic(): void {
    if (this.mix) {
      this.mix = null;
      this.engines[this.live]?.set_output_gain(1);
      this.engines[this.live === 'a' ? 'b' : 'a']?.set_output_gain(0);
    }
    this.scenePendingId = -1;
    for (const engine of this.liveEngines()) engine.panic();
    this.drainEvents('a', this.engines.a);
    this.drainEvents('b', this.engines.b);
  }

  private postSceneEvents(deck: DeckId, events: number[]): void {
    this.port.postMessage({ type: 'sceneEvents', deck, events });
  }

  /**
   * After a render call, pass on whatever the engines reported.
   *
   * `event_count` is a cheap read, so the copy (and the message, the only allocation
   * here) happens only on blocks that have something to say: a handful per scene.
   */
  private drainEvents(deck: DeckId, engine: Engine | null): void {
    if (!engine || engine.event_count() === 0) return;
    const n = engine.take_events_into(this.eventBuf);
    if (n === 0) return;
    const buf = this.eventBuf;
    if (deck === this.live) {
      for (let k = 0; k < n; k += 1) {
        const kind = buf[k * EVENT_WIDTH];
        const id = buf[k * EVENT_WIDTH + 1];
        if (id !== this.scenePendingId) continue;
        if (kind === EVENT_SCENE_APPLIED) {
          this.followScene(this.scenePending);
          this.scenePendingId = -1;
        } else if (kind === EVENT_SCENE_CANCELLED) {
          this.scenePendingId = -1;
        }
      }
    }
    this.postSceneEvents(deck, Array.from(buf.subarray(0, n * EVENT_WIDTH)));
  }

  /**
   * A scene applied on the live deck: carry it into the mirrors the auto-mix reads,
   * and onto the idle deck now, so neither restores the mix from before the scene.
   */
  private followScene(values: Float32Array): void {
    for (let i = 0; i < 8; i += 1) {
      this.stemVol[i] = values[i * 4];
      this.stemSend[i] = values[i * 4 + 1];
    }
    this.filterOpen = values[SCENE_FX_FILTER];
    const idle = this.engines[this.live === 'a' ? 'b' : 'a'];
    idle?.set_scene(values);
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

    if (typeof message.generation === 'number') {
      this.generation[message.deck] = message.generation;
    }
    // The outgoing deck's pending scene and fill were for the track that is leaving
    // (`track`), and its held gestures go with it.
    from.cancel_pending(REASON_TRACK);
    from.release_gestures();
    this.scenePendingId = -1;

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
    // The reload put the incoming deck's sends back to their defaults; carry the
    // user's across, as the faders are.
    this.stemSend.forEach((value, index) => {
      if (!Number.isNaN(value)) to.set_send_index(index, value);
    });
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
    if (deck !== this.live) {
      // A scene or fill pending on the deck that stops being live would land on a deck
      // nobody is listening to: the same as a track change for it. Its held gestures
      // are released for the same reason.
      this.engines[this.live]?.cancel_pending(REASON_TRACK);
      this.engines[this.live]?.release_gestures();
      this.scenePendingId = -1;
    }
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

    // The master meter reads here, after both decks are summed, because that sum is
    // what reaches the speaker. Each engine's own limiter holds it under -0.3 dBFS,
    // but during a crossfade the two limited decks add, and only this point sees it.
    let peakL = this.peakL;
    let peakR = this.peakR;
    for (let i = 0; i < frames; i += 1) {
      const l = left[i];
      const r = right[i];
      outL[i] = l;
      outR[i] = r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > peakL) peakL = al;
      if (ar > peakR) peakR = ar;
    }
    this.peakL = peakL;
    this.peakR = peakR;

    this.frames += frames;
    this.drainEvents(this.live, live);
    this.drainEvents(this.live === 'a' ? 'b' : 'a', idle);
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
      this.telemetry[12] = this.peakL;
      this.telemetry[13] = this.peakR;
      this.telemetry[14] = this.peakL > 1 || this.peakR > 1 ? 1 : 0;
      this.peakL = 0;
      this.peakR = 0;
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