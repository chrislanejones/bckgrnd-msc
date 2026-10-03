import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { FloorEngine } from "@/lib/engine";
import {
  BARS,
  STEPS,
  PARTS,
  barActivity,
  DRUMS,
  emptyMutes,
  MUSIC,
  STEM_META,
  TRACKS,
  type Mix,
  type StemId,
  type Track,
} from "@/lib/music";

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

const LOOP_BARS = [1, 2, 4, 8, 16, 32] as const;
type LoopBars = 0 | (typeof LOOP_BARS)[number];
type Mask = "full" | "nodrums" | "nomusic" | "custom";
type Side = "a" | "b";
type StereoMode = "left" | "stereo" | "right";

const STEREO_MODES = [
  ["left", "Left"],
  ["stereo", "Stereo"],
  ["right", "Right"],
] as const;

type StereoMatrix = {
  ll: GainNode;
  lr: GainNode;
  rl: GainNode;
  rr: GainNode;
};

function applyStereo(matrix: StereoMatrix, mode: StereoMode, time: number) {
  const set = (node: GainNode, value: number) => {
    node.gain.setValueAtTime(node.gain.value, time);
    node.gain.setTargetAtTime(value, time, 0.02);
  };
  if (mode === "left") {
    set(matrix.ll, 0.5);
    set(matrix.rl, 0.5);
    set(matrix.lr, 0);
    set(matrix.rr, 0);
    return;
  }
  if (mode === "right") {
    set(matrix.ll, 0);
    set(matrix.rl, 0);
    set(matrix.lr, 0.5);
    set(matrix.rr, 0.5);
    return;
  }
  set(matrix.ll, 1);
  set(matrix.rr, 1);
  set(matrix.lr, 0);
  set(matrix.rl, 0);
}

type Deck = {
  engine: FloorEngine;
  gain: GainNode;
};

type Rig = {
  ctx: AudioContext;
  busScope: AnalyserNode;
  busBuf: Uint8Array<ArrayBuffer>;
  stereo: StereoMatrix;
  decks: Record<Side, Deck>;
  live: Side;
};

type MixJob = {
  id: number;
  start: number;
  until: number;
  bassAt: number;
  bassDone: boolean;
  kickInAt: number;
  kickInDone: boolean;
  kickOutAt: number;
  kickOutDone: boolean;
  outgoing: FloorEngine;
  incoming: FloorEngine;
  outGain: GainNode;
  inGain: GainNode;
  incomingSide: Side;
  track: Track;
  outMix: Mix;
  bar: number;
};

type Glide = {
  from: number;
  to: number;
  start: number;
  dur: number;
  shown: number;
};

function nextTrack(id: string): Track {
  const index = TRACKS.findIndex((item) => item.id === id);
  return TRACKS[(index + 1 + TRACKS.length) % TRACKS.length] ?? TRACKS[0];
}

function waveBands(track: Track): { low: string; mid: string; high: string } {
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
  poke(low, track.kick, 1);
  poke(mid, track.clap, 0.55);
  poke(high, track.hat, 0.42);
  poke(high, track.hatOpen, 0.62);
  const sustain = (dest: number[], events: (Track["bass"][number])[], weight: number) => {
    events.forEach((event, index) => {
      if (!event || index >= STEPS) return;
      const span = Math.max(1, Math.min(event.len, STEPS - index));
      for (let i = 0; i < span; i += 1) {
        dest[index + i] += event.vel * weight * (1 - (i / span) * 0.55);
      }
    });
  };
  sustain(low, track.bass, 0.82);
  sustain(mid, track.stab, 0.5);
  sustain(mid, track.lead, 0.46);
  sustain(mid, track.pad, 0.34);
  sustain(high, track.arp, 0.4);
  const blur = (values: number[]) =>
    values.map((_, index) => {
      const prev = values[index - 1] ?? values[index] ?? 0;
      const next = values[index + 1] ?? values[index] ?? 0;
      return ((values[index] ?? 0) * 0.5 + prev * 0.25 + next * 0.25);
    });
  const sine = (envelope: number[], cycles: number, scale: number) => {
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
      const env = Math.min(1, (envelope[i0] ?? 0) * (1 - ease) + (envelope[i1] ?? 0) * ease);
      const lobe = Math.abs(Math.sin(pos * cycles));
      const amp = (1.35 + env * scale) * (0.32 + 0.68 * lobe);
      top.push(`${x.toFixed(2)},${(24 - amp).toFixed(2)}`);
      bottom.push(`${x.toFixed(2)},${(24 + amp).toFixed(2)}`);
    }
    bottom.reverse();
    return `M${top.join("L")}L${bottom.join("L")}Z`;
  };
  return {
    low: sine(blur(low), Math.PI / 4, 18),
    mid: sine(blur(mid), Math.PI / 2, 11),
    high: sine(blur(high), Math.PI, 6.5),
  };
}

function DeckWave({
  side,
  track,
  status,
  headRef,
  shadeRef,
}: {
  side: Side;
  track: Track;
  status: string;
  headRef: (node: HTMLSpanElement | null) => void;
  shadeRef: (node: HTMLSpanElement | null) => void;
}) {
  const bands = useMemo(() => waveBands(track), [track]);
  return (
    <div className={cx("deck-wave", status === "Live" && "is-live", status === "In" && "is-in")}>
      <div className="flex items-baseline justify-between gap-2 px-2.5 pt-1.5">
        <p className="truncate text-xs font-semibold">
          <span className={side === "a" ? "text-acid" : "text-deck-b"}>{side.toUpperCase()}</span>
          <span className="text-muted"> · </span>
          {track.name}
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
          {Array.from({ length: 17 }, (_, bar) => (
            <line
              key={bar}
              className={bar % 4 === 0 ? "wave-grid-phrase" : "wave-grid"}
              x1={(bar / 16) * 256}
              x2={(bar / 16) * 256}
              y1="1"
              y2="47"
            />
          ))}
          <path d={bands.low} className="wave-low" />
          <path d={bands.mid} className="wave-mid" />
          <path d={bands.high} className="wave-high" />
        </svg>
        <span ref={shadeRef} className="wave-shade" />
        <span ref={headRef} className="wave-head" />
      </div>
    </div>
  );
}

function TrackGrid({
  items,
  current,
  onPick,
}: {
  items: Track[];
  current: string;
  onPick: (track: Track) => void;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.id === current}
          className={cx(
            "tap rounded-xl border px-2.5 py-2.5 text-left",
            item.id === current ? "border-acid bg-raised" : "border-line bg-surface",
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

function hold(start: () => void, end: () => void) {
  return {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      start();
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function paintMutes(mask: Mask): Record<StemId, boolean> {
  const muted = emptyMutes();
  if (mask === "nodrums") for (const id of DRUMS) muted[id] = true;
  if (mask === "nomusic") for (const id of MUSIC) muted[id] = true;
  return muted;
}

export function FloorDeck() {
  const engineRef = useRef<FloorEngine | null>(null);
  const meters = useRef<Array<HTMLSpanElement | null>>([]);
  const heads = useRef<{ a: HTMLSpanElement | null; b: HTMLSpanElement | null }>({ a: null, b: null });
  const shades = useRef<{ a: HTMLSpanElement | null; b: HTMLSpanElement | null }>({ a: null, b: null });
  const playingRef = useRef(false);

  const [trackId, setTrackId] = useState(TRACKS[0].id);
  const [playing, setPlaying] = useState(false);
  const [bpm, setBpm] = useState(TRACKS[0].bpm);
  const [swing, setSwing] = useState(TRACKS[0].swing);
  const [master, setMaster] = useState(0.78);
  const [vols, setVols] = useState<Mix>(TRACKS[0].mix);
  const [muted, setMuted] = useState(emptyMutes);
  const [solo, setSolo] = useState(emptyMutes);
  const [mask, setMask] = useState<Mask>("full");
  const [step, setStep] = useState(-1);
  const [loopBars, setLoopBars] = useState<LoopBars>(0);
  const [bands, setBands] = useState({ low: 1, mid: 1, high: 1 });
  const [open, setOpen] = useState(1);
  const [echo, setEcho] = useState(false);
  const [mixing, setMixing] = useState<string | null>(null);
  const [mixProgress, setMixProgress] = useState(0);
  const [stereo, setStereo] = useState<StereoMode>("stereo");
  const [nextId, setNextId] = useState(nextTrack(TRACKS[0].id).id);
  const [liveSide, setLiveSide] = useState<Side>("a");
  const [slot, setSlot] = useState<{ a: string; b: string }>({
    a: TRACKS[0].id,
    b: nextTrack(TRACKS[0].id).id,
  });

  const rigRef = useRef<Rig | null>(null);
  const mixRef = useRef<MixJob | null>(null);
  const glideRef = useRef<Glide | null>(null);
  const finishRef = useRef<(job: MixJob) => void>(() => {});
  const abortRef = useRef<() => void>(() => {});
  const mixSeq = useRef(0);

  const track = TRACKS.find((item) => item.id === trackId) ?? TRACKS[0];
  playingRef.current = playing;

  useEffect(() => {
    const ctx = new AudioContext();
    const bus = ctx.createGain();
    bus.gain.value = 1;
    const busScope = ctx.createAnalyser();
    busScope.fftSize = 1024;
    busScope.smoothingTimeConstant = 0.75;
    const busBuf = new Uint8Array(new ArrayBuffer(busScope.fftSize));
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const ll = ctx.createGain();
    const lr = ctx.createGain();
    const rl = ctx.createGain();
    const rr = ctx.createGain();
    ll.gain.value = 1;
    rr.gain.value = 1;
    lr.gain.value = 0;
    rl.gain.value = 0;
    bus.connect(split);
    split.connect(ll, 0);
    split.connect(lr, 0);
    split.connect(rl, 1);
    split.connect(rr, 1);
    ll.connect(merge, 0, 0);
    lr.connect(merge, 0, 1);
    rl.connect(merge, 0, 0);
    rr.connect(merge, 0, 1);
    merge.connect(busScope);
    busScope.connect(ctx.destination);
    const gainA = ctx.createGain();
    const gainB = ctx.createGain();
    gainA.gain.value = 1;
    gainB.gain.value = 0;
    gainA.connect(bus);
    gainB.connect(bus);
    const engineA = new FloorEngine(TRACKS[0], gainA);
    const engineB = new FloorEngine(nextTrack(TRACKS[0].id), gainB);
    const rig: Rig = {
      ctx,
      busScope,
      busBuf,
      stereo: { ll, lr, rl, rr },
      live: "a",
      decks: {
        a: { engine: engineA, gain: gainA },
        b: { engine: engineB, gain: gainB },
      },
    };
    rigRef.current = rig;
    engineRef.current = engineA;
    let raf = 0;
    let last = -2;
    let lastProgress = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const live = rig.decks[rig.live].engine;
      const levels = live.readLevels();
      levels.forEach((level, i) => {
        const el = meters.current[i];
        if (el) el.style.transform = `scaleX(${Math.max(0.035, level)})`;
      });
      const nowStep = live.visualStep();
      if (nowStep !== last) {
        last = nowStep;
        setStep(nowStep);
      }
      const job = mixRef.current;
      if (job) {
        const time = ctx.currentTime;
        if (time >= job.until) finishRef.current(job);
        else {
          if (!job.bassDone && time >= job.bassAt) {
            job.bassDone = true;
            job.outgoing.rampStem("bass", 0, job.bar);
            job.incoming.rampStem("bass", job.track.mix.bass, job.bar);
          }
          if (!job.kickInDone && time >= job.kickInAt) {
            job.kickInDone = true;
            job.incoming.rampStem("kick", job.track.mix.kick, job.bar * 2);
          }
          if (!job.kickOutDone && time >= job.kickOutAt) {
            job.kickOutDone = true;
            job.outgoing.rampStem("kick", 0, job.bar * 3);
          }
          if (!job.outgoing.isPlaying()) abortRef.current();
          else {
            const span = Math.max(0.001, job.until - job.start);
            const progress = Math.max(0, Math.min(1, (time - job.start) / span));
            if (Math.abs(progress - lastProgress) >= 0.02) {
              lastProgress = progress;
              setMixProgress(progress);
            }
          }
        }
      }
      const current = rig.decks[rig.live].engine;
      const glide = glideRef.current;
      if (glide && !mixRef.current) {
        const time = ctx.currentTime;
        const progress = Math.min(1, (time - glide.start) / glide.dur);
        const value = glide.from + (glide.to - glide.from) * progress;
        current.setBpm(value);
        const shown = Math.round(value);
        if (shown !== glide.shown) {
          glide.shown = shown;
          setBpm(shown);
        }
        if (progress >= 1) {
          current.setBpm(glide.to);
          setBpm(Math.round(glide.to));
          glideRef.current = null;
        }
      }
      if (playingRef.current && !current.isPlaying() && !mixRef.current) {
        playingRef.current = false;
        setPlaying(false);
        setStep(-1);
      }
      (["a", "b"] as const).forEach((side) => {
        const head = heads.current[side];
        const shade = shades.current[side];
        const engine = rig.decks[side].engine;
        if (!head) return;
        const shown = engine.visualStep();
        const place = shown < 0 ? 0 : ((shown % STEPS) / STEPS) * 100;
        const moving = engine.isPlaying();
        head.style.left = `${place}%`;
        head.style.opacity = moving ? "1" : "0";
        if (shade) {
          shade.style.left = `${place}%`;
          shade.style.opacity = moving ? "1" : "0";
        }
      });
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      mixRef.current = null;
      engineA.dispose();
      engineB.dispose();
      void ctx.close();
      rigRef.current = null;
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.target instanceof HTMLInputElement) return;
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlay();
        return;
      }
      const n = Number(event.key);
      if (n >= 1 && n <= 8) {
        const id = STEM_META[n - 1]?.id;
        if (id) toggleMute(id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function togglePlay() {
    const rig = rigRef.current;
    const engine = engineRef.current;
    if (!engine) return;
    if (playingRef.current) {
      abortRef.current();
      glideRef.current = null;
      rig?.decks.a.engine.stop();
      rig?.decks.b.engine.stop();
      setPlaying(false);
      setStep(-1);
      return;
    }
    void engine.play().then(() => setPlaying(true));
  }

  function selectTrack(next: Track) {
    abortRef.current();
    glideRef.current = null;
    setTrackId(next.id);
    setBpm(next.bpm);
    setSwing(next.swing);
    setVols(next.mix);
    const clear = emptyMutes();
    setMuted(clear);
    setSolo(clear);
    setMask("full");
    setLoopBars(0);
    const engine = engineRef.current;
    const rig = rigRef.current;
    if (!engine || !rig) return;
    engine.setMutes(clear);
    engine.setSolos(clear);
    engine.setTrack(next);
    const idleSide: Side = rig.live === "a" ? "b" : "a";
    const cue = nextId === next.id ? nextTrack(next.id) : (TRACKS.find((item) => item.id === nextId) ?? nextTrack(next.id));
    if (cue.id !== nextId) setNextId(cue.id);
    const idle = rig.decks[idleSide];
    idle.engine.stop();
    idle.engine.setMutes(clear);
    idle.engine.setSolos(clear);
    idle.engine.setTrack(cue);
    idle.engine.setFilter(1);
    setSlot({
      a: rig.live === "a" ? next.id : cue.id,
      b: rig.live === "b" ? next.id : cue.id,
    });
    const time = rig.ctx.currentTime;
    idle.gain.gain.cancelScheduledValues(time);
    idle.gain.gain.setValueAtTime(0, time);
    const liveGain = rig.decks[rig.live].gain.gain;
    liveGain.cancelScheduledValues(time);
    liveGain.setValueAtTime(1, time);
  }

  function cueNext(id: string) {
    if (mixRef.current || id === trackId) return;
    const picked = TRACKS.find((item) => item.id === id);
    const rig = rigRef.current;
    if (!picked || !rig) return;
    setNextId(picked.id);
    const idleSide: Side = rig.live === "a" ? "b" : "a";
    const idle = rig.decks[idleSide];
    idle.engine.stop();
    idle.engine.setMutes(emptyMutes());
    idle.engine.setSolos(emptyMutes());
    idle.engine.setTrack(picked);
    idle.engine.setFilter(1);
    setSlot((prev) => ({ ...prev, [idleSide]: picked.id }));
  }

  async function autoMix() {
    const rig = rigRef.current;
    if (!rig || mixRef.current) return;
    glideRef.current = null;
    const idleSide: Side = rig.live === "a" ? "b" : "a";
    const outgoing = rig.decks[rig.live];
    const incoming = rig.decks[idleSide];
    const from = outgoing.engine;
    const to = incoming.engine;
    if (!from.isPlaying()) {
      await from.play();
      playingRef.current = true;
      setPlaying(true);
    }
    if (from.bpm <= 0) return;
    const upcoming = TRACKS.find((item) => item.id === nextId && item.id !== from.track.id) ?? nextTrack(from.track.id);
    const clear = emptyMutes();
    to.stop();
    to.setTrack(upcoming);
    to.setBpm(from.bpm);
    to.setSwing(from.swing);
    to.setMutes(clear);
    to.setSolos(clear);
    to.setMix({ ...upcoming.mix, bass: 0, kick: upcoming.mix.kick * 0.45 });
    to.setEcho(false);
    to.setBands(1, 1, 1);
    to.setFilter(0.22);
    to.setLoop(0);
    const bpm = Math.max(40, from.bpm);
    const phrase = from.nextDownbeat(4, 0.32);
    const barLine = from.nextDownbeat(1, 0.32);
    const maxWait = (60 / bpm) * 2.1;
    const start = phrase - rig.ctx.currentTime <= maxWait ? phrase : barLine;
    const dur = (8 * 60) / bpm;
    const steps = 96;
    const outCurve = new Float32Array(steps);
    const inCurve = new Float32Array(steps);
    for (let i = 0; i < steps; i += 1) {
      const p = i / (steps - 1);
      const shaped = p * p * (3 - 2 * p);
      outCurve[i] = Math.cos((shaped * Math.PI) / 2);
      inCurve[i] = Math.sin((shaped * Math.PI) / 2);
    }
    outgoing.gain.gain.cancelScheduledValues(start);
    incoming.gain.gain.cancelScheduledValues(start);
    outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value, rig.ctx.currentTime);
    incoming.gain.gain.setValueAtTime(0, rig.ctx.currentTime);
    outgoing.gain.gain.setValueCurveAtTime(outCurve, start, dur);
    incoming.gain.gain.setValueCurveAtTime(inCurve, start, dur);
    from.blendFilter(1, 0.32, start + dur * 0.58, start + dur);
    to.blendFilter(0.22, 1, start, start + dur * 0.85);
    const id = mixSeq.current + 1;
    mixSeq.current = id;
    mixRef.current = {
      id,
      start,
      until: start + dur,
      bassAt: start + dur * 0.42,
      bassDone: false,
      kickInAt: start + dur * 0.18,
      kickInDone: false,
      kickOutAt: start + dur * 0.62,
      kickOutDone: false,
      outgoing: from,
      incoming: to,
      outGain: outgoing.gain,
      inGain: incoming.gain,
      incomingSide: idleSide,
      track: upcoming,
      outMix: { ...vols },
      bar: (0.75 * 60) / bpm,
    };
    setSlot((prev) => ({ ...prev, [idleSide]: upcoming.id }));
    setMixing(upcoming.name);
    setMixProgress(0);
    await to.play(start);
  }

  function applyMask(next: Mask) {
    const flags = paintMutes(next);
    const clear = emptyMutes();
    setMask(next);
    setMuted(flags);
    setSolo(clear);
    const engine = engineRef.current;
    engine?.setSolos(clear);
    engine?.setMutes(flags);
  }

  function toggleMute(id: StemId) {
    setMuted((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      engineRef.current?.setMutes(next);
      return next;
    });
    setMask("custom");
  }

  function toggleSolo(id: StemId) {
    setSolo((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      engineRef.current?.setSolos(next);
      return next;
    });
    setMask("custom");
  }

  function setStemVol(id: StemId, value: number) {
    setVols((prev) => {
      const next = { ...prev, [id]: value };
      const engine = engineRef.current;
      if (engine) engine.setMix(next);
      return next;
    });
  }

  const songStep = step < 0 ? -1 : step % STEPS;
  const bar = songStep < 0 ? 0 : Math.floor(songStep / 16);
  const col = songStep < 0 ? -1 : songStep % 16;
  const anySolo = STEM_META.some((meta) => solo[meta.id]);

  finishRef.current = (job) => {
    if (mixRef.current?.id !== job.id) return;
    mixRef.current = null;
    const rig = rigRef.current;
    if (!rig) return;
    const time = rig.ctx.currentTime;
    job.outGain.gain.cancelScheduledValues(time);
    job.inGain.gain.cancelScheduledValues(time);
    job.outGain.gain.setValueAtTime(0, time);
    job.inGain.gain.setValueAtTime(1, time);
    job.outgoing.stop();
    job.incoming.setMix(job.track.mix);
    job.incoming.setFilter(1);
    job.incoming.setSwing(job.track.swing);
    rig.live = job.incomingSide;
    engineRef.current = job.incoming;
    const clear = emptyMutes();
    const follow = nextTrack(job.track.id);
    job.outgoing.setMutes(clear);
    job.outgoing.setSolos(clear);
    job.outgoing.setTrack(follow);
    job.outgoing.setFilter(1);
    setTrackId(job.track.id);
    setLiveSide(job.incomingSide);
    setNextId(follow.id);
    setSlot({
      a: job.incomingSide === "a" ? job.track.id : follow.id,
      b: job.incomingSide === "b" ? job.track.id : follow.id,
    });
    setVols(job.track.mix);
    setMuted(clear);
    setSolo(clear);
    setMask("full");
    setLoopBars(0);
    setEcho(false);
    setBands({ low: 1, mid: 1, high: 1 });
    setOpen(1);
    setSwing(job.track.swing);
    setMixing(null);
    setMixProgress(1);
    setPlaying(true);
    playingRef.current = true;
    const matched = job.incoming.bpm;
    if (Math.abs(matched - job.track.bpm) < 1) {
      job.incoming.setBpm(job.track.bpm);
      setBpm(Math.round(job.track.bpm));
      glideRef.current = null;
      return;
    }
    glideRef.current = {
      from: matched,
      to: job.track.bpm,
      start: time,
      dur: (8 * 60) / Math.min(matched, job.track.bpm),
      shown: Math.round(matched),
    };
    setBpm(Math.round(matched));
  };

  abortRef.current = () => {
    const job = mixRef.current;
    if (!job) return;
    mixRef.current = null;
    const time = job.outgoing.ctx.currentTime;
    job.outGain.gain.cancelScheduledValues(time);
    job.inGain.gain.cancelScheduledValues(time);
    job.outGain.gain.setValueAtTime(1, time);
    job.inGain.gain.setValueAtTime(0, time);
    job.incoming.stop();
    job.outgoing.setMix(job.outMix);
    setMixing(null);
    setMixProgress(0);
  };

  return (
    <main className="min-h-dvh bg-bg text-fg" data-playing={playing ? "yes" : "no"}>
      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 sm:px-8 sm:py-6">
        <header className="rise flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-widest text-acid">STEM MACHINE</p>
            <h1 className="mt-1 font-display text-4xl font-extrabold leading-none sm:text-5xl">FLOOR</h1>
            <p className="mt-2 max-w-md text-sm leading-snug text-pretty text-muted">
              Cut any stem. The rest of the instrumental keeps playing.
            </p>
          </div>
          <button
            type="button"
            className="tap grid size-16 shrink-0 place-items-center rounded-full bg-acid text-acid-ink"
            aria-label={playing ? "Stop the track" : "Play the track"}
            aria-pressed={playing}
            onClick={() => void togglePlay()}
          >
            <span className="grid place-items-center">
              <Play
                className="icon-swap size-7"
                data-on={playing ? "false" : "true"}
                strokeWidth={2.4}
                aria-hidden
              />
              <Square
                className="icon-swap size-5"
                data-on={playing ? "true" : "false"}
                strokeWidth={2.4}
                aria-hidden
              />
            </span>
          </button>
        </header>

        <p className="rise rise-2 mt-3 flex items-baseline justify-between text-xs text-muted">
          <span className="tabular-nums">
            {playing ? `Bar ${String(bar + 1).padStart(2, "0")} / ${BARS}` : "Ready"}
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
                  "rounded-full border px-2 py-1 text-center text-xs font-semibold",
                  on ? "border-acid bg-acid text-acid-ink" : "border-line bg-surface text-muted",
                )}
              >
                {name}
              </p>
            );
          })}
        </div>

        <div className="rise rise-2 mt-2 grid gap-2" aria-label="Decks">
          {(["a", "b"] as const).map((side) => {
            const deckTrack = TRACKS.find((item) => item.id === slot[side]) ?? TRACKS[0];
            const status = !mixing ? (side === liveSide ? "Live" : "Cue") : side === liveSide ? "Out" : "In";
            return (
              <DeckWave
                key={side}
                side={side}
                track={deckTrack}
                status={status}
                headRef={(node) => {
                  heads.current[side] = node;
                }}
                shadeRef={(node) => {
                  shades.current[side] = node;
                }}
              />
            );
          })}
        </div>

        <div className="rise rise-3 mt-4">
          <p className="text-xs font-semibold tracking-widest text-muted">EDM</p>
          <TrackGrid items={TRACKS.filter((item) => item.kind !== "lofi")} current={track.id} onPick={selectTrack} />
          <p className="mt-3 text-xs font-semibold tracking-widest text-muted">Lofi</p>
          <TrackGrid items={TRACKS.filter((item) => item.kind === "lofi")} current={track.id} onPick={selectTrack} />
        </div>

        <div className="rise rise-3 mt-6 grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-semibold tracking-widest text-muted">Next</span>
            <select
              className="next-song"
              aria-label="Next song"
              value={TRACKS.some((item) => item.id === nextId && item.id !== track.id) ? nextId : nextTrack(track.id).id}
              disabled={Boolean(mixing)}
              onChange={(event) => cueNext(event.target.value)}
            >
              {TRACKS.filter((item) => item.id !== track.id).map((item) => (
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
              "tap rounded-full border px-4 py-2 text-xs font-semibold",
              mixing ? "border-acid bg-acid text-acid-ink" : "border-line bg-surface",
            )}
            onClick={() => void autoMix()}
          >
            {mixing ? `Mixing · ${mixing}` : "Auto mix"}
          </button>
        </div>
        {mixing ? (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface" aria-hidden>
            <div className="h-full bg-acid" style={{ width: `${Math.round(mixProgress * 100)}%` }} />
          </div>
        ) : null}

        <div className="rise rise-3 mt-6 grid grid-cols-3 gap-2" role="group" aria-label="Stem groups">
          {(
            [
              ["full", "Full mix"],
              ["nodrums", "No drums"],
              ["nomusic", "No music"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mask === id}
              className={cx(
                "tap rounded-full border px-2 py-2 text-xs font-semibold tracking-wide",
                mask === id ? "border-acid bg-acid text-acid-ink" : "border-line bg-surface text-fg",
              )}
              onClick={() => applyMask(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="rise rise-4 mt-3 sm:grid sm:grid-cols-2 sm:gap-x-8" aria-label="Stems">
          {STEM_META.map((meta, index) => {
            const Icon = ICONS[meta.id];
            const cut = muted[meta.id] || (anySolo && !solo[meta.id]);
            const activity = barActivity(track, meta.id, bar);
            return (
              <article key={meta.id} className={cx("stem", cut && "is-cut")}>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted" strokeWidth={2.2} aria-hidden />
                    <p className="shrink-0 font-display text-base font-bold tracking-wide">{meta.name}</p>
                    <p className="hidden text-xs text-muted sm:block">{meta.hint}</p>
                    <button
                      type="button"
                      className="solo shrink-0"
                      aria-pressed={solo[meta.id]}
                      onClick={() => toggleSolo(meta.id)}
                    >
                      Solo
                    </button>
                    <div className="meter" aria-hidden>
                      <span ref={(el) => { meters.current[index] = el; }} />
                    </div>
                  </div>
                  <div className="step-row" aria-hidden>
                    {activity.map((on, i) => (
                      <span key={i} className={cx("step", on && "on", i === col && "now")} />
                    ))}
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
                  className={cx("btn-cut tap", cut && "is-cut")}
                  aria-pressed={muted[meta.id]}
                  aria-keyshortcuts={meta.keys}
                  onClick={() => toggleMute(meta.id)}
                >
                  {muted[meta.id] ? "In" : "Cut"}
                </button>
              </article>
            );
          })}
        </section>

        <section className="rise rise-3 mt-3" aria-label="Deck">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <button
              type="button"
              className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
              aria-label="Nudge tempo down"
              {...hold(() => engineRef.current?.nudge(-1), () => engineRef.current?.nudge(0))}
            >
              Bend −
            </button>
            <button
              type="button"
              className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
              aria-label="Cue to the start"
              onClick={() => {
                void engineRef.current?.cue();
                setPlaying(true);
              }}
            >
              Cue
            </button>
            <button
              type="button"
              className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
              aria-label="Vinyl brake"
              onClick={() => engineRef.current?.brake()}
            >
              Brake
            </button>
            <button
              type="button"
              className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
              aria-label="Backspin the platter"
              onClick={() => engineRef.current?.backspin()}
            >
              Backspin
            </button>
            <button
              type="button"
              aria-pressed={echo}
              aria-label="Echo throw"
              className={cx(
                "tap rounded-full border px-2 py-2 text-xs font-semibold",
                echo ? "border-acid bg-acid text-acid-ink" : "border-line bg-surface",
              )}
              onClick={() => {
                const next = !echo;
                setEcho(next);
                engineRef.current?.setEcho(next);
              }}
            >
              Echo
            </button>
            <button
              type="button"
              className="tap rounded-full border border-line bg-surface px-2 py-2 text-xs font-semibold"
              aria-label="Nudge tempo up"
              {...hold(() => engineRef.current?.nudge(1), () => engineRef.current?.nudge(0))}
            >
              Bend +
            </button>
          </div>
          <p className="mt-3 text-xs font-semibold tracking-widest text-muted">Loop</p>
          <div className="mt-2 grid grid-cols-6 gap-1" role="group" aria-label="Loop length">
            {LOOP_BARS.map((bars) => (
              <button
                key={bars}
                type="button"
                aria-pressed={loopBars === bars}
                aria-label={`Loop ${bars} bars`}
                className={cx(
                  "tap rounded-full border px-1 py-2 text-xs font-semibold tabular-nums",
                  loopBars === bars ? "border-acid bg-acid text-acid-ink" : "border-line bg-surface",
                )}
                onClick={() => {
                  const next = loopBars === bars ? 0 : bars;
                  setLoopBars(next);
                  engineRef.current?.setLoop(next);
                }}
              >
                {bars}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            {(
              [
                ["low", "Low"],
                ["mid", "Mid"],
                ["high", "High"],
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
                    engineRef.current?.setBands(next.low, next.mid, next.high);
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
                  engineRef.current?.setFilter(value);
                }}
              />
            </label>
          </div>
          <p className="mt-3 text-xs font-semibold tracking-widest text-muted">Stereo</p>
          <div className="mt-2 grid grid-cols-3 gap-1" role="group" aria-label="Left right stereo switch">
            {STEREO_MODES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={stereo === id}
                className={cx(
                  "tap rounded-full border px-2 py-2 text-xs font-semibold",
                  stereo === id ? "border-acid bg-acid text-acid-ink" : "border-line bg-surface",
                )}
                onClick={() => {
                  setStereo(id);
                  const rig = rigRef.current;
                  if (rig) applyStereo(rig.stereo, id, rig.ctx.currentTime);
                }}
              >
                {label}
              </button>
            ))}
          </div>
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
                glideRef.current = null;
                setBpm(value);
                const job = mixRef.current;
                if (job) {
                  job.outgoing.setBpm(value);
                  job.incoming.setBpm(value);
                  return;
                }
                engineRef.current?.setBpm(value);
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
                engineRef.current?.setSwing(value);
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
                const rig = rigRef.current;
                rig?.decks.a.engine.setMaster(value);
                rig?.decks.b.engine.setMaster(value);
              }}
            />
          </label>
        </section>

        <p className="mt-4 text-xs text-muted">
          Space plays. Keys 1–8 cut a stem. Auto mix brings in the next track.
        </p>
      </div>
    </main>
  );
}
