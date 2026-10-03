/**
 * The stem machine.
 *
 * Structure follows the original deck: a transport and song position at the top,
 * the track library, then a row per stem with a meter, a step pattern and a fader,
 * and the deck gestures (brake, backspin, echo, loop, isolators, tempo) below.
 *
 * What changed from the browser original:
 *
 * - **No `AudioContext` here.** All audio state lives in the worklet; this component
 *   renders meters and sends intent. That is the whole reason the engine moved to
 *   Rust — the UI thread no longer competes with the audio graph.
 * - **The library comes from Laravel.** Tracks are fetched as arranged JSON rather
 *   than bundled, so song form lives on the server.
 * - **No `setInterval` metering.** Telemetry arrives from the worklet at ~30 Hz.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AudioLines,
  CircleDot,
  Music2,
  Orbit,
  Play,
  Radio,
  Square,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { engine } from './lib/engine';
import type { Deck as DeckId } from './lib/engine';
import { barActivity, emptyFlags, fetchLibrary, fetchTrack } from './lib/api';
import type {
  LibraryResponse,
  Mix,
  StemId,
  TrackArrangement,
  TrackSummary,
} from './lib/types';

const ICONS: Record<StemId, LucideIcon> = {
  kick: CircleDot,
  clap: AudioLines,
  hats: Activity,
  bass: Waves,
  stab: Zap,
  lead: Music2,
  pad: Radio,
  arp: Orbit,
};

const STEM_ORDER: StemId[] = [
  'kick',
  'clap',
  'hats',
  'bass',
  'stab',
  'lead',
  'pad',
  'arp',
];

const LOOP_BARS = [1, 2, 4, 8, 16] as const;
const PARTS = ['Intro', 'Groove', 'Break', 'Drop'];
const STEPS = 256;

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

/** The order a stem-swapping continuous mix steps the groups through. */
const CONTINUOUS_MASKS: Mask[] = ['full', 'nodrums', 'nomusic'];

/** Off, or running with or without the stem swap. */
type ContinuousMode = 'off' | 'swap' | 'plain';

type LoopBars = 0 | (typeof LOOP_BARS)[number];
type Mask = 'full' | 'nodrums' | 'nomusic' | 'custom';

/**
 * The balance fader reads out in words rather than a number: the useful positions are
 * the two ends and the centre, and "0.62" says nothing about what you are hearing.
 */
function stereoLabel(balance: number): string {
  if (balance <= 0.02) return 'Left';
  if (balance >= 0.98) return 'Right';
  if (Math.abs(balance - 0.5) <= 0.02) return 'Stereo';
  return balance < 0.5
    ? `Left ${Math.round((0.5 - balance) * 200)}%`
    : `Right ${Math.round((balance - 0.5) * 200)}%`;
}

function cx(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(' ');
}

/** Paint the mute flags for a group shortcut. */
function paintMutes(mask: Mask, drums: StemId[], music: StemId[]): Record<StemId, boolean> {
  const flags = emptyFlags();
  if (mask === 'nodrums') for (const id of drums) flags[id] = true;
  if (mask === 'nomusic') for (const id of music) flags[id] = true;
  return flags;
}

export function App() {
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [track, setTrack] = useState<TrackArrangement | null>(null);

  const [playing, setPlaying] = useState(false);
  const [step, setStep] = useState(-1);
  const [bpm, setBpm] = useState(126);
  const [swing, setSwing] = useState(0.22);
  const [master, setMaster] = useState(0.78);
  const [vols, setVols] = useState<Mix | null>(null);
  const [muted, setMuted] = useState(emptyFlags);
  const [solo, setSolo] = useState(emptyFlags);
  const [mask, setMask] = useState<Mask>('full');
  const [loopBars, setLoopBars] = useState<LoopBars>(0);
  const [bands, setBands] = useState({ low: 1, mid: 1, high: 1 });
  const [open, setOpen] = useState(1);
  const [echo, setEcho] = useState(false);
  const [backspinOn, setBackspinOn] = useState(false);
  /** Output balance: 0 mono-left, 0.5 stereo, 1 mono-right. */
  const [stereo, setStereo] = useState(0.5);
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

  // Meters come from the audio thread at ~30 Hz. Keeping them out of React state
  // avoids a re-render per frame; they are written straight to the DOM instead.
  const meterRefs = useRef<Array<HTMLSpanElement | null>>([]);

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

  /** Load a track's arrangement into a deck, memoised per track. */
  const loadArrangement = useCallback(
    async (id: string): Promise<TrackArrangement | null> => {
      const cached = arrangementCache.current.get(id);
      if (cached) return cached;
      const { track: arranged } = await fetchTrack(id);
      arrangementCache.current.set(id, arranged);
      return arranged;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const first = library?.tracks[0];
    if (!first) return;
    loadArrangement(first.id)
      .then((arranged) => {
        if (!arranged || cancelled) return;
        setTrack(arranged);
        setBpm(arranged.bpm);
        setSwing(arranged.swing);
        setVols(arranged.mix);
        engine.loadTrack('a', arranged);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [library, loadArrangement]);

  /**
   * Keep the idle deck loaded with whatever is in Next, and keep its waveform drawn.
   *
   * Both decks show a track from the first paint: A is the one playing, B is the one
   * an auto mix would bring in. Before this, `cued` was only set by an explicit cue,
   * so deck B sat empty on startup even though Next already named a track and the Auto
   * mix button would have used it.
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

  // Telemetry → meters and the playhead.
  useEffect(
    () =>
      engine.subscribe((t) => {
        setPlaying(t.playing);
        setStep(t.step);
        for (let i = 0; i < 8; i += 1) {
          const el = meterRefs.current[i];
          if (el) el.style.transform = `scaleX(${Math.max(0.035, t.levels[i] ?? 0)})`;
        }
      }),
    [],
  );

  // A fault on the audio thread is otherwise silent, so surface it.
  useEffect(() => engine.onError(setError), []);

  const songStep = step < 0 ? -1 : step % STEPS;
  const bar = songStep < 0 ? 0 : Math.floor(songStep / 16);
  const col = songStep < 0 ? -1 : songStep % 16;
  const anySolo = STEM_ORDER.some((id) => solo[id]);

  /**
   * Which stems are not sounding: cut outright, or dropped because something else is
   * soloed. The same rule the stem strips use for their own cut state.
   */
  const silenced = useMemo(
    () =>
      Object.fromEntries(
        STEM_ORDER.map((id) => [id, Boolean(muted[id]) || (anySolo && !solo[id])]),
      ) as Record<StemId, boolean>,
    [muted, solo, anySolo],
  );

  const tracks = library?.tracks ?? [];
  const edmTracks = useMemo(
    () => tracks.filter((t) => t.kind !== 'lofi'),
    [tracks],
  );
  const lofiTracks = useMemo(() => tracks.filter((t) => t.kind === 'lofi'), [tracks]);

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
   * Picking a track is a deliberate act, so it starts the transport. This used to stop
   * the deck to load it and then leave it stopped, so the first track you clicked never
   * played — you had to reach for the play button afterwards, and switching tracks
   * mid-set silently killed the music. Nothing starts on page load; it takes this
   * click, or the play button.
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
        setBpm(arranged.bpm);
        engine.setBpm(arranged.bpm);
        setSwing(arranged.swing);
        engine.setSwing(arranged.swing);
        setVols(arranged.mix);
        for (let i = 0; i < STEM_ORDER.length; i += 1) {
          engine.setVolume(i, arranged.mix[STEM_ORDER[i]]);
          engine.setMuted(i, false);
          engine.setSolo(i, false);
        }
        const clear = emptyFlags();
        setMuted(clear);
        setSolo(clear);
        setMask('full');
        setLoopBars(0);
        engine.setLoop(0);

        engine.clearError();
        await engine.play(deck);
        setPlaying(true);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }

  /** The deck that is loaded but silent — the one a mix will hand over to. */
  function idleDeck(): DeckId {
    return liveDeck === 'a' ? 'b' : 'a';
  }

  /**
   * Choosing what plays next. The deck itself is loaded by the effect below, which
   * follows `nextId` wherever it is set from — this dropdown, or the handover at the
   * end of a mix.
   */
  function cueNext(id: string) {
    setNextId(id);
  }

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
          engine.setVolume(i, vols?.[STEM_ORDER[i]] ?? 0.8);
          engine.setMuted(i, Boolean(muted[STEM_ORDER[i]]));
          engine.setSolo(i, Boolean(solo[STEM_ORDER[i]]));
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

          // Everything below sets the engine as well as the screen. This callback used
          // to update React state alone, so after every mix the display described a
          // different session from the one playing: the new track's tempo and default
          // faders on screen, the old tempo, faders and cuts still running underneath.
          //
          // Tempo glides rather than jumps. The incoming deck was matched to the
          // outgoing tempo for the crossfade, which is what kept the beats together;
          // snapping it to its own tempo the moment the fade ended would be an audible
          // lurch, so it eases across a few bars instead.
          glideTempo(bpm, arranged.bpm, TEMPO_GLIDE_SECONDS);
          setSwing(arranged.swing);
          engine.setSwing(arranged.swing);
          setVols(arranged.mix);
          for (let i = 0; i < STEM_ORDER.length; i += 1) {
            engine.setVolume(i, arranged.mix[STEM_ORDER[i]]);
            engine.setSolo(i, false);
          }
          setSolo(emptyFlags());

          // A continuous mix steps the stem groups on at each handover; a one-off auto
          // mix lands on the full track, which is what you want when you pressed the
          // button yourself.
          if (continuousRef.current === 'swap') {
            maskStep.current = (maskStep.current + 1) % CONTINUOUS_MASKS.length;
            applyMask(CONTINUOUS_MASKS[maskStep.current] ?? 'full');
          } else {
            setMuted(emptyFlags());
            setMask('full');
            for (let i = 0; i < STEM_ORDER.length; i += 1) engine.setMuted(i, false);
          }
          // The deck that just went live holds `arranged` now, so it must stop being
          // described as "cued" or the panel will show the same track on both decks.
          // Pointing Next at the following track re-cues the deck that just went idle,
          // via the effect that follows `nextId`.
          setCued(null);
          setNextId(tracks.find((t) => t.id !== arranged.id)?.id ?? arranged.id);
        });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }

  /**
   * Continuous mix.
   *
   * Hands over to whatever is in Next once the playhead reaches the last section, so
   * the crossfade has a phrase to land on and the set never stops. Each handover also
   * steps the stem groups on — full mix, no drums, no music — which is what turns a
   * run of tracks into one extended mix rather than a playlist: the drums carry the
   * seam, then the music comes back over the new track.
   */
  const autoMixRef = useRef<() => void>(() => {});
  /** Re-armed once the playhead is back before the trigger, so each pass fires once. */
  const armed = useRef(true);
  /** Where the group cycle has got to, and whether it should run at all. */
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
   * Ease the tempo from `from` to `to` over `seconds`, in small steps.
   *
   * The engine takes a tempo and the screen shows one, so this drives both together;
   * a smoothstep keeps the start and end of the move gentle. Any other tempo gesture
   * (the slider, loading a track, starting another mix) cancels it first, so the glide
   * never fights the hand on the control.
   */
  function glideTempo(from: number, to: number, seconds: number) {
    cancelTempoGlide();
    if (Math.abs(to - from) < 0.5) {
      engine.setBpm(to);
      setBpm(Math.round(to));
      return;
    }
    const started = performance.now();
    tempoGlide.current = window.setInterval(() => {
      const t = Math.min(1, (performance.now() - started) / (seconds * 1000));
      const eased = t * t * (3 - 2 * t);
      const value = from + (to - from) * eased;
      engine.setBpm(value);
      setBpm(Math.round(value));
      if (t >= 1) cancelTempoGlide();
    }, 200);
  }

  function applyMask(next: Mask) {
    const flags = paintMutes(next, library?.drums ?? [], library?.music ?? []);
    const clear = emptyFlags();
    setMask(next);
    setMuted(flags);
    setSolo(clear);
    for (let i = 0; i < STEM_ORDER.length; i += 1) {
      engine.setMuted(i, Boolean(flags[STEM_ORDER[i]]));
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

  function setStemVol(id: StemId, value: number) {
    setVols((prev) => {
      const next = { ...(prev ?? ({} as Mix)), [id]: value };
      engine.setVolume(STEM_ORDER.indexOf(id), value);
      return next;
    });
  }

  // Space toggles transport, 1–8 cut a stem. Ignored while a slider has focus so
  // arrow keys still work.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void togglePlay();
        return;
      }
      const n = Number(event.key);
      if (n >= 1 && n <= 8) {
        const id = STEM_ORDER[n - 1];
        if (id) toggleMute(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg p-6 text-fg">
        <div className="max-w-md text-center">
          <h1 className="font-display text-2xl font-extrabold">bckgrnd-msc could not start</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <p className="mt-4 text-xs text-muted">
            The audio engine is a WebAssembly module; if this is a packaged build, check
            that <code>public/wasm</code> and <code>public/build</code> were copied in.
          </p>
        </div>
      </main>
    );
  }

  if (!library || !track || !vols) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg text-fg">
        <p className="text-sm text-muted">Loading the library…</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-bg text-fg" data-playing={playing ? 'yes' : 'no'}>
      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 sm:px-8 sm:py-6">
        <header className="rise flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-widest text-acid">STEM MACHINE</p>
            <h1 className="mt-1 font-display text-4xl font-extrabold leading-none sm:text-5xl">
              bckgrnd-msc
            </h1>
            <p className="mt-2 max-w-md text-sm leading-snug text-pretty text-muted">
              Cut any stem. The rest of the instrumental keeps playing.
            </p>
          </div>
          <button
            type="button"
            className="tap grid size-16 shrink-0 place-items-center rounded-full bg-acid text-acid-ink"
            aria-label={playing ? 'Stop the track' : 'Play the track'}
            aria-pressed={playing}
            onClick={() => void togglePlay()}
          >
            <span className="grid place-items-center">
              <Play
                className="icon-swap size-7"
                data-on={playing ? 'false' : 'true'}
                strokeWidth={2.4}
                aria-hidden
              />
              <Square
                className="icon-swap size-5"
                data-on={playing ? 'true' : 'false'}
                strokeWidth={2.4}
                aria-hidden
              />
            </span>
          </button>
        </header>

        <p className="rise rise-2 mt-3 flex items-baseline justify-between text-xs text-muted">
          <span className="tabular-nums">
            {playing ? `Bar ${String(bar + 1).padStart(2, '0')} / 16` : 'Ready'}
            <span> · </span>
            {track.name}
          </span>
          <span className="tabular-nums text-fg">{bpm} BPM</span>
        </p>

        <div className="rise rise-2 mt-2 grid grid-cols-4 gap-1" aria-label="Song parts">
          {PARTS.map((name, index) => {
            const on = playing && Math.floor(bar / 4) === index;
            return (
              <p
                key={name}
                className={cx(
                  'rounded-full border px-2 py-1 text-center text-xs font-semibold',
                  on ? 'border-acid bg-acid text-acid-ink' : 'border-line bg-surface text-muted',
                )}
              >
                {name}
              </p>
            );
          })}
        </div>

        <div className="rise rise-2 mt-2 grid gap-2" aria-label="Decks">
          {/* Only the live deck reflects the cuts. The idle one is a preview of the
              track as written, which is what you want to see before bringing it in. */}
          <DeckWave
            side="a"
            track={liveDeck === 'a' ? track : cued}
            step={liveDeck === 'a' ? songStep : -1}
            status={liveDeck === 'a' ? (playing ? 'Live' : 'Cue') : 'Idle'}
            silenced={liveDeck === 'a' ? silenced : undefined}
          />
          <DeckWave
            side="b"
            track={liveDeck === 'b' ? track : cued}
            step={liveDeck === 'b' ? songStep : -1}
            status={liveDeck === 'b' ? (playing ? 'Live' : 'Cue') : 'Idle'}
            silenced={liveDeck === 'b' ? silenced : undefined}
          />
        </div>

        <div className="rise rise-3 mt-4">
          <p className="text-xs font-semibold tracking-widest text-muted">EDM</p>
          <TrackGrid items={edmTracks} current={track.id} onPick={selectTrack} />
          <p className="mt-3 text-xs font-semibold tracking-widest text-muted">Lofi</p>
          <TrackGrid items={lofiTracks} current={track.id} onPick={selectTrack} />
        </div>

        <div className="rise rise-3 mt-6 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-semibold tracking-widest text-muted">
              Next
            </span>
            <select
              className="next-song"
              aria-label="Next song"
              value={nextId}
              disabled={Boolean(mixing)}
              onChange={(event) => cueNext(event.target.value)}
            >
              {tracks
                .filter((item) => item.id !== track.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.detail}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            aria-pressed={Boolean(mixing)}
            className={cx(
              'mix-action tap',
              mixing ? 'border-acid bg-acid text-acid-ink' : 'border-line bg-surface text-fg',
            )}
            onClick={autoMix}
          >
            <span className="block">{mixing ? 'Mixing' : 'Auto mix'}</span>
            <span className="mix-action-note">{mixing ? mixing : 'track'}</span>
          </button>
          {(
            [
              ['swap', 'Continuous mix', 'stem swap'],
              ['plain', 'Continuous mix', 'song after song'],
            ] as const
          ).map(([mode, label, note]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={continuous === mode}
              className={cx(
                'mix-action tap',
                continuous === mode
                  ? 'border-acid bg-acid text-acid-ink'
                  : 'border-line bg-surface text-fg',
              )}
              // Picking one turns the other off; pressing the lit one stops.
              onClick={() => setContinuous((now) => (now === mode ? 'off' : mode))}
            >
              <span className="block">{label}</span>
              <span className="mix-action-note">{note}</span>
            </button>
          ))}
        </div>

        <div className="rise rise-3 mt-6 grid grid-cols-3 gap-2" role="group" aria-label="Stem groups">
          {(
            [
              ['full', 'Full mix'],
              ['nodrums', 'No drums'],
              ['nomusic', 'No music'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mask === id}
              className={cx(
                'tap rounded-full border px-2 py-2 text-xs font-semibold tracking-wide',
                mask === id ? 'border-acid bg-acid text-acid-ink' : 'border-line bg-surface text-fg',
              )}
              onClick={() => applyMask(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="rise rise-4 mt-3 sm:grid sm:grid-cols-2 sm:gap-x-8" aria-label="Stems">
          {library.stems.map((meta, index) => {
            const Icon = ICONS[meta.id];
            const cut = muted[meta.id] || (anySolo && !solo[meta.id]);
            const activity = barActivity(track, meta.id, bar);
            return (
              <article key={meta.id} className={cx('stem', cut && 'is-cut')}>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted" strokeWidth={2.2} aria-hidden />
                    <p className="shrink-0 font-display text-base font-bold tracking-wide">
                      {meta.name}
                    </p>
                    <p className="hidden text-xs text-muted sm:block">{meta.hint}</p>
                    <div className="meter" aria-hidden>
                      <span ref={(el) => { meterRefs.current[index] = el; }} />
                    </div>
                  </div>
                  {/* Solo ends the step row. The dots take the slack and the button is
                      a fixed width, so it lands at the same right edge on every stem
                      instead of drifting with the length of the name and hint. */}
                  <div className="step-line">
                    <div className="step-row" aria-hidden>
                      {activity.map((on, i) => (
                        <span key={i} className={cx('step', on && 'on', i === col && 'now')} />
                      ))}
                    </div>
                    <button
                      type="button"
                      className="solo shrink-0"
                      aria-pressed={solo[meta.id]}
                      onClick={() => toggleSolo(meta.id)}
                    >
                      Solo
                    </button>
                  </div>
                  <label className="mt-2 block">
                    <span className="sr-only">{meta.name} volume</span>
                    <input
                      className="fader"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={vols[meta.id]}
                      onChange={(event) => setStemVol(meta.id, Number(event.target.value))}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className={cx('btn-cut tap', cut && 'is-cut')}
                  aria-pressed={muted[meta.id]}
                  aria-keyshortcuts={meta.keys}
                  onClick={() => toggleMute(meta.id)}
                >
                  {muted[meta.id] ? 'In' : 'Cut'}
                </button>
              </article>
            );
          })}
        </section>

        <section className="rise rise-3 mt-3" aria-label="Deck">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <HoldButton label="Bend −" onDown={() => engine.nudge(-1)} onUp={() => engine.nudge(0)} />
            <button
              type="button"
              className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
              aria-label="Cue to the start"
              onClick={() => {
                engine.cue();
                void engine.play('a');
              }}
            >
              Cue
            </button>
            <button
              type="button"
              className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
              aria-label="Vinyl brake"
              onClick={() => engine.brake()}
            >
              Brake
            </button>
            <BackspinWheel
              on={backspinOn}
              onToggle={() => {
                const next = !backspinOn;
                setBackspinOn(next);
                if (next) engine.backspin();
              }}
            />
            <button
              type="button"
              aria-pressed={echo}
              aria-label="Echo throw"
              className={cx(
                'tap rounded-full border px-2 py-2 text-xs font-semibold',
                echo ? 'border-acid bg-acid text-acid-ink' : 'border-line bg-surface',
              )}
              onClick={() => {
                const next = !echo;
                setEcho(next);
                engine.setEcho(next);
              }}
            >
              Echo
            </button>
            <HoldButton label="Bend +" onDown={() => engine.nudge(1)} onUp={() => engine.nudge(0)} />
          </div>

          <p className="mt-3 text-xs font-semibold tracking-widest text-muted">Loop</p>
          <div className="mt-2 grid grid-cols-5 gap-1" role="group" aria-label="Loop length">
            {LOOP_BARS.map((bars) => (
              <button
                key={bars}
                type="button"
                aria-pressed={loopBars === bars}
                aria-label={`Loop ${bars} bars`}
                className={cx(
                  'tap rounded-full border px-1 py-2 text-xs font-semibold tabular-nums',
                  loopBars === bars ? 'border-acid bg-acid text-acid-ink' : 'border-line bg-surface',
                )}
                onClick={() => {
                  const next = loopBars === bars ? 0 : (bars as LoopBars);
                  setLoopBars(next);
                  engine.setLoop(next);
                }}
              >
                {bars}
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {(
              [
                ['low', 'Low'],
                ['mid', 'Mid'],
                ['high', 'High'],
              ] as const
            ).map(([id, label]) => (
              <label key={id} className="block">
                <span className="mb-1 flex items-center justify-between text-xs text-muted">
                  <span>{label}</span>
                  <span className="tabular-nums text-fg">{Math.round(bands[id] * 100)}</span>
                </span>
                <input
                  className="fader"
                  type="range"
                  min={0}
                  max={1.4}
                  step={0.01}
                  value={bands[id]}
                  aria-label={`${label} isolator`}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    const next = { ...bands, [id]: value };
                    setBands(next);
                    engine.setBands(next.low, next.mid, next.high);
                  }}
                />
              </label>
            ))}
            <label className="block">
              <span className="mb-1 flex items-center justify-between text-xs text-muted">
                <span>Filter</span>
                <span className="tabular-nums text-fg">{Math.round(open * 100)}</span>
              </span>
              <input
                className="fader"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={open}
                aria-label="Filter"
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setOpen(value);
                  engine.setFilter(value);
                }}
              />
            </label>
          </div>

          <label className="mt-3 block">
            <span className="mb-1 flex items-center justify-between text-xs text-muted">
              <span>Stereo</span>
              <span className="tabular-nums text-fg">{stereoLabel(stereo)}</span>
            </span>
            <input
              className="fader"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={stereo}
              aria-label="Stereo balance"
              aria-valuetext={stereoLabel(stereo)}
              onChange={(event) => {
                const value = Number(event.target.value);
                setStereo(value);
                engine.setStereoBalance(value);
              }}
            />
            <span className="fader-ends" aria-hidden="true">
              <span>Left</span>
              <span>Stereo</span>
              <span>Right</span>
            </span>
          </label>
        </section>

        <section className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs text-muted">
              <span>Tempo</span>
              <span className="tabular-nums text-fg">{bpm}</span>
            </span>
            <input
              className="fader"
              type="range"
              min={70}
              max={150}
              step={1}
              value={bpm}
              aria-label="Tempo"
              onChange={(event) => {
                const value = Number(event.target.value);
                cancelTempoGlide();
                setBpm(value);
                engine.setBpm(value);
              }}
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs text-muted">
              <span>Swing</span>
              <span className="tabular-nums text-fg">{Math.round(swing * 100)}</span>
            </span>
            <input
              className="fader"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={swing}
              aria-label="Swing"
              onChange={(event) => {
                const value = Number(event.target.value);
                setSwing(value);
                engine.setSwing(value);
              }}
            />
          </label>
          <label className="block">
            <span className="mb-1 flex items-center justify-between text-xs text-muted">
              <span>Master</span>
              <span className="tabular-nums text-fg">{Math.round(master * 100)}</span>
            </span>
            <input
              className="fader"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={master}
              aria-label="Master volume"
              onChange={(event) => {
                const value = Number(event.target.value);
                setMaster(value);
                engine.setMaster(value);
              }}
            />
          </label>
        </section>

        <p className="mt-4 text-xs text-muted">
          Space plays. Keys 1–8 cut a stem. Auto mix brings in the next track.
        </p>
        <p className="mt-1 text-xs text-muted">
          Audio runs in Rust compiled to WebAssembly, inside an AudioWorklet.
        </p>
      </div>
    </main>
  );
}

/**
 * A button that fires while held — the tempo-bend gesture.
 *
 * Pointer capture keeps the bend applied when the finger slides off the button,
 * and the release path covers cancel as well as up, so the tempo always returns
 * to nominal.
 */
function HoldButton({
  label,
  onDown,
  onUp,
}: {
  label: string;
  onDown: () => void;
  onUp: () => void;
}) {
  return (
    <button
      type="button"
      className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
      aria-label={`Nudge tempo ${label.slice(-1) === '+' ? 'up' : 'down'}`}
      onPointerDown={(event) => {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* pointer already released */
        }
        onDown();
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
    >
      {label}
    </button>
  );
}

function BackspinWheel({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label="Toggle backspin"
      onClick={onToggle}
      className={cx(
        'tap flex flex-col items-center gap-1 rounded-xl border px-1.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider',
        on ? 'border-acid bg-acid text-acid-ink' : 'border-line bg-surface text-muted',
      )}
    >
      <svg className="backspin-disc" data-on={on ? 'true' : 'false'} width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="16" cy="16" r="9.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.55" />
        <circle cx="16" cy="16" r="3" fill="currentColor" opacity="0.9" />
        <line x1="16" y1="2" x2="16" y2="9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <line x1="16" y1="23" x2="16" y2="30" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4" />
        <line x1="2" y1="16" x2="9" y2="16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4" />
        <line x1="23" y1="16" x2="30" y2="16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4" />
      </svg>
      Backspin
    </button>
  );
}

function TrackGrid({
  items,
  current,
  onPick,
}: {
  items: TrackSummary[];
  current: string;
  onPick: (track: TrackSummary) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.id === current}
          className={cx(
            'tap rounded-xl border px-2.5 py-2.5 text-left',
            item.id === current ? 'border-acid bg-raised' : 'border-line bg-surface',
          )}
          onClick={() => onPick(item)}
        >
          <span className="block truncate font-display text-sm font-bold">{item.name}</span>
          <span className="mt-1 block text-xs text-muted">{item.detail}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The song waveform, drawn from the arrangement's own lanes rather than an
 * `AnalyserNode`: it shows what *will* play, including the bars that are still
 * ahead, which a live scope cannot.
 */
function DeckWave({
  side,
  track,
  step,
  status,
  silenced,
}: {
  side: 'a' | 'b';
  track: TrackArrangement | null;
  step: number;
  status: 'Live' | 'Cue' | 'Idle';
  /** Stems that are not sounding, left out of the drawing. */
  silenced?: Record<StemId, boolean>;
}) {
  // Both decks always draw. Before a track is cued there is nothing to show, so the
  // slot keeps its height with a placeholder rather than collapsing — a deck that
  // appears and disappears as tracks are cued makes the layout jump.
  // Keyed on which stems are silent as well as the track, so cutting one redraws.
  const silentKey = silenced ? STEM_ORDER.filter((id) => silenced[id]).join(',') : '';
  const path = useMemo(
    () => (track ? waveBands(track, silenced) : null),
    [track, silentKey],
  );
  const head = step < 0 ? 0 : ((step % STEPS) / STEPS) * 100;

  return (
    <div className="deck-wave" data-live={status === 'Live' ? 'yes' : 'no'}>
      <div className="flex items-baseline justify-between gap-2 px-2.5 pt-1.5">
        <p className="truncate text-xs font-semibold">
          <span className={side === 'a' ? 'text-acid' : 'text-deck-b'}>{side.toUpperCase()}</span>
          <span className="text-muted"> · </span>
          {track ? track.name : '—'}
        </p>
        <p className="shrink-0 text-xs text-muted">{status}</p>
      </div>
      <div className="relative mx-2 mb-2 mt-1">
        <svg
          viewBox="0 0 256 48"
          className="block h-12 w-full"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Deck ${side.toUpperCase()} waveform`}
        >
          <line className="wave-axis" x1="0" y1="24" x2="256" y2="24" />
          {Array.from({ length: 17 }, (_, b) => (
            <line
              key={b}
              className={b % 4 === 0 ? 'wave-grid-phrase' : 'wave-grid'}
              x1={(b / 16) * 256}
              x2={(b / 16) * 256}
              y1="1"
              y2="47"
            />
          ))}
          {path ? (
            <>
              <path d={path.low} className="wave-low" />
              <path d={path.mid} className="wave-mid" />
              <path d={path.high} className="wave-high" />
            </>
          ) : (
            <line className="wave-grid" x1="0" y1="24" x2="256" y2="24" />
          )}
        </svg>
        <span
          className="wave-shade"
          style={{ left: `${head}%`, opacity: status === 'Live' ? 1 : 0 }}
        />
        <span
          className="wave-head"
          style={{ left: `${head}%`, opacity: status === 'Live' ? 1 : 0 }}
        />
      </div>
    </div>
  );
}

/**
 * Three envelopes — low, mid and high — rendered as sine lobes.
 *
 * Drums poke their transient onto the following step and melodic stems sustain
 * across their gate, which is what makes the shape read as a mix rather than a
 * grid of identical blocks.
 */
function waveBands(
  track: TrackArrangement,
  silenced?: Record<StemId, boolean>,
): { low: string; mid: string; high: string } {
  // A stem that is cut is left out of the drawing, so the waveform thins as stems are
  // taken away and fills back in as they return. The whole app is about removing
  // stems; a picture that stayed the same either way was describing the arrangement
  // rather than what you are hearing.
  const on = (id: StemId) => !silenced?.[id];
  const low = Array.from({ length: STEPS }, () => 0);
  const mid = Array.from({ length: STEPS }, () => 0);
  const high = Array.from({ length: STEPS }, () => 0);

  const poke = (dest: number[], values: number[], weight: number) => {
    values.forEach((value, index) => {
      if (value <= 0 || index >= STEPS) return;
      dest[index] += value * weight;
      if (index + 1 < STEPS) dest[index + 1] += value * weight * 0.45;
    });
  };

  if (on('kick')) poke(low, track.kick, 1);
  if (on('clap')) poke(mid, track.clap, 0.55);
  if (on('hats')) {
    poke(high, track.hat, 0.42);
    poke(high, track.hatOpen, 0.62);
  }

  const sustain = (
    dest: number[],
    events: (typeof track.bass)[number][],
    weight: number,
  ) => {
    events.forEach((event, index) => {
      if (!event || index >= STEPS) return;
      const span = Math.max(1, Math.min(event.len, STEPS - index));
      for (let i = 0; i < span; i += 1) {
        dest[index + i] += event.vel * weight * (1 - (i / span) * 0.55);
      }
    });
  };

  if (on('bass')) sustain(low, track.bass, 0.82);
  if (on('stab')) sustain(mid, track.stab, 0.5);
  if (on('lead')) sustain(mid, track.lead, 0.46);
  if (on('pad')) sustain(mid, track.pad, 0.34);
  if (on('arp')) sustain(high, track.arp, 0.4);

  const blur = (values: number[]) =>
    values.map((_, index) => {
      const prev = values[index - 1] ?? values[index] ?? 0;
      const next = values[index + 1] ?? values[index] ?? 0;
      return (values[index] ?? 0) * 0.5 + prev * 0.25 + next * 0.25;
    });

  /**
   * One band as a mirrored envelope.
   *
   * `ripple` puts a shallow oscillation on the edge at a musical rate, so the shape
   * reads as a waveform rather than a smooth tube. It is deliberately shallow: an
   * earlier version ran it at `0.32 + 0.68 * lobe`, which swung the edge nearly to
   * zero between lobes and turned every band into a row of bubbles, with the rhythm of
   * the sine rather than the rhythm of the track. At `0.86 + 0.14` the envelope is
   * what you see and the ripple is only texture on it.
   *
   * `floor` is the thickness at silence. Small, so the sparse intro and the break
   * actually read as quiet — the old constant 1.35 drew a solid band through both.
   */
  const band = (
    envelope: number[],
    ripple: number,
    scale: number,
    floor: number,
  ) => {
    const count = 720;
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = 0; i <= count; i += 1) {
      const x = (i / count) * 256;
      const pos = (i / count) * (STEPS - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(STEPS - 1, i0 + 1);
      const t = pos - i0;
      const ease = t * t * (3 - 2 * t);
      const env = Math.min(
        1.15,
        (envelope[i0] ?? 0) * (1 - ease) + (envelope[i1] ?? 0) * ease,
      );
      const lobe = Math.abs(Math.sin(pos * ripple));
      const amp = (floor + env * scale) * (0.86 + 0.14 * lobe);
      top.push(`${x.toFixed(2)},${(24 - amp).toFixed(2)}`);
      bottom.push(`${x.toFixed(2)},${(24 + amp).toFixed(2)}`);
    }
    bottom.reverse();
    return `M${top.join('L')}L${bottom.join('L')}Z`;
  };

  // Nested, widest at the back: the low band is the body, the mid sits inside it and
  // the high is a bright core. Each ripples twice as fast as the one under it, which
  // is roughly how the content divides — kick on the beat, hats on the sixteenth.
  // The scales are close together on purpose. Spread wider, the low band swallows the
  // other two and the whole thing reads as one blue shape with a pale line through it;
  // the point of splitting the bands is to see the hats and the melody against the
  // kick, so each has to clear the one behind it.
  return {
    low: band(blur(low), Math.PI / 2, 17, 0.9),
    mid: band(blur(mid), Math.PI, 13.5, 0.65),
    high: band(blur(high), Math.PI * 2, 9.5, 0.45),
  };
}