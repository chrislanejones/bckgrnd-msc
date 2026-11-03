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
import { engine } from './engine';
import type { Deck as DeckId } from './engine';
import { emptyFlags, fetchLibrary, fetchTrack } from './api';
import { fixedDefault, projectFromTrack, sameMusic, type ProjectV1 } from './contract';
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
  const [echo, setEchoState] = useState(false);
  /** Output balance: 0 mono-left, 0.5 stereo, 1 mono-right. */
  const [stereo, setStereoState] = useState(0.5);
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
        engine.loadTrack('a', arranged);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [library, loadArrangement]);

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
        engine.loadTrack(deck, arranged);
        setCued(arranged);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
    // `liveDeck` decides which deck is idle, so a handover has to re-run this.
  }, [nextId, track?.id, liveDeck, loadArrangement]);

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
        engine.loadTrack(deck, arranged);
        engine.setMuted(0, false);
        setTrack(arranged);
        setBpmState(arranged.bpm);
        engine.setBpm(arranged.bpm);
        setSwingState(arranged.swing);
        engine.setSwing(arranged.swing);
        setVols(arranged.mix);
        for (let i = 0; i < STEM_ORDER.length; i += 1) {
          engine.setVolume(i, arranged.mix[STEM_ORDER[i]!]);
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
        engine.loadTrack(incoming, arranged);
        setCued(arranged);
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
        engine.mix(incoming, arranged, bpm, swing, () => {
          setMixing(null);
          setTrack(arranged);
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
          for (let i = 0; i < STEM_ORDER.length; i += 1) {
            engine.setVolume(i, arranged.mix[STEM_ORDER[i]!]);
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
        });
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
    const next = { ...bands, [id]: value };
    setBandsState(next);
    engine.setBands(next.low, next.mid, next.high);
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

  function toggleEchoThrow() {
    const next = !echo;
    setEchoState(next);
    engine.setEcho(next);
  }

  // ---- The project the screen describes -----------------------------------

  /**
   * The current mix as a version 1 project. Nothing saves it yet; it is what the save
   * indicator compares against the track as written, so the transport can say
   * truthfully whether there is anything a reload would lose.
   */
  const project: ProjectV1 | null = useMemo(() => {
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
    for (const id of STEM_ORDER) p.stems[id] = { volume: vols[id], muted: muted[id], solo: solo[id] };
    return p;
  }, [track, vols, bpm, swing, master, bands, filter, stereo, echoBeats, muted, solo]);

  const edited = project && track ? !sameMusic(project, projectFromTrack(track)) : false;

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
    echoBeats,
    echo,
    loopBars,
    // project
    project,
    edited,
    // intents
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
    setBpm,
    setSwing,
    setMaster,
    setBand,
    setFilter,
    setStereo,
    pickEchoTime,
    pickLoop,
    toggleEchoThrow,
    brake,
    backspin,
    nudge,
  };
}

export type Instrument = ReturnType<typeof useInstrument>;
