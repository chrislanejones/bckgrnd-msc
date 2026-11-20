/**
 * The instrument's state and the intents it sends to the engine.
 *
 * Moved out of `app.tsx` unchanged in behavior, so the layout can be rebuilt around
 * it without touching what the controls do. Components get values and callbacks from
 * here. The two continuous gestures, the jog wheel and the waveform scratch, still
 * send their own messages from their components, as they always have: they are
 * pointer streams, not state.
 *
 * It holds what the user asked for (faders, cuts, the track) and mirrors what the
 * audio thread reports (playing, the step). It never keeps a musical clock and never
 * schedules a note — the engine does both (docs/DESIGN_PHILOSOPHY.md, "Architecture
 * boundaries"). The one timer here, the tempo glide after a mix, moves a control.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { engine, GESTURE_KIND, SCENE_ACCENT, SCENE_TIMING } from './engine';
import type { Deck as DeckId, EngineEvent as WireEvent, SceneAccent } from './engine';
import { emptyFlags, fetchLibrary, fetchTrack } from './api';
import {
  defaultSend,
  fixedDefault,
  projectFromTrack,
  sameMusic,
  type Project,
  type SceneSlotId,
  type Scenes,
} from './contract';
import {
  EVENT,
  REASON,
  BUILD_BAR_CHOICES,
  accentStatus,
  captureScene,
  copyMix,
  duplicateScene,
  factoryScenes,
  foldSceneEvent,
  isFillEvent,
  isFillPending,
  isLaunchEvent,
  isPending,
  isSceneSlot,
  mixFromVector,
  renameScene,
  resetScene,
  sameMix,
  sceneVector,
  setSceneCrash,
  type BuildBars,
  type Compare,
  type SceneMix,
  type SceneRequest,
  type Timing,
} from './scenes';
import {
  DEFAULT_PHRASE_BARS,
  FILL_INDEX,
  PHRASE_BAR_CHOICES,
  buildRefusal,
  fillIntoCancelled,
  fillIntoRefusal,
  fillPhrase,
  fillQueuedStatus,
  fillRefusal,
  foldFillJob,
  markFilling,
  type FillAt,
  type FillJob,
  type PhraseBars,
} from './fills';
import { PREF, readChoice, writeChoice } from './prefs';
import { STEM_ORDER, STEPS } from './stems';
import { LANE_IDS, type LaneId, type ScenePatterns } from './patterns';
import { usePatternWorkspace } from './workspace';
import { useProjectHistory } from './project-history';
import type { LibraryResponse, Mix, StemId, TrackArrangement, TrackSummary } from './types';

/** The scene slot Fill → Drop leads into: the fourth, whatever it is named now. */
const FILL_INTO_SLOT: SceneSlotId = 'drop';

/** Master level a fresh session starts at, and what its reset returns to. */
export const MASTER_DEFAULT = fixedDefault('master.level');
/** The engine's default echo time, a dotted eighth. */
export const ECHO_DEFAULT = fixedDefault('fx.echoTime');

/**
 * The bar a continuous mix starts its handover on, of sixteen.
 *
 * Far enough in that the track has played, far enough from the end that the eight-beat
 * crossfade still has a four-bar phrase boundary to start on rather than falling back
 * to the next bar.
 */
const CONTINUOUS_MIX_BAR = 12;

/**
 * How long the tempo takes to ease from the outgoing track's to the incoming one's once
 * a mix has landed. Long enough to be inaudible as a move, short enough that the tempo
 * readout is telling the truth about the track within a phrase or two.
 */
const TEMPO_GLIDE_SECONDS = 12;

export type Mask = 'full' | 'nodrums' | 'nomusic' | 'custom';
/** Off, or running with or without the stem swap. */
export type ContinuousMode = 'off' | 'swap' | 'plain';
export type Bands = { low: number; mid: number; high: number };

/** The effect parameters added with the effects rack, by contract id. */
export type Effects = {
  'fx.filterQ': number;
  'fx.echoFeedback': number;
  'fx.echoReturn': number;
  'fx.reverbMix': number;
  'fx.reverbDecay': number;
  'fx.width': number;
};
export type EffectId = keyof Effects;

export const EFFECT_DEFAULTS: Effects = {
  'fx.filterQ': fixedDefault('fx.filterQ'),
  'fx.echoFeedback': fixedDefault('fx.echoFeedback'),
  'fx.echoReturn': fixedDefault('fx.echoReturn'),
  'fx.reverbMix': fixedDefault('fx.reverbMix'),
  'fx.reverbDecay': fixedDefault('fx.reverbDecay'),
  'fx.width': fixedDefault('fx.width'),
};

/** Each stem's own echo send, from the registry. */
export function defaultSends(): Record<StemId, number> {
  return Object.fromEntries(STEM_ORDER.map((id) => [id, defaultSend(id)])) as Record<StemId, number>;
}

/** Which engine message each effect parameter is sent as. */
const EFFECT_SENDERS: Record<EffectId, (value: number) => void> = {
  'fx.filterQ': (v) => engine.setFilterQ(v),
  'fx.echoFeedback': (v) => engine.setEchoFeedback(v),
  'fx.echoReturn': (v) => engine.setEchoReturn(v),
  'fx.reverbMix': (v) => engine.setReverbMix(v),
  'fx.reverbDecay': (v) => engine.setReverbDecay(v),
  'fx.width': (v) => engine.setWidth(v),
};

/**
 * Wrap a set of functions so each keeps one identity for the life of the component
 * while always calling the latest version. Controls are memoized; a callback that
 * changed identity on every render would re-render every one of them on every
 * change anywhere, which during a knob drag is the whole interface sixty times a
 * second.
 */
function useStable<T extends Record<string, (...args: never[]) => unknown>>(actions: T): T {
  const latest = useRef(actions);
  latest.current = actions;
  return useMemo(() => {
    const out = {} as Record<string, unknown>;
    for (const key of Object.keys(latest.current)) {
      out[key] = (...args: never[]) => latest.current[key]!(...args);
    }
    return out as T;
  }, []);
}

/** The order a stem-swapping continuous mix steps the groups through. */
const CONTINUOUS_MASKS: Mask[] = ['full', 'nodrums', 'nomusic'];

/** Paint the mute flags for a group shortcut. */
function paintMutes(mask: Mask, drums: StemId[], music: StemId[]): Record<StemId, boolean> {
  const flags = emptyFlags();
  if (mask === 'nodrums') for (const id of drums) flags[id] = true;
  if (mask === 'nomusic') for (const id of music) flags[id] = true;
  return flags;
}

export function useInstrument() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [track, setTrack] = useState<TrackArrangement | null>(null);
  const [historyEpoch, setHistoryEpoch] = useState(0);

  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(-1);
  /** The song step as last reported, for event handlers that run between renders. */
  const songStepRef = useRef(-1);
  const [bpm, setBpmState] = useState(126);
  const [swing, setSwingState] = useState(0.22);
  const [master, setMasterState] = useState(MASTER_DEFAULT);
  const [vols, setVols] = useState<Mix | null>(null);
  const [muted, setMuted] = useState(emptyFlags);
  const [solo, setSolo] = useState(emptyFlags);
  const [mask, setMask] = useState<Mask>('full');
  const [loopBars, setLoopBarsState] = useState(0);
  /** Echo time in beats; 0 when the echo is off. */
  const [echoBeats, setEchoBeatsState] = useState<number>(ECHO_DEFAULT);
  const [bands, setBandsState] = useState<Bands>({ low: 1, mid: 1, high: 1 });
  const [filter, setFilterState] = useState(1);
  /** Output balance: 0 hard left (right speaker silent), 0.5 both at full, 1 hard right. */
  const [stereo, setStereoState] = useState(0.5);
  const [effects, setEffects] = useState<Effects>(EFFECT_DEFAULTS);
  /** Each stem's echo send. A track change puts them back to the stems' own amounts. */
  const [sends, setSends] = useState<Record<StemId, number>>(defaultSends);
  const [mixing, setMixing] = useState<string | null>(null);
  const [nextId, setNextId] = useState<string>('');
  /**
   * Continuous mix. `swap` also steps the stem groups on at each handover; `plain`
   * just runs one track into the next.
   */
  const [continuous, setContinuous] = useState<ContinuousMode>('off');
  /**
   * Which deck is currently live, and what is cued on the other one.
   *
   * The worklet runs two engines and swaps which one is audible during a mix, so the
   * panel has to follow the swap rather than assume deck A is always the one playing.
   * Without this the two waveforms disagree with the audio after a handover.
   */
  const [liveDeck, setLiveDeck] = useState<DeckId>('a');
  const [cued, setCued] = useState<TrackArrangement | null>(null);

  const arrangementCache = useRef(new Map<string, TrackArrangement>());

  /**
   * Each deck's loaded-track generation. Every load bumps it and tells the worklet,
   * and a scene request carries the one it was made for, so a request made for one
   * track can never land on the next one loaded into that deck.
   */
  const generations = useRef<Record<DeckId, number>>({ a: 0, b: 0 });
  const loadDeck = useCallback((deck: DeckId, arranged: TrackArrangement) => {
    generations.current[deck] += 1;
    engine.loadTrack(deck, arranged, generations.current[deck]);
  }, []);

  // ---- Patterns ---------------------------------------------------------------
  /** The edited lanes, their undo history and what the engine has confirmed. */
  const patterns = usePatternWorkspace({
    track,
    liveDeck,
    generation: () => generations.current[liveDeck],
  });
  const patternsRef = useRef(patterns);
  patternsRef.current = patterns;

  // ---- Scenes ---------------------------------------------------------------
  /** The four stored scene slots for the live track (part of the project). */
  const [scenes, setScenes] = useState<Scenes | null>(null);
  /**
   * The slot the engine last applied, with the exact mix it applied, so a knob moved
   * afterwards reads as "Modified" until the slot is explicitly overwritten. Session
   * state: never saved, cleared by a track change.
   */
  const [activeScene, setActiveScene] = useState<{ slot: SceneSlotId; mix: SceneMix } | null>(null);
  /** One return point for a run of scene choices; never part of the saved project. */
  const beforeScenes = useRef<{
    mix: SceneMix;
    patterns: ScenePatterns;
    changedLanes: Set<LaneId>;
  } | null>(null);
  /** The latest launch request, pending or just settled. */
  const [sceneRequest, setSceneRequest] = useState<SceneRequest | null>(null);
  const sceneRequestRef = useRef<SceneRequest | null>(null);
  sceneRequestRef.current = sceneRequest;
  const [sceneTiming, setSceneTimingState] = useState<Timing>('bar');
  /**
   * Build mode (Night 7): a pad press rises into its scene over this many bars instead
   * of switching on one onset. Null when Switch on is Now, Next beat or Next bar.
   */
  const [buildBars, setBuildBarsState] = useState<BuildBars | null>(null);
  /** The bar count Build mode comes back with, so 2 or 8 sticks once chosen, and is remembered. */
  const [savedBuildBars] = useState<BuildBars>(() => readChoice(PREF.riseBars, BUILD_BAR_CHOICES, 4));
  const lastBuildBars = useRef<BuildBars>(savedBuildBars);
  /** Finish with Fill: a Rise ends with the track's fill on its last bar (Night 8). */
  const [riseFill, setRiseFillState] = useState(() => readChoice(PREF.riseFill, ['on', 'off'], 'off') === 'on');
  /**
   * What the knobs were last moved to by the running build, and the scene-vector slots
   * the user has moved since (theirs from then on, as in the engine).
   */
  const buildShown = useRef<{
    requestId: number;
    last: Float32Array | null;
    touched: Set<number>;
    /** The render count when `last` was shown; the store only has it after a render. */
    shownAt: number;
  }>({ requestId: -1, last: null, touched: new Set(), shownAt: 0 });
  /**
   * A rise a track load interrupted. The engine cancels it on the Stop that comes
   * before the load and glides back to where it started, but its last base arrives
   * after the scenes are reset for the new track. Until its final event, that base
   * still moves the effect knobs (not the faders: the load resets those itself).
   */
  const abandonedBuild = useRef<number | null>(null);
  const renders = useRef(0);
  renders.current += 1;
  /** One line for assistive technology: discrete changes only, never every beat. */
  const [sceneStatus, setSceneStatus] = useState('');
  const nextRequestId = useRef(1);
  /** Compare A/B, or null when not comparing. Session-only. */
  const [compare, setCompare] = useState<Compare | null>(null);

  // ---- Fill and held effects ----------------------------------------------
  /**
   * The one fill the engine holds (Night 3's one-bar fill, Night 8's phrase fills): a
   * plain fill, a Fill into's, or a Rise's, folded from its events. Null before any.
   */
  const [fill, setFillState] = useState<FillJob | null>(null);
  const fillRef = useRef<FillJob | null>(null);
  const setFill = (next: FillJob | null) => {
    fillRef.current = next;
    setFillState(next);
  };
  /** Fill at, and the phrase length a Phrase end fill ends on: app preferences. */
  const [fillAt, setFillAtState] = useState<FillAt>(() => readChoice(PREF.fillAt, ['bar', 'phrase'] as const, 'bar'));
  const [phraseBars, setPhraseBarsState] = useState<PhraseBars>(() =>
    readChoice(PREF.phraseBars, PHRASE_BAR_CHOICES, DEFAULT_PHRASE_BARS));
  /**
   * Held effects, by kind, with the token the engine knows them by. Temporary
   * overrides only: none of this is part of the working mix or the project.
   */
  const [held, setHeld] = useState<{ echo: boolean; filter: boolean }>({ echo: false, filter: false });
  const heldTokens = useRef<{ echo: number | null; filter: number | null }>({ echo: null, filter: null });
  const leaseTimers = useRef<{ echo: number | null; filter: number | null }>({ echo: null, filter: null });
  const nextToken = useRef(1);

  useEffect(() => {
    let cancelled = false;
    fetchLibrary()
      .then((lib) => {
        if (cancelled) return;
        setLibrary(lib);
        const first = lib.tracks[0];
        if (first) setNextId(lib.tracks[1]?.id ?? first.id);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  /** Load a track's arrangement, memoized per track. */
  const loadArrangement = useCallback(async (id: string): Promise<TrackArrangement | null> => {
    const cached = arrangementCache.current.get(id);
    if (cached) return cached;
    const { track: arranged } = await fetchTrack(id);
    arrangementCache.current.set(id, arranged);
    return arranged;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const first = library?.tracks[0];
    if (!first) return;
    loadArrangement(first.id)
      .then((arranged) => {
        if (!arranged || cancelled) return;
        setTrack(arranged);
        setBpmState(arranged.bpm);
        setSwingState(arranged.swing);
        setVols(arranged.mix);
        setScenes(factoryScenes(arranged));
        loadDeck('a', arranged);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [library, loadArrangement, loadDeck]);

  /** The deck that is loaded but silent — the one a mix will hand over to. */
  const idleDeck = (): DeckId => (liveDeck === 'a' ? 'b' : 'a');

  /**
   * Keep the idle deck loaded with whatever is in Next, and keep its waveform drawn.
   *
   * Both decks show a track from the first paint: A is the one playing, B is the one
   * an auto mix would bring in.
   */
  useEffect(() => {
    let cancelled = false;
    if (!nextId || nextId === track?.id) return;
    const deck = idleDeck();
    loadArrangement(nextId)
      .then((arranged) => {
        if (!arranged || cancelled) return;
        // The idle deck is preloaded and silent; it only becomes audible when a mix
        // crossfades to it, which is what makes the handover seamless.
        loadDeck(deck, arranged);
        setCued(arranged);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // `liveDeck` decides which deck is idle, so a handover has to re-run this.
  }, [nextId, track?.id, liveDeck, loadArrangement, loadDeck]);

  // Telemetry → the playhead. Meters subscribe on their own and write to the DOM, so
  // a 30 Hz stream never re-renders the tree; this only changes when the step does.
  useEffect(
    () =>
      engine.subscribe((t) => {
        setPlaying(t.playing && engine.running);
        setStep(t.step);
        songStepRef.current = t.step < 0 ? -1 : t.step % STEPS;
      }),
    [],
  );

  // A fault on the audio thread is otherwise silent, so surface it.
  useEffect(() => engine.onError((message) => { setError(message); setPlaying(false); }), []);

  const songStep = step < 0 ? -1 : step % STEPS;
  const bar = songStep < 0 ? 0 : Math.floor(songStep / 16);

  // ---- Transport ----------------------------------------------------------

  async function togglePlay() {
    // Always act on the deck that is actually audible. After an auto mix that is deck
    // B, and transport sent to deck A would stop and start a silent engine.
    if (playing) {
      engine.stop(liveDeck);
      setPlaying(false);
      // Stop releases held effects and cancels the fill in the engine; the screen
      // follows rather than waiting for a release that may never come.
      clearHeld('echo');
      clearHeld('filter');
      return;
    }
    try {
      engine.clearError();
      await engine.play(liveDeck);
      setError(null);
      setPlaying(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Load a track onto the live deck and play it.
   *
   * Picking a track is a deliberate act, so it starts the transport. Nothing starts on
   * page load; it takes this click, or the play button.
   */
  function selectTrack(summary: TrackSummary) {
    if (mixing) return;
    void (async () => {
      try {
        const arranged = await loadArrangement(summary.id);
        if (!arranged) return;
        cancelTempoGlide();
        const deck = liveDeck;
        const rising = sceneRequestRef.current;
        abandonedBuild.current = rising?.build && isPending(rising) ? rising.requestId : null;
        engine.stop(deck);
        loadDeck(deck, arranged);
        engine.setMuted(0, false);
        setTrack(arranged);
        resetScenesFor(arranged);
        patternsRef.current.restore(arranged, {}, { lanes: [], events: {} }, true);
        setHistoryEpoch((x) => x + 1);
        setBpmState(arranged.bpm);
        engine.setBpm(arranged.bpm);
        setSwingState(arranged.swing);
        engine.setSwing(arranged.swing);
        setVols(arranged.mix);
        // Loading a track puts the engine's sends back to the stems' own amounts;
        // the screen and the worklet's memory of them follow.
        const fresh = defaultSends();
        setSends(fresh);
        for (let i = 0; i < STEM_ORDER.length; i += 1) {
          engine.setVolume(i, arranged.mix[STEM_ORDER[i]!]);
          engine.setSend(i, fresh[STEM_ORDER[i]!]);
          engine.setMuted(i, false);
          engine.setSolo(i, false);
        }
        const clear = emptyFlags();
        setMuted(clear);
        setSolo(clear);
        setMask('full');
        setLoopBarsState(0);
        engine.setLoop(0);

        engine.clearError();
        await engine.play(deck);
        setPlaying(true);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }

  /** A project opens stopped, even if this engine was already playing. */
  async function openProject(p: Project) {
    if (mixing) throw new Error('Open is available after the mix finishes.');
    const arranged = await loadArrangement(p.trackId);
    if (!arranged) throw new Error(`Missing source track: ${p.trackId}`);
    cancelTempoGlide();
    engine.panic();
    releaseAllEffects();
    setPlaying(false); setContinuous('off'); setLoopBarsState(0); engine.setLoop(0);
    loadDeck(liveDeck, arranged);
    setTrack(arranged);
    resetScenesFor(arranged);
    setHistoryEpoch((x) => x + 1);
    setScenes(structuredClone(p.scenes));
    setBpm(p.params['transport.bpm']); setSwing(p.params['transport.swing']);
    setMaster(p.params['master.level']);
    sendMix(p); showMix(p);
    patternsRef.current.restore(arranged, p.patterns, p.locks);
  }

  /** Cue rewinds the live deck and starts that same deck. */
  function cue() {
    engine.cue();
    void engine.play(liveDeck);
  }

  // ---- Mixing to the next track -----------------------------------------

  const tracks = library?.tracks ?? [];

  function autoMix() {
    if (mixing || !track) return;
    cancelTempoGlide();
    void (async () => {
      try {
        const id = nextId && nextId !== track.id ? nextId : (tracks[1]?.id ?? track.id);
        const arranged = await loadArrangement(id);
        if (!arranged) return;

        const incoming: DeckId = liveDeck === 'a' ? 'b' : 'a';
        loadDeck(incoming, arranged);
        setCued(arranged);
        // A launch queued for the outgoing track never lands; the worklet cancels it
        // and refuses new ones until the handover is done.
        setSceneRequest((r) => (isPending(r) ? { ...r, status: 'cancelled', reason: 4 } : r));
        releaseAllEffects();
        // Carry the user's faders and cuts across to the incoming track.
        for (let i = 0; i < STEM_ORDER.length; i += 1) {
          const stem = STEM_ORDER[i]!;
          engine.setVolume(i, vols?.[stem] ?? 0.8);
          engine.setMuted(i, Boolean(muted[stem]));
          engine.setSolo(i, Boolean(solo[stem]));
        }
        engine.setBpm(bpm);
        engine.setSwing(swing);

        setMixing(arranged.name);
        generations.current[incoming] += 1;
        const mixGeneration = generations.current[incoming];
        engine.mix(incoming, arranged, bpm, swing, () => {
          setMixing(null);
          setTrack(arranged);
          resetScenesFor(arranged);
          patternsRef.current.restore(arranged, {}, { lanes: [], events: {} }, true);
          setHistoryEpoch((x) => x + 1);
          // The deck that just went live is no longer the cued one, so the panel has to
          // follow the swap or the waveforms will label the wrong tracks.
          setLiveDeck(incoming);

          // Everything below sets the engine as well as the screen, so the display and
          // the audio describe the same session after a mix.
          //
          // Tempo glides rather than jumps: the incoming deck was matched to the
          // outgoing tempo for the crossfade, and snapping it to its own tempo the
          // moment the fade ended would be an audible lurch.
          glideTempo(bpm, arranged.bpm, TEMPO_GLIDE_SECONDS);
          setSwingState(arranged.swing);
          engine.setSwing(arranged.swing);
          setVols(arranged.mix);
          // Like the faders, the sends were carried across the crossfade and land on
          // the new track's own amounts.
          const fresh = defaultSends();
          setSends(fresh);
          for (let i = 0; i < STEM_ORDER.length; i += 1) {
            engine.setVolume(i, arranged.mix[STEM_ORDER[i]!]);
            engine.setSend(i, fresh[STEM_ORDER[i]!]);
            engine.setSolo(i, false);
          }
          setSolo(emptyFlags());

          // A continuous mix steps the stem groups on at each handover; a one-off auto
          // mix lands on the full track.
          if (continuousRef.current === 'swap') {
            maskStep.current = (maskStep.current + 1) % CONTINUOUS_MASKS.length;
            applyMask(CONTINUOUS_MASKS[maskStep.current] ?? 'full');
          } else {
            setMuted(emptyFlags());
            setMask('full');
            for (let i = 0; i < STEM_ORDER.length; i += 1) engine.setMuted(i, false);
          }
          // The deck that just went live holds `arranged` now; pointing Next at the
          // following track re-cues the deck that just went idle.
          setCued(null);
          setNextId(tracks.find((t) => t.id !== arranged.id)?.id ?? arranged.id);
        }, mixGeneration);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }

  /**
   * Continuous mix: hands over to Next once the playhead reaches the last section, so
   * the crossfade has a phrase to land on and the set never stops.
   */
  const autoMixRef = useRef<() => void>(() => {});
  /** Re-armed once the playhead is back before the trigger, so each pass fires once. */
  const armed = useRef(true);
  const maskStep = useRef(0);
  const continuousRef = useRef(continuous);

  // The mix callback runs on the audio thread's schedule, long after the render that
  // set it up, so it reads these through refs rather than a stale closure.
  autoMixRef.current = autoMix;
  continuousRef.current = continuous;

  useEffect(() => {
    if (continuous === 'off' || !playing || mixing) return;
    if (bar < CONTINUOUS_MIX_BAR) {
      armed.current = true;
      return;
    }
    if (!armed.current) return;
    armed.current = false;
    autoMixRef.current();
  }, [continuous, playing, mixing, bar]);

  /** The running tempo glide, so a new gesture can take it over. */
  const tempoGlide = useRef<number | null>(null);

  function cancelTempoGlide() {
    if (tempoGlide.current !== null) {
      window.clearInterval(tempoGlide.current);
      tempoGlide.current = null;
    }
  }

  // A glide must not outlive the page.
  useEffect(() => cancelTempoGlide, []);

  /**
   * Ease the tempo from `from` to `to` over `seconds`. Any other tempo gesture cancels
   * it first, so the glide never fights the hand on the control.
   */
  function glideTempo(from: number, to: number, seconds: number) {
    cancelTempoGlide();
    if (Math.abs(to - from) < 0.5) {
      engine.setBpm(to);
      setBpmState(Math.round(to));
      return;
    }
    const started = performance.now();
    tempoGlide.current = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - started) / (seconds * 1000));
      const eased = t * t * (3 - 2 * t);
      const value = from + (to - from) * eased;
      engine.setBpm(value);
      setBpmState(Math.round(value));
      if (t >= 1) cancelTempoGlide();
    }, 200);
  }

  // ---- Stems --------------------------------------------------------------

  function applyMask(next: Mask) {
    const flags = paintMutes(next, library?.drums ?? [], library?.music ?? []);
    const clear = emptyFlags();
    setMask(next);
    setMuted(flags);
    setSolo(clear);
    for (let i = 0; i < STEM_ORDER.length; i += 1) {
      engine.setMuted(i, Boolean(flags[STEM_ORDER[i]!]));
      engine.setSolo(i, false);
    }
  }

  function toggleMute(id: StemId) {
    setMuted((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      engine.setMuted(STEM_ORDER.indexOf(id), next[id]);
      return next;
    });
    setMask('custom');
  }

  function toggleSolo(id: StemId) {
    setSolo((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      engine.setSolo(STEM_ORDER.indexOf(id), next[id]);
      return next;
    });
    setMask('custom');
  }

  function setStemVolume(id: StemId, value: number) {
    setVols((prev) => {
      const next = { ...(prev ?? ({} as Mix)), [id]: value };
      engine.setVolume(STEM_ORDER.indexOf(id), value);
      return next;
    });
  }

  // ---- Scenes ---------------------------------------------------------------

  /** A new track gets its own factory scenes, nothing active and nothing queued. */
  function resetScenesFor(arranged: TrackArrangement) {
    setScenes(factoryScenes(arranged));
    setActiveScene(null);
    beforeScenes.current = null;
    // At once, not on the next render: an outcome for the old track's request that
    // arrives before then must not fold into it and show the old track's mix.
    sceneRequestRef.current = null;
    setSceneRequest(null);
    setCompare(null);
    setSceneStatus('');
  }

  const sceneName = (slot: string) =>
    slot === 'compareA'
      ? 'Compare A'
      : slot === 'compareB'
        ? 'Compare B'
        : slot === 'restore'
          ? 'The mix from before comparing'
          : slot === 'restoreScene'
            ? 'The mix from before scenes'
            : (scenes?.slots.find((s) => s.slot === slot)?.name ?? slot);

  /**
   * Make an applied scene the working mix on screen. The engine has already set
   * every value (and the idle deck, and its own memory of them), so nothing is sent
   * back: the knobs follow what is now playing.
   */
  function showMix(mix: SceneMix) {
    const stems = mix.stems;
    setVols((prev) => {
      const next = { ...(prev ?? ({} as Mix)) };
      for (const id of STEM_ORDER) next[id] = stems[id].volume;
      return next;
    });
    const nextSends = {} as Record<StemId, number>;
    const nextMuted = emptyFlags();
    const nextSolo = emptyFlags();
    for (const id of STEM_ORDER) {
      nextSends[id] = stems[id].send;
      nextMuted[id] = stems[id].muted;
      nextSolo[id] = stems[id].solo;
    }
    setSends(nextSends);
    setMuted(nextMuted);
    setSolo(nextSolo);
    setMask('custom');
    showParams(mix.params);
  }

  /** The effect half of `showMix`: the scene parameters, without the stems. */
  function showParams(p: SceneMix['params']) {
    setBandsState({ low: p['fx.low'], mid: p['fx.mid'], high: p['fx.high'] });
    setFilterState(p['fx.filter']);
    setStereoState(p['fx.stereo']);
    setEchoBeatsState(p['fx.echoTime']);
    setEffects({
      'fx.filterQ': p['fx.filterQ'],
      'fx.echoFeedback': p['fx.echoFeedback'],
      'fx.echoReturn': p['fx.echoReturn'],
      'fx.reverbMix': p['fx.reverbMix'],
      'fx.reverbDecay': p['fx.reverbDecay'],
      'fx.width': p['fx.width'],
    });
  }

  // Engine outcomes. Only `applied` changes what is active; everything else updates
  // the request's status and the one-line announcement. A fill's events are folded here
  // too, after the batch's launch events, as they were when Fill had a listener of its
  // own: a Stop's "Drop cancelled" comes first and the fill's "Fill cancelled" joins it.
  useEffect(
    () =>
      engine.onSceneEvents((events: readonly WireEvent[]) => {
        for (const e of events) {
          if (e.kind === EVENT.accentFired) {
            // After the launch's `applied` (docs/NIGHT8_PROTOCOL.md): say the crash if it
            // was heard; one silent under a solo leaves "<name> active" as it is.
            const r = sceneRequestRef.current;
            const said = r?.requestId === e.requestId ? accentStatus(sceneNameRef.current(r.target), e.b) : null;
            if (said) setSceneStatus(said);
            continue;
          }
          if (!isLaunchEvent(e.kind)) continue;
          // The interrupted rise's last base came ahead of its outcome; nothing follows.
          if (e.requestId === abandonedBuild.current && e.kind >= EVENT.buildApplied && e.kind <= EVENT.buildRejected) {
            abandonedBuild.current = null;
          }
          const current = sceneRequestRef.current;
          if (!current || current.requestId !== e.requestId) continue;
          const next = foldSceneEvent(current, { kind: e.kind, id: e.requestId, a: e.a, b: e.b });
          if (next === current) continue;
          sceneRequestRef.current = next;
          setSceneRequest(next);
          const name = sceneNameRef.current(next.target);
          if (next.build) {
            buildOutcomeRef.current(next, current, e.b);
            continue;
          }
          if (next.fillInto) {
            fillIntoOutcomeRef.current(next, current, e.b);
            continue;
          }
          if (next.status === 'queued') {
            setSceneStatus(next.timing === 'now' ? `${name} queued` : `${name} queued for bar ${next.bar}`);
          } else if (next.status === 'applied') {
            landedRef.current(next);
            showMixRef.current(next.mix);
            setSceneStatus(next.target === 'restoreScene'
              ? 'Scene cleared; previous mix restored'
              : next.target === 'restore' ? 'Comparison closed; the earlier mix is back' : `${name} active`);
          } else if (next.status === 'cancelled') {
            // A cancel the user asked for needs no reason; any other says what did it.
            const why = next.reason === undefined || next.reason === 10 ? '' : `: ${REASON[next.reason] ?? ''}`;
            setSceneStatus(`${name} cancelled${why}`);
          } else if (next.status === 'rejected') {
            setSceneStatus(`${name} not launched: ${REASON[next.reason ?? 1] ?? 'refused'}`);
          }
        }
        for (const e of events) if (isFillEvent(e.kind)) fillEventRef.current(e);
      }),
    [],
  );
  // Where a running build has moved the base (~30 Hz, then once more as it ends): the
  // knobs follow it, except the ones the user has moved since it started, which are
  // theirs (the engine stops driving them too). Display only: nothing is sent back.
  useEffect(
    () =>
      engine.onBuildBase((requestId, values) => {
        if (requestId === abandonedBuild.current) {
          showParamsRef.current(mixFromVector(values).params);
          return;
        }
        const current = sceneRequestRef.current;
        if (!current?.build || current.requestId !== requestId) return;
        followBuildRef.current(requestId, values);
      }),
    [],
  );

  // The subscription above lives for the app; it reads these through refs.
  const showMixRef = useRef(showMix);
  showMixRef.current = showMix;
  const showParamsRef = useRef(showParams);
  showParamsRef.current = showParams;
  const sceneNameRef = useRef(sceneName);
  sceneNameRef.current = sceneName;

  /** Move the knobs to where a build has the base, keeping the ones the user moved. */
  function followBuild(requestId: number, values: readonly number[]) {
    const shown = buildShown.current;
    if (shown.requestId !== requestId) {
      buildShown.current = { requestId, last: null, touched: new Set(), shownAt: 0 };
    }
    const state = buildShown.current;
    const working = sceneVector(workingMix());
    const next = Float32Array.from(values);
    // Until React has rendered the last snapshot, the store still holds the one before,
    // which would look like the user's hand.
    if (state.last && renders.current > state.shownAt) {
      for (let i = 0; i < next.length; i += 1) {
        if (working[i] !== state.last[i]) state.touched.add(i);
      }
    }
    for (const i of state.touched) next[i] = working[i]!;
    state.last = next;
    state.shownAt = renders.current;
    showMix(mixFromVector(next));
  }
  const followBuildRef = useRef(followBuild);
  followBuildRef.current = followBuild;

  /**
   * One build outcome: the pad line comes from the request, the status line from here.
   * `part` is the event's `b`: for a refusal, the part at fault.
   */
  function buildOutcome(next: SceneRequest, prev: SceneRequest, part: number) {
    const name = sceneName(next.target);
    const bars = next.build!.bars;
    if (next.status === 'queued') {
      setSceneStatus(next.build!.fill
        ? `${name} rises over ${bars} bars from bar ${next.bar}, ending with a fill`
        : `${name} rises over ${bars} bars from bar ${next.bar}`);
    } else if (next.status === 'building' && prev.status !== 'building') {
      setSceneStatus(`${name} rising over ${bars} bars`);
    } else if (next.status === 'applied') {
      // The knobs already stand where the build left them (its final base arrives
      // first). The scene's own mix is what Active compares against, so a control the
      // user moved during the build reads as Modified. Its lanes landed with it.
      landed(next);
      setSceneStatus(`${name} active`);
    } else if (next.status === 'cancelled') {
      const why = next.reason === undefined || next.reason === 10 ? '' : `: ${REASON[next.reason] ?? ''}`;
      setSceneStatus(`${name} rise cancelled${why}`);
    } else if (next.status === 'rejected') {
      setSceneStatus(`${name} rise not started: ${buildRefusal(next.reason ?? 1, part)}`);
    }
  }
  const buildOutcomeRef = useRef(buildOutcome);
  buildOutcomeRef.current = buildOutcome;

  /**
   * One outcome for the scene half of a Fill into (docs/NIGHT8_PROTOCOL.md). The fill's
   * own events say nothing on the status line while it is linked, so this is the one
   * voice for the pair: "Drop lands on bar 9 after a fill", then "Drop active".
   */
  function fillIntoOutcome(next: SceneRequest, prev: SceneRequest, part: number) {
    const name = sceneName(next.target);
    if (next.status === 'queued') {
      setSceneStatus(`${name} lands on bar ${next.bar} after a fill`);
    } else if (next.status === 'applied') {
      landed(next);
      showMix(next.mix);
      setSceneStatus(`${name} active`);
    } else if (next.status === 'cancelled') {
      setSceneStatus(fillIntoCancelled(name, next.reason, Boolean(prev.fillInto?.filling)));
    } else if (next.status === 'rejected') {
      setSceneStatus(`Fill → ${name} not started: ${fillIntoRefusal(next.reason ?? 1, part, name)}`);
    }
  }
  const fillIntoOutcomeRef = useRef(fillIntoOutcome);
  fillIntoOutcomeRef.current = fillIntoOutcome;

  /** What an applied launch means for the active scene and the comparison. */
  function landed(request: SceneRequest) {
    const t = request.target;
    // A launch or a build carried its lanes to the engine and they landed with it
    // (docs/NIGHT7_PROTOCOL.md): adopt them without sending them again.
    if (request.lanes) patternsRef.current.adoptScene(sceneName(t), request.lanes, !engine.booted);
    if (isSceneSlot(t)) {
      for (const lane of Object.keys(request.lanes ?? {}) as LaneId[]) beforeScenes.current?.changedLanes.add(lane);
      setActiveScene({ slot: t, mix: request.mix });
    } else if (t === 'restoreScene') {
      setActiveScene(null);
      beforeScenes.current = null;
      // Keep the user's A/B captures, but neither is the mix now being heard.
      // Exiting comparison should not reinstate the scene they just cancelled.
      setCompare((c) => c ? { ...c, listening: null, before: copyMix(request.mix), beforeActive: null } : null);
    } else if (t === 'restore') {
      setActiveScene(compareRef.current?.beforeActive ?? null);
      setCompare(null);
    } else {
      setCompare((c) => (c ? { ...c, listening: t === 'compareA' ? 'a' : 'b' } : c));
    }
  }
  const landedRef = useRef(landed);
  landedRef.current = landed;
  const compareRef = useRef(compare);
  compareRef.current = compare;

  /**
   * Set a whole mix through the ordinary parameter messages. Only used before the
   * audio engine has booted (no Play yet): there is no scheduler to ask, and the
   * engine host replays the latest value of every parameter when it boots, so this
   * is what will play.
   */
  function sendMix(mix: SceneMix) {
    STEM_ORDER.forEach((id, i) => {
      const s = mix.stems[id];
      engine.setVolume(i, s.volume);
      engine.setSend(i, s.send);
      engine.setMuted(i, s.muted);
      engine.setSolo(i, s.solo);
    });
    const p = mix.params;
    engine.setBands(p['fx.low'], p['fx.mid'], p['fx.high']);
    engine.setFilter(p['fx.filter']);
    engine.setStereoBalance(p['fx.stereo']);
    engine.setEchoTime(p['fx.echoTime']);
    for (const id of Object.keys(EFFECT_SENDERS) as EffectId[]) EFFECT_SENDERS[id](p[id]);
  }

  /** Send a mix to the live deck at the chosen timing. */
  function requestLaunch(
    target: SceneRequest['target'],
    revision: number,
    mix: SceneMix,
    lanes?: ScenePatterns,
    timing: Timing = sceneTiming,
    accent: SceneAccent = SCENE_ACCENT.none,
  ) {
    const sets = lanes && Object.keys(lanes).length ? lanes : undefined;
    if (!engine.booted) {
      // Stopped and never played: apply now, without starting playback.
      const now = copyMix(mix);
      sendMix(now);
      showMix(now);
      setSceneRequest(null);
      landed({
        requestId: 0,
        target,
        revision,
        generation: 0,
        timing,
        status: 'applied',
        mix: now,
        ...(sets ? { lanes: sets } : {}),
      });
      setSceneStatus(target === 'restoreScene'
        ? 'Scene cleared; previous mix restored'
        : target === 'restore' ? 'Comparison closed; the earlier mix is back' : `${sceneName(target)} active`);
      return;
    }
    const requestId = nextRequestId.current++;
    const deck = liveDeck;
    const request: SceneRequest = {
      requestId,
      target,
      revision,
      generation: generations.current[deck],
      timing,
      status: 'sending',
      mix: copyMix(mix),
      ...(sets ? { lanes: sets } : {}),
    };
    sceneRequestRef.current = request;
    setSceneRequest(request);
    // The scene's lanes are compiled now, so the revision that plays is the one
    // launched even if the slot is captured again while it waits.
    const data = sets ? patterns.scenePayload(sets) : undefined;
    engine.queueScene(
      requestId,
      SCENE_TIMING[timing],
      sceneVector(request.mix),
      request.generation,
      data ? { requestId: nextRequestId.current++, data } : undefined,
      accent,
    );
  }

  /**
   * A pad press. Launches the slot; pressing the slot that is already queued cancels
   * it; pressing the active, unmodified scene does nothing. Never saves anything.
   */
  function launchScene(slot: SceneSlotId) {
    if (!scenes || mixing) return;
    const pending = isPending(sceneRequest) ? sceneRequest : null;
    if (pending?.target === 'restoreScene') return;
    if (pending && pending.target === slot) {
      cancelQueuedScene();
      return;
    }
    const scene = scenes.slots.find((s) => s.slot === slot);
    if (!scene) return;
    if (
      !pending &&
      activeScene?.slot === slot &&
      sameMix(workingMix(), activeScene.mix) &&
      !patterns.differsFrom(scene.patterns)
    ) {
      return;
    }
    if (buildBars !== null && !(engine.booted && playing)) {
      // A build is measured in bars of playback; stopped, there is nothing to rise over.
      setSceneStatus(`${scene.name} can rise only during playback: press Play, or switch on Now`);
      return;
    }
    if (!beforeScenes.current || (!activeScene && !(pending && isSceneSlot(pending.target)))) {
      beforeScenes.current = { mix: workingMix(), patterns: patterns.sceneLanes(), changedLanes: new Set() };
    }
    // Crash on launch rides on the request, so it lands on the scene's own commit onset.
    const accent = scene.crash ? SCENE_ACCENT.crash : SCENE_ACCENT.none;
    if (buildBars !== null) requestBuild(slot, scene.revision, scene, buildBars, scene.patterns, accent);
    else requestLaunch(slot, scene.revision, scene, scene.patterns, sceneTiming, accent);
  }

  /**
   * Ask the live deck to rise into a scene over `bars` bars (docs/NIGHT7_PROTOCOL.md).
   * Same request record as a launch, so the pads, Cancel and the status line treat it
   * alike; outcomes are kinds 41-47.
   */
  function requestBuild(
    target: SceneSlotId,
    revision: number,
    mix: SceneMix,
    bars: BuildBars,
    lanes?: ScenePatterns,
    accent: SceneAccent = SCENE_ACCENT.none,
  ) {
    const sets = lanes && Object.keys(lanes).length ? lanes : undefined;
    const requestId = nextRequestId.current++;
    // Finish with Fill (Night 8): the track's fill plays the Rise's last bar, as part of
    // the same request. A plain fill or a Fill into still waiting would hold the one fill
    // slot and refuse the Rise, so it is withdrawn first (a fill already playing ends
    // within its bar and does not block it). A replaced Rise's fill goes with that Rise.
    const withFill = riseFill && Boolean(track?.fills?.length);
    const fillId = withFill ? nextRequestId.current++ : 0;
    if (withFill) {
      const waiting = fillRef.current;
      if (isFillPending(waiting) && waiting.kind !== 'rise' && waiting.status !== 'playing') {
        void engine.cancelFill(waiting.requestId);
      }
      setFill({ requestId: fillId, status: 'sending', kind: 'rise', phrase: 0, from: songStepRef.current, partner: requestId });
    }
    const request: SceneRequest = {
      requestId,
      target,
      revision,
      generation: generations.current[liveDeck],
      timing: 'bar',
      status: 'sending',
      mix: copyMix(mix),
      build: { bars, ...(withFill ? { fill: { fillId } } : {}) },
      ...(sets ? { lanes: sets } : {}),
    };
    buildShown.current = { requestId, last: null, touched: new Set(), shownAt: 0 };
    sceneRequestRef.current = request;
    setSceneRequest(request);
    // Compiled now, as for a launch, so the lanes that land are the ones risen into even
    // if the slot is captured again while the build runs. They commit on its end bar.
    const data = sets ? patterns.scenePayload(sets) : undefined;
    engine.queueBuild(
      requestId,
      bars,
      sceneVector(request.mix),
      request.generation,
      undefined,
      data ? { requestId: nextRequestId.current++, data } : undefined,
      { accent, ...(withFill ? { fill: { requestId: fillId, index: FILL_INDEX } } : {}) },
    );
  }

  /** Clear a queued or active scene, restoring the mix from before scene choices. */
  function cancelScene() {
    const before = beforeScenes.current;
    if (!before || mixing || (isPending(sceneRequest) && sceneRequest.target === 'restoreScene')) return;
    const lanes = new Set(before.changedLanes);
    // Include a pending scene's lanes too: it may have landed just before its
    // telemetry arrives. The replacement request restores them atomically.
    if (isPending(sceneRequest) && isSceneSlot(sceneRequest.target)) {
      for (const lane of Object.keys(sceneRequest.lanes ?? {}) as LaneId[]) lanes.add(lane);
    }
    const restore: ScenePatterns = {};
    for (const lane of lanes) restore[lane] = before.patterns[lane] ?? { factory: true };
    // A Fill into still waiting goes as a whole: its fill too, never just its scene
    // (NIGHT8_DECISIONS §5). Once its fill plays, the restore replaces the scene and
    // the fill plays out its bar.
    const waiting = fillRef.current;
    if (isFillPending(waiting) && waiting.kind === 'into' && waiting.status !== 'playing') {
      void engine.cancelFill(waiting.requestId);
    }
    // Undo the scene immediately, through the same engine scheduler and smoothing
    // as a launch. A previous queued scene is replaced, so it cannot land later.
    requestLaunch('restoreScene', 0, before.mix, restore, 'now');
  }

  /** Switch on: Now, Next beat, Next bar, or Build (over the bars last chosen). */
  function setSceneTiming(value: Timing | 'build') {
    if (value === 'build') {
      setBuildBarsState(lastBuildBars.current);
      return;
    }
    setBuildBarsState(null);
    setSceneTimingState(value);
  }

  /** How many bars a build rises over; picking one also switches Build on. Remembered. */
  function setBuildBars(bars: BuildBars) {
    lastBuildBars.current = bars;
    setBuildBarsState(bars);
    writeChoice(PREF.riseBars, bars);
  }

  /** Finish with Fill: the next Rise ends with the track's fill. Remembered. */
  function setRiseFill(on: boolean) {
    setRiseFillState(on);
    writeChoice(PREF.riseFill, on ? 'on' : 'off');
  }

  /** Withdraw the queued launch. Says so if it had already landed. */
  function cancelQueuedScene() {
    const pending = isPending(sceneRequest) ? sceneRequest : null;
    if (!pending) return;
    const name = sceneName(pending.target);
    // A running build glides back to the mix it started from (`build cancelled`).
    const ask = pending.build ? engine.cancelBuild(pending.requestId) : engine.cancelScene(pending.requestId);
    void ask.then((cancelled) => {
      if (!cancelled && sceneRequestRef.current?.requestId === pending.requestId) {
        setSceneStatus(`${name} had already applied`);
      }
    });
  }

  /** The working mix, as a scene sees it: the base values the knobs show. */
  function workingMix(): SceneMix {
    const p = project ?? (track ? projectFromTrack(track) : null);
    if (!p) throw new Error('no track loaded');
    return copyMix({ params: p.params, stems: p.stems });
  }

  /**
   * Capture the working mix into a slot. Held effects are never part of the working
   * mix (they live in the engine), so a capture during a held echo stores the mix
   * underneath it.
   */
  function captureSceneSlot(slot: SceneSlotId) {
    if (!scenes) return;
    const working = workingMix();
    setScenes(captureScene(scenes, slot, working, patterns.sceneLanes()));
    if (activeScene?.slot === slot) setActiveScene({ slot, mix: working });
    setSceneStatus(`Captured the current mix into ${sceneName(slot)}`);
  }

  // ---- Compare A/B ------------------------------------------------------------

  /**
   * Capture the working mix into A or B. The first capture starts the comparison and
   * remembers the working mix as it was, for Exit Comparison.
   */
  function captureCompare(which: 'a' | 'b') {
    const working = workingMix();
    setCompare((c) => {
      const base: Compare = c ?? { a: null, b: null, listening: null, before: working, beforeActive: activeScene };
      // What is playing right after a capture is the mix just captured.
      return { ...base, [which]: working, listening: which };
    });
    setSceneStatus(`Captured the current mix as ${which.toUpperCase()}`);
  }

  /** Listen to A or B, on the same timing as a scene. Listening never overwrites it. */
  function listenCompare(which: 'a' | 'b') {
    const mix = compare?.[which];
    if (!mix || mixing) return;
    requestLaunch(which === 'a' ? 'compareA' : 'compareB', 0, mix);
  }

  /** Replace the stored A or B (the one being heard) with the working mix. */
  function updateCompare() {
    if (!compare?.listening) return;
    const which = compare.listening;
    setCompare({ ...compare, [which]: workingMix() });
    setSceneStatus(`Updated ${which.toUpperCase()}`);
  }

  /** Keep what is playing as the working mix and close the comparison. */
  function keepCompare() {
    // A listen (or Exit) still queued would land over the mix being kept.
    if (isPending(sceneRequest) && !isSceneSlot(sceneRequest.target)) cancelQueuedScene();
    setCompare(null);
    setSceneStatus('Kept the current mix');
  }

  /** Close the comparison and bring back the working mix from before it began. */
  function exitCompare() {
    if (!compare || mixing) return;
    requestLaunch('restore', 0, compare.before);
  }

  function renameSceneSlot(slot: SceneSlotId, name: string): boolean {
    if (!scenes) return false;
    const next = renameScene(scenes, slot, name);
    if (!next) return false;
    setScenes(next);
    return true;
  }

  function duplicateSceneSlot(from: SceneSlotId, to: SceneSlotId) {
    if (!scenes) return;
    setScenes(duplicateScene(scenes, from, to));
    setSceneStatus(`Copied ${sceneName(from)} into the ${sceneName(to)} slot`);
  }

  /** Crash on launch, on or off, for one slot: a project edit (one undo step), never automatic. */
  function setSceneCrashSlot(slot: SceneSlotId, crash: boolean) {
    if (!scenes) return;
    const next = setSceneCrash(scenes, slot, crash);
    if (next === scenes) return;
    setScenes(next);
    setSceneStatus(crash ? `${sceneName(slot)} crashes on launch` : `${sceneName(slot)} launches without a crash`);
  }

  function resetSceneSlot(slot: SceneSlotId) {
    if (!scenes || !track) return;
    const next = resetScene(scenes, slot, track);
    setScenes(next);
    // Named after the reset, so a slot that had been renamed reads by its own name.
    const name = next.slots.find((s) => s.slot === slot)?.name ?? slot;
    setSceneStatus(`${name} is back to its factory mix`);
  }

  // ---- Master and effects ------------------------------------------------

  function setBpm(value: number) {
    cancelTempoGlide();
    setBpmState(value);
    engine.setBpm(value);
  }

  function setSwing(value: number) {
    setSwingState(value);
    engine.setSwing(value);
  }

  function setMaster(value: number) {
    setMasterState(value);
    engine.setMaster(value);
  }

  function setBand(id: keyof Bands, value: number) {
    setBandsState((prev) => {
      const next = { ...prev, [id]: value };
      engine.setBands(next.low, next.mid, next.high);
      return next;
    });
  }

  function setEffect(id: EffectId, value: number) {
    setEffects((prev) => ({ ...prev, [id]: value }));
    EFFECT_SENDERS[id](value);
  }

  function setStemSend(id: StemId, value: number) {
    setSends((prev) => ({ ...prev, [id]: value }));
    engine.setSend(STEM_ORDER.indexOf(id), value);
  }

  function setFilter(value: number) {
    setFilterState(value);
    engine.setFilter(value);
  }

  function setStereo(value: number) {
    setStereoState(value);
    engine.setStereoBalance(value);
  }

  /** Pick an echo time; picking the lit one turns the echo off, as Loop does. */
  function pickEchoTime(beats: number) {
    const next = echoBeats === beats ? 0 : beats;
    setEchoBeatsState(next);
    engine.setEchoTime(next);
  }

  /**
   * Hear a bar: the explicit way to move the playhead to what is being edited. Jumps
   * the live deck to the bar and loops it; starts playback if stopped. Editing never
   * does this by itself. Pick the loop again to let the song run on.
   */
  async function auditionBar(barIndex: number) {
    if (mixing) return;
    if (!playing) {
      try {
        engine.clearError();
        await engine.play(liveDeck);
        setPlaying(true);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
    }
    engine.audition(barIndex);
    setLoopBarsState(1);
  }

  /** Pick a loop length; picking the lit one turns the loop off. */
  function pickLoop(bars: number) {
    const next = loopBars === bars ? 0 : bars;
    setLoopBarsState(next);
    engine.setLoop(next);
  }

  function brake() {
    engine.brake();
  }

  function backspin() {
    engine.backspin();
  }

  /** Bend the tempo while held: 1 up, -1 down, 0 to let go. */
  function nudge(dir: -1 | 0 | 1) {
    engine.nudge(dir);
  }

  // ---- Held effects (Echo Throw, Filter Hold) -----------------------------

  type HeldKind = 'echo' | 'filter';

  function clearHeld(kind: HeldKind) {
    const timer = leaseTimers.current[kind];
    if (timer !== null) window.clearInterval(timer);
    leaseTimers.current[kind] = null;
    heldTokens.current[kind] = null;
    setHeld((h) => (h[kind] ? { ...h, [kind]: false } : h));
  }

  /**
   * Begin a held effect. It is an override on top of the working mix: letting go
   * reveals whatever the mix is by then, including a scene launched while holding.
   * The engine's lease ends it if a release never arrives; holding renews it.
   */
  function holdEffect(kind: HeldKind) {
    if (mixing) { setSceneStatus('Held effects available after mix'); return; }
    if (heldTokens.current[kind] !== null) return;
    const token = nextToken.current++;
    heldTokens.current[kind] = token;
    setHeld((h) => ({ ...h, [kind]: true }));
    leaseTimers.current[kind] = window.setInterval(() => engine.gestureRenew(token), 1000);
    void engine
      .gestureBegin(token, kind === 'echo' ? GESTURE_KIND.echoThrow : GESTURE_KIND.filterHold)
      .then((accepted) => {
        if (!accepted && heldTokens.current[kind] === token) clearHeld(kind);
      });
  }

  /** End the held effect of this kind, and only that one. */
  function releaseEffect(kind: HeldKind) {
    const token = heldTokens.current[kind];
    if (token === null) return;
    engine.gestureEnd(token);
    clearHeld(kind);
  }

  /** Release FX: end every held effect. The working mix is left exactly as it is. */
  function releaseAllEffects() {
    engine.releaseGestures();
    clearHeld('echo');
    clearHeld('filter');
  }

  // A lease that ran out (a lost release, a frozen tab) shows as let go.
  useEffect(
    () =>
      engine.onSceneEvents((events) => {
        for (const e of events) {
          if (e.kind === EVENT.gestureExpired) {
            for (const kind of ['echo', 'filter'] as const) {
              if (heldTokens.current[kind] === e.requestId) clearHeldRef.current(kind);
            }
          }
        }
      }),
    [],
  );
  const clearHeldRef = useRef(clearHeld);
  clearHeldRef.current = clearHeld;

  // ---- Fill ------------------------------------------------------------------

  /** Fill at: the next bar, or the phrase's last bar. Remembered. */
  function setFillAt(at: FillAt) {
    setFillAtState(at);
    writeChoice(PREF.fillAt, at);
  }

  /** The phrase length a Phrase end fill ends on. Remembered. */
  function setPhraseBars(bars: PhraseBars) {
    setPhraseBarsState(bars);
    writeChoice(PREF.phraseBars, bars);
  }

  /**
   * The Fill button. First press queues the track's fill, for the next bar or the end of
   * the phrase (Fill at); a second press before it starts cancels it; a press while it
   * plays does nothing. A Fill into's or a Rise's fill is canceled from its own control.
   */
  function toggleFill() {
    const f = fillRef.current;
    if (isFillPending(f)) {
      if (f.kind === 'plain' && f.status !== 'playing') void engine.cancelFill(f.requestId);
      return;
    }
    if (!playing || mixing || !track?.fills?.length) return;
    const id = nextRequestId.current++;
    const phrase = fillPhrase(fillAt, phraseBars);
    setFill({ requestId: id, status: 'sending', kind: 'plain', phrase, from: songStepRef.current });
    engine.queueFill(id, FILL_INDEX, generations.current[liveDeck], phrase);
  }

  /**
   * Fill → Drop (docs/NIGHT8_PROTOCOL.md, Fill into): the fill at the current Fill at,
   * and the fourth scene slot landing on the onset it ends, as one request. Its lanes
   * ride along as a launch's do. Pressing it again cancels the whole request (or, once
   * the fill plays, the scene; the fill plays out its bar). A plain fill still waiting is
   * upgraded: withdrawn, and this queued in its place.
   */
  function toggleFillInto() {
    if (!scenes || mixing || !track?.fills?.length) return;
    const f = fillRef.current;
    if (isFillPending(f)) {
      if (f.kind === 'into') {
        void engine.cancelFill(f.requestId);
        return;
      }
      // A Rise's fill, or any fill already playing, holds the one slot until it ends.
      if (f.kind === 'rise' || f.status === 'playing') return;
    }
    const pending = isPending(sceneRequest) ? sceneRequest : null;
    if (pending?.target === 'restoreScene') return;
    const scene = scenes.slots.find((s) => s.slot === FILL_INTO_SLOT);
    if (!scene) return;
    if (!(engine.booted && playing)) {
      setSceneStatus(`Fill → ${scene.name} needs playback: press Play first`);
      return;
    }
    // The upgrade: the waiting plain fill goes first. The worklet takes messages in
    // order, so its slot is free by the time the Fill into arrives.
    if (isFillPending(f) && f.kind === 'plain') void engine.cancelFill(f.requestId);
    if (!beforeScenes.current || (!activeScene && !(pending && isSceneSlot(pending.target)))) {
      beforeScenes.current = { mix: workingMix(), patterns: patterns.sceneLanes(), changedLanes: new Set() };
    }
    const sets = Object.keys(scene.patterns).length ? scene.patterns : undefined;
    const fillId = nextRequestId.current++;
    const sceneId = nextRequestId.current++;
    const phrase = fillPhrase(fillAt, phraseBars);
    const request: SceneRequest = {
      requestId: sceneId,
      target: FILL_INTO_SLOT,
      revision: scene.revision,
      generation: generations.current[liveDeck],
      timing: 'bar',
      status: 'sending',
      mix: copyMix(scene),
      fillInto: { fillId },
      ...(sets ? { lanes: sets } : {}),
    };
    sceneRequestRef.current = request;
    setSceneRequest(request);
    setFill({ requestId: fillId, status: 'sending', kind: 'into', phrase, from: songStepRef.current, partner: sceneId });
    // Compiled now, as for a launch, so the lanes that land are the ones pressed for.
    const data = sets ? patterns.scenePayload(sets) : undefined;
    engine.queueFillInto(fillId, sceneId, FILL_INDEX, sceneVector(request.mix), request.generation, {
      phrase,
      accent: scene.crash ? SCENE_ACCENT.crash : SCENE_ACCENT.none,
      ...(data ? { patterns: { requestId: nextRequestId.current++, data } } : {}),
    });
  }

  /**
   * One fill event (kinds 11-15, 51, 52) for the fill the host follows. A plain fill
   * speaks on the status line for itself; a linked one only says when it starts
   * ("Filling into Drop"), and its scene or Rise says the rest. Unlinked, it is a plain
   * fill from then on.
   */
  function onFillEvent(e: WireEvent) {
    const f = fillRef.current;
    if (!f || e.requestId !== f.requestId) return;
    const next = foldFillJob(f, { kind: e.kind, id: e.requestId, a: e.a, b: e.b }, songStepRef.current);
    if (next === f) return;
    setFill(next);
    const linked = f.kind !== 'plain' && e.kind !== EVENT.fillUnlinked;
    if (linked) {
      const r = sceneRequestRef.current;
      if (e.kind === EVENT.fillStarted && r && r.requestId === next.partner && isPending(r)) {
        const filling = markFilling(r, next.requestId);
        if (filling !== r) {
          sceneRequestRef.current = filling;
          setSceneRequest(filling);
          setSceneStatus(`Filling into ${sceneName(r.target)}`);
        }
      }
      return;
    }
    if (e.kind === EVENT.fillQueued) setSceneStatus(fillQueuedStatus(next));
    if (e.kind === EVENT.fillStarted) setSceneStatus('Fill playing');
    if (e.kind === EVENT.fillCancelled) {
      const message = e.a === 10 ? 'Fill cancelled' : `Fill cancelled: ${REASON[e.a] ?? ''}`;
      setSceneStatus((previous) => previous.includes('cancelled') ? `${previous} · ${message}` : message);
    }
    if (e.kind === EVENT.fillRejected) setSceneStatus(`Fill not started: ${fillRefusal(e.a)}`);
  }
  const fillEventRef = useRef(onFillEvent);
  fillEventRef.current = onFillEvent;

  // ---- Panic -----------------------------------------------------------------

  /**
   * Panic: stop, and leave nothing behind. Cancels anything queued, releases every
   * held effect, clears the echo and room tails, and abandons a running mix. Not the
   * same as Cancel scene, which restores the mix without stopping playback.
   */
  function panic() {
    engine.panic();
    cancelTempoGlide();
    clearHeld('echo');
    clearHeld('filter');
    setFill(null);
    setSceneRequest((r) => (isPending(r) ? { ...r, status: 'cancelled', reason: 5 } : r));
    setPlaying(false);
    setMixing(null);
    setSceneStatus('Panic: stopped, nothing queued, effects released');
  }

  // ---- The project the screen describes -----------------------------------

  /**
   * Accepted composition only. Pending auditions and performance state stay out
   * of persistence and export.
   */
  const project: Project | null = useMemo(() => {
    if (!track || !vols) return null;
    const p = projectFromTrack(track);
    p.params['transport.bpm'] = bpm;
    p.params['transport.swing'] = swing;
    p.params['master.level'] = master;
    p.params['fx.low'] = bands.low;
    p.params['fx.mid'] = bands.mid;
    p.params['fx.high'] = bands.high;
    p.params['fx.filter'] = filter;
    p.params['fx.stereo'] = stereo;
    p.params['fx.echoTime'] = echoBeats;
    for (const id of Object.keys(effects) as EffectId[]) p.params[id] = effects[id];
    for (const id of STEM_ORDER) {
      p.stems[id] = { volume: vols[id], send: sends[id], muted: muted[id], solo: solo[id] };
    }
    p.patterns = patterns.working;
    p.locks = patterns.locks;
    if (scenes) p.scenes = scenes;
    return p;
  }, [track, vols, sends, bpm, swing, master, bands, filter, stereo, effects, echoBeats, muted, solo, patterns.working, patterns.locks, scenes]);

  // The checks read the project as a save would write it, and round-trip it.
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => {
    window.__BCKGRND_PROJECT__ = () => projectRef.current;
  }, []);

  const edited = project && track ? !sameMusic(project, projectFromTrack(track)) : false;
  const projectHistory = useProjectHistory(project, historyEpoch, !!mixing || !!patterns.preview || !!compare?.listening || isPending(sceneRequest), patterns.undoLabel, (p) => {
    setBpm(p.params['transport.bpm']); setSwing(p.params['transport.swing']); setMaster(p.params['master.level']);
    setScenes(structuredClone(p.scenes));
    const lanes: ScenePatterns = {};
    for (const lane of LANE_IDS) lanes[lane] = p.patterns[lane] ?? { factory: true };
    requestLaunch('restoreScene', 0, p, lanes, 'now');
    showMix(p);
    patterns.restore(track!, p.patterns, p.locks);
  });
  const activeLanes = activeScene ? scenes?.slots.find((s) => s.slot === activeScene.slot)?.patterns : undefined;
  const sceneModified =
    activeScene !== null &&
    project !== null &&
    (!sameMix({ params: project.params, stems: project.stems }, activeScene.mix) ||
      (activeLanes !== undefined && patterns.differsFrom(activeLanes)));

  // Why Fill or Fill → Drop can't be pressed now, or null. The one fill slot is the
  // engine's: a Rise's fill holds it until it has played, and so does any fill playing.
  const fillIntoName = sceneName(FILL_INTO_SLOT);
  const busyFill = isFillPending(fill) ? fill : null;
  const needsPlay = mixing ? 'Available after mix' : !playing ? 'Press play first: a fill needs playback' : null;
  const riseHoldsFill = busyFill?.kind === 'rise' ? 'The Rise ends with a fill' : null;
  const fillUnavailable =
    needsPlay ??
    riseHoldsFill ??
    (busyFill?.kind === 'into'
      ? busyFill.status === 'playing'
        ? `Filling into ${fillIntoName}`
        : `Fill → ${fillIntoName} is queued: press it again to cancel`
      : null);
  const fillIntoUnavailable =
    needsPlay ??
    (isPending(sceneRequest) && sceneRequest.target === 'restoreScene' ? 'Restoring previous mix' : null) ??
    riseHoldsFill ??
    (busyFill && busyFill.kind === 'plain' && busyFill.status === 'playing' ? 'Available when the fill ends' : null);

  const actions = useStable({
    togglePlay,
    selectTrack,
    openProject,
    cue,
    setNextId,
    autoMix,
    setContinuous,
    applyMask,
    toggleMute,
    toggleSolo,
    setStemVolume,
    setStemSend,
    setBpm,
    setSwing,
    setMaster,
    setBand,
    setFilter,
    setStereo,
    setEffect,
    pickEchoTime,
    pickLoop,
    auditionBar,
    holdEffect,
    releaseEffect,
    releaseAllEffects,
    toggleFill,
    toggleFillInto,
    setFillAt,
    setPhraseBars,
    setRiseFill,
    panic,
    brake,
    backspin,
    nudge,
    setSceneTiming,
    setBuildBars,
    launchScene,
    cancelQueuedScene,
    cancelScene,
    captureSceneSlot,
    renameSceneSlot,
    duplicateSceneSlot,
    resetSceneSlot,
    setSceneCrashSlot,
    captureCompare,
    listenCompare,
    updateCompare,
    keepCompare,
    exitCompare,
  });

  return {
    // data
    library,
    error,
    track,
    cued,
    tracks,
    playing,
    songStep,
    bar,
    liveDeck,
    mixing,
    nextId,
    continuous,
    // stems
    vols,
    sends,
    muted,
    solo,
    mask,
    // master and effects
    bpm,
    swing,
    master,
    bands,
    filter,
    stereo,
    effects,
    echoBeats,
    /** An Echo Throw is being held (a temporary override, not the mix). */
    echo: held.echo,
    /** A Filter Hold is being held. */
    filterHeld: held.filter,
    loopBars,
    // project
    project,
    edited,
    patterns: { ...patterns, ...projectHistory },
    // scenes
    scenes,
    activeScene: activeScene?.slot ?? null,
    sceneModified,
    sceneRequest,
    sceneRestoring: isPending(sceneRequest) && sceneRequest.target === 'restoreScene',
    sceneTiming,
    /** Build mode's bar count, or null when a pad press switches on one onset. */
    buildBars,
    sceneStatus,
    /** The fill the engine holds (plain, a Fill into's or a Rise's), or null. */
    fill,
    fillName: track?.fills?.[FILL_INDEX]?.name ?? 'Fill',
    hasFill: Boolean(track?.fills?.length),
    /** Fill at, the phrase length and Finish with Fill: app preferences. */
    fillAt,
    phraseBars,
    riseFill,
    /** The name of the scene Fill → Drop leads into (the fourth slot, as named now). */
    fillIntoName,
    fillUnavailable,
    fillIntoUnavailable,
    compare,
    compareModified:
      compare?.listening != null &&
      project !== null &&
      compare[compare.listening] !== null &&
      !sameMix({ params: project.params, stems: project.stems }, compare[compare.listening]!),
    // intents, each with one identity for the life of the app
    ...actions,
  };
}

export type Instrument = ReturnType<typeof useInstrument>;
