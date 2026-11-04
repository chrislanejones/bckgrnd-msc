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
import { engine, GESTURE_KIND, SCENE_TIMING } from './engine';
import type { Deck as DeckId, EngineEvent as WireEvent } from './engine';
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
  captureScene,
  copyMix,
  duplicateScene,
  factoryScenes,
  foldSceneEvent,
  isPending,
  isSceneSlot,
  renameScene,
  resetScene,
  sameMix,
  sceneVector,
  type Compare,
  type SceneMix,
  type SceneRequest,
  type Timing,
} from './scenes';
import { STEM_ORDER, STEPS } from './stems';
import type { LibraryResponse, Mix, StemId, TrackArrangement, TrackSummary } from './types';

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

  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(-1);
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

  // ---- Scenes ---------------------------------------------------------------
  /** The four stored scene slots for the live track (part of the project). */
  const [scenes, setScenes] = useState<Scenes | null>(null);
  /**
   * The slot the engine last applied, with the exact mix it applied, so a knob moved
   * afterwards reads as "Modified" until the slot is explicitly overwritten. Session
   * state: never saved, cleared by a track change.
   */
  const [activeScene, setActiveScene] = useState<{ slot: SceneSlotId; mix: SceneMix } | null>(null);
  /** The latest launch request, pending or just settled. */
  const [sceneRequest, setSceneRequest] = useState<SceneRequest | null>(null);
  const sceneRequestRef = useRef<SceneRequest | null>(null);
  sceneRequestRef.current = sceneRequest;
  const [sceneTiming, setSceneTiming] = useState<Timing>('bar');
  /** One line for assistive technology: discrete changes only, never every beat. */
  const [sceneStatus, setSceneStatus] = useState('');
  const nextRequestId = useRef(1);
  /** Compare A/B, or null when not comparing. Session-only. */
  const [compare, setCompare] = useState<Compare | null>(null);

  // ---- Fill and held effects ----------------------------------------------
  /** The one-bar fill: idle, sent, queued for a bar, or playing its bar. */
  const [fill, setFill] = useState<{ status: 'idle' | 'sending' | 'queued' | 'playing'; id: number; bar?: number }>({
    status: 'idle',
    id: 0,
  });
  const fillRef = useRef(fill);
  fillRef.current = fill;
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
        setPlaying(t.playing);
        setStep(t.step);
      }),
    [],
  );

  // A fault on the audio thread is otherwise silent, so surface it.
  useEffect(() => engine.onError(setError), []);

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
    void (async () => {
      try {
        const arranged = await loadArrangement(summary.id);
        if (!arranged) return;
        cancelTempoGlide();
        const deck = liveDeck;
        engine.stop(deck);
        loadDeck(deck, arranged);
        engine.setMuted(0, false);
        setTrack(arranged);
        resetScenesFor(arranged);
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
    const p = mix.params;
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
  // the request's status and the one-line announcement.
  useEffect(
    () =>
      engine.onSceneEvents((events: readonly WireEvent[]) => {
        for (const e of events) {
          if (e.kind < EVENT.sceneQueued || e.kind > EVENT.sceneRejected) continue;
          const current = sceneRequestRef.current;
          if (!current || current.requestId !== e.requestId) continue;
          const next = foldSceneEvent(current, { kind: e.kind, id: e.requestId, a: e.a, b: e.b });
          if (next === current) continue;
          sceneRequestRef.current = next;
          setSceneRequest(next);
          const name = sceneNameRef.current(next.target);
          if (next.status === 'queued') {
            setSceneStatus(next.timing === 'now' ? `${name} queued` : `${name} queued for bar ${next.bar}`);
          } else if (next.status === 'applied') {
            landedRef.current(next);
            showMixRef.current(next.mix);
            setSceneStatus(next.target === 'restore' ? 'Comparison closed; the earlier mix is back' : `${name} active`);
          } else if (next.status === 'cancelled') {
            // A cancel the user asked for needs no reason; any other says what did it.
            const why = next.reason === undefined || next.reason === 10 ? '' : `: ${REASON[next.reason] ?? ''}`;
            setSceneStatus(`${name} cancelled${why}`);
          } else if (next.status === 'rejected') {
            setSceneStatus(`${name} not launched: ${REASON[next.reason ?? 1] ?? 'refused'}`);
          }
        }
      }),
    [],
  );
  // The subscription above lives for the app; it reads these through refs.
  const showMixRef = useRef(showMix);
  showMixRef.current = showMix;
  const sceneNameRef = useRef(sceneName);
  sceneNameRef.current = sceneName;

  /** What an applied launch means for the active scene and the comparison. */
  function landed(request: SceneRequest) {
    const t = request.target;
    if (isSceneSlot(t)) {
      setActiveScene({ slot: t, mix: request.mix });
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
  function requestLaunch(target: SceneRequest['target'], revision: number, mix: SceneMix) {
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
        timing: sceneTiming,
        status: 'applied',
        mix: now,
      });
      setSceneStatus(target === 'restore' ? 'Comparison closed; the earlier mix is back' : `${sceneName(target)} active`);
      return;
    }
    const requestId = nextRequestId.current++;
    const deck = liveDeck;
    const request: SceneRequest = {
      requestId,
      target,
      revision,
      generation: generations.current[deck],
      timing: sceneTiming,
      status: 'sending',
      mix: copyMix(mix),
    };
    sceneRequestRef.current = request;
    setSceneRequest(request);
    engine.queueScene(requestId, SCENE_TIMING[sceneTiming], sceneVector(request.mix), request.generation);
  }

  /**
   * A pad press. Launches the slot; pressing the slot that is already queued cancels
   * it; pressing the active, unmodified scene does nothing. Never saves anything.
   */
  function launchScene(slot: SceneSlotId) {
    if (!scenes || mixing) return;
    const pending = isPending(sceneRequest) ? sceneRequest : null;
    if (pending && pending.target === slot) {
      cancelQueuedScene();
      return;
    }
    if (!pending && activeScene?.slot === slot && sameMix(workingMix(), activeScene.mix)) return;
    const scene = scenes.slots.find((s) => s.slot === slot);
    if (!scene) return;
    requestLaunch(slot, scene.revision, scene);
  }

  /** Withdraw the queued launch. Says so if it had already landed. */
  function cancelQueuedScene() {
    const pending = isPending(sceneRequest) ? sceneRequest : null;
    if (!pending) return;
    const name = sceneName(pending.target);
    void engine.cancelScene(pending.requestId).then((cancelled) => {
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
    setScenes(captureScene(scenes, slot, working));
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
    if (mixing || heldTokens.current[kind] !== null) return;
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

  /**
   * The Fill button. First press queues the track's fill for the next bar; a second
   * press before it starts cancels it; a press while it plays does nothing.
   */
  function toggleFill() {
    const f = fillRef.current;
    if (f.status === 'playing') return;
    if (f.status === 'sending' || f.status === 'queued') {
      void engine.cancelFill(f.id);
      return;
    }
    if (!playing || mixing || !track?.fills?.length) return;
    const id = nextRequestId.current++;
    setFill({ status: 'sending', id });
    engine.queueFill(id, 0, generations.current[liveDeck]);
  }

  useEffect(
    () =>
      engine.onSceneEvents((events) => {
        for (const e of events) {
          if (e.kind < EVENT.fillQueued || e.kind > EVENT.fillRejected) continue;
          const f = fillRef.current;
          if (e.requestId !== f.id) continue;
          let next = f;
          if (e.kind === EVENT.fillQueued) next = { ...f, status: 'queued', bar: e.a };
          else if (e.kind === EVENT.fillStarted) next = { ...f, status: 'playing' };
          else next = { status: 'idle', id: f.id };
          fillRef.current = next;
          setFill(next);
          if (e.kind === EVENT.fillQueued) setSceneStatus(`Fill queued for bar ${e.a}`);
          if (e.kind === EVENT.fillStarted) setSceneStatus('Fill playing');
          if (e.kind === EVENT.fillCancelled) {
            setSceneStatus(e.a === 10 ? 'Fill cancelled' : `Fill cancelled: ${REASON[e.a] ?? ''}`);
          }
          if (e.kind === EVENT.fillRejected) setSceneStatus(`Fill not started: ${REASON[e.a] ?? 'refused'}`);
        }
      }),
    [],
  );

  // ---- Panic -----------------------------------------------------------------

  /**
   * Panic: stop, and leave nothing behind. Cancels anything queued, releases every
   * held effect, clears the echo and room tails, and abandons a running mix. Not the
   * same as Cancel queued, which only withdraws the next launch.
   */
  function panic() {
    engine.panic();
    cancelTempoGlide();
    clearHeld('echo');
    clearHeld('filter');
    setFill({ status: 'idle', id: fillRef.current.id });
    setSceneRequest((r) => (isPending(r) ? { ...r, status: 'cancelled', reason: 5 } : r));
    setPlaying(false);
    setMixing(null);
    setSceneStatus('Panic: stopped, nothing queued, effects released');
  }

  // ---- The project the screen describes -----------------------------------

  /**
   * The current mix as a project. Nothing saves it yet; it is what the save
   * indicator compares against the track as written, so the transport can say
   * truthfully whether there is anything a reload would lose.
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
    return p;
  }, [track, vols, sends, bpm, swing, master, bands, filter, stereo, effects, echoBeats, muted, solo]);

  const edited = project && track ? !sameMusic(project, projectFromTrack(track)) : false;
  const sceneModified =
    activeScene !== null && project !== null && !sameMix({ params: project.params, stems: project.stems }, activeScene.mix);

  const actions = useStable({
    togglePlay,
    selectTrack,
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
    holdEffect,
    releaseEffect,
    releaseAllEffects,
    toggleFill,
    panic,
    brake,
    backspin,
    nudge,
    setSceneTiming,
    launchScene,
    cancelQueuedScene,
    captureSceneSlot,
    renameSceneSlot,
    duplicateSceneSlot,
    resetSceneSlot,
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
    // scenes
    scenes,
    activeScene: activeScene?.slot ?? null,
    sceneModified,
    sceneRequest,
    sceneTiming,
    sceneStatus,
    fill,
    fillName: track?.fills?.[0]?.name ?? 'Fill',
    hasFill: Boolean(track?.fills?.length),
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
