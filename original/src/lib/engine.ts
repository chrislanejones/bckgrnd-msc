import {
  midiHz,
  STEM_META,
  STEPS,
  type NoteEvent,
  type StemId,
  type Track,
} from "@/lib/music";

type Chan = {
  input: GainNode;
  pump: GainNode;
  fader: GainNode;
  analyser: AnalyserNode;
  vol: number;
  muted: boolean;
  solo: boolean;
};

const DUCK: Record<Track["kind"], StemId[]> = {
  house: ["bass", "stab", "pad", "lead", "arp"],
  deep: ["bass", "stab", "pad", "lead", "arp"],
  acid: ["pad", "stab", "arp"],
  lofi: ["bass", "pad"],
};

const SEND: Record<StemId, number> = {
  kick: 0,
  clap: 0.05,
  hats: 0.06,
  bass: 0,
  stab: 0.16,
  lead: 0.3,
  pad: 0.2,
  arp: 0.28,
};

function curve(amount: number): Float32Array<ArrayBuffer> {
  const data = new Float32Array(new ArrayBuffer(1024 * 4));
  const norm = Math.tanh(amount);
  for (let i = 0; i < data.length; i += 1) {
    const x = (i / (data.length - 1)) * 2 - 1;
    data[i] = Math.tanh(x * amount) / norm;
  }
  return data;
}

function impulse(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 0.35);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c += 1) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < len; i += 1) {
      const env = (1 - i / len) ** 2.8;
      data[i] = (Math.random() * 2 - 1) * env * (c === 0 ? 1 : 0.85);
    }
  }
  return buf;
}

export class FloorEngine {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly delay: DelayNode;
  private readonly noise: AudioBuffer;
  private readonly scope: AnalyserNode;
  private readonly scopeBuf: Uint8Array<ArrayBuffer>;
  private readonly wave: Uint8Array<ArrayBuffer>;
  private readonly stems: Record<StemId, Chan>;
  private readonly pumps: Partial<Record<StemId, GainNode>> = {};
  private readonly sources: AudioScheduledSourceNode[] = [];
  private queue: { step: number; time: number }[] = [];
  private shown = -1;
  private timer = 0;
  private raf = 0;
  private nextTime = 0;
  private step = 0;
  private playing = false;
  private readonly delayFb: GainNode;
  private readonly delayWet: GainNode;
  private readonly echoThrow: GainNode;
  private readonly dry: GainNode;
  private readonly low: BiquadFilterNode;
  private readonly mid: BiquadFilterNode;
  private readonly high: BiquadFilterNode;
  private readonly sweep: BiquadFilterNode;
  private readonly ownsContext: boolean;
  private rate = 1;
  private brakeFrom = 0;
  private spinFrom = 0;
  private ringWrite = 0;
  private ringL = new Float32Array(0);
  private ringR = new Float32Array(0);
  private recorder: ScriptProcessorNode | null = null;
  private loopSteps = 0;
  private loopStart = 0;
  private levels = STEM_META.map(() => 0);
  bpm = 126;
  swing = 0.22;
  track: Track;

  constructor(track: Track, output?: AudioNode) {
    this.track = track;
    this.bpm = track.bpm;
    this.swing = track.swing;
    const ctx = (output?.context as AudioContext | undefined) ?? new AudioContext();
    this.ctx = ctx;
    this.ownsContext = !output;

    const sum = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 28;
    hp.Q.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 8;
    comp.ratio.value = 2.6;
    comp.attack.value = 0.008;
    comp.release.value = 0.2;
    const shaper = ctx.createWaveShaper();
    shaper.curve = curve(1.35);
    shaper.oversample = "2x";
    this.master = ctx.createGain();
    this.master.gain.value = 0.78;
    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.scope = ctx.createAnalyser();
    this.scope.fftSize = 1024;
    this.scope.smoothingTimeConstant = 0.75;
    this.scopeBuf = new Uint8Array(new ArrayBuffer(this.scope.fftSize));
    this.wave = new Uint8Array(new ArrayBuffer(256));

    sum.connect(hp);
    hp.connect(comp);
    comp.connect(shaper);
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    low.frequency.value = 180;
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 0.7;
    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 3200;
    const sweep = ctx.createBiquadFilter();
    sweep.type = "lowpass";
    sweep.frequency.value = 18000;
    sweep.Q.value = 0.45;
    shaper.connect(this.dry);
    this.dry.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(sweep);
    this.low = low;
    this.mid = mid;
    this.high = high;
    this.sweep = sweep;
    const ringSize = Math.floor(ctx.sampleRate * 2);
    this.ringL = new Float32Array(ringSize);
    this.ringR = new Float32Array(ringSize);
    const recorder = ctx.createScriptProcessor(2048, 2, 2);
    this.recorder = recorder;
    recorder.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const output = event.outputBuffer;
      const leftIn = input.getChannelData(0);
      const rightIn = input.numberOfChannels > 1 ? input.getChannelData(1) : leftIn;
      const leftOut = output.getChannelData(0);
      const rightOut = output.numberOfChannels > 1 ? output.getChannelData(1) : leftOut;
      const size = this.ringL.length;
      let write = this.ringWrite;
      for (let i = 0; i < leftIn.length; i += 1) {
        const l = leftIn[i] ?? 0;
        const r = rightIn[i] ?? l;
        this.ringL[write] = l;
        this.ringR[write] = r;
        leftOut[i] = l;
        if (rightOut !== leftOut) rightOut[i] = r;
        write += 1;
        if (write >= size) write = 0;
      }
      this.ringWrite = write;
    };
    sweep.connect(recorder);
    recorder.connect(this.master);
    this.master.connect(this.scope);
    this.scope.connect(output ?? ctx.destination);

    const pre = ctx.createBiquadFilter();
    pre.type = "highpass";
    pre.frequency.value = 380;
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.07;
    sum.connect(pre);
    pre.connect(verb);
    verb.connect(wet);
    wet.connect(hp);

    this.delay = ctx.createDelay(1.5);
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2400;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const delayWet = ctx.createGain();
    delayWet.gain.value = 0.24;
    this.delayFb = fb;
    this.delayWet = delayWet;
    this.delay.connect(damp);
    damp.connect(fb);
    fb.connect(this.delay);
    this.delay.connect(delayWet);
    delayWet.connect(hp);
    const echoHp = ctx.createBiquadFilter();
    echoHp.type = "highpass";
    echoHp.frequency.value = 240;
    const echoThrow = ctx.createGain();
    echoThrow.gain.value = 0;
    this.echoThrow = echoThrow;
    sum.connect(echoHp);
    echoHp.connect(echoThrow);
    echoThrow.connect(this.delay);

    const noiseLen = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const noiseData = this.noise.getChannelData(0);
    for (let i = 0; i < noiseLen; i += 1) noiseData[i] = Math.random() * 2 - 1;

    const stems = {} as Record<StemId, Chan>;
    for (const meta of STEM_META) {
      const input = ctx.createGain();
      const pump = ctx.createGain();
      const fader = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.45;
      const send = ctx.createGain();
      input.connect(pump);
      pump.connect(fader);
      fader.connect(analyser);
      analyser.connect(sum);
      fader.connect(send);
      send.connect(this.delay);
      send.gain.value = SEND[meta.id];
      fader.gain.value = track.mix[meta.id];
      stems[meta.id] = {
        input,
        pump,
        fader,
        analyser,
        vol: track.mix[meta.id],
        muted: false,
        solo: false,
      };
      this.pumps[meta.id] = pump;
    }
    this.stems = stems;
    this.syncDelay();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    STEM_META.forEach((meta, i) => {
      const analyser = this.stems[meta.id].analyser;
      analyser.getByteTimeDomainData(this.wave);
      let sum = 0;
      for (let k = 0; k < this.wave.length; k += 1) {
        const v = (this.wave[k] - 128) / 128;
        sum += v * v;
      }
      const target = Math.min(1, Math.sqrt(sum / this.wave.length) * 4.2);
      const prev = this.levels[i] ?? 0;
      this.levels[i] = target > prev ? target : prev * 0.84;
    });
    this.scope.getByteTimeDomainData(this.scopeBuf);
  };

  readLevels(): number[] {
    return this.levels;
  }

  scopeData(): Uint8Array<ArrayBuffer> {
    return this.scopeBuf;
  }

  visualStep(): number {
    if (!this.playing) return -1;
    const now = this.ctx.currentTime;
    let shown = this.shown;
    let i = 0;
    while (i < this.queue.length && this.queue[i].time <= now) {
      shown = this.queue[i].step;
      i += 1;
    }
    if (i > 0) this.queue.splice(0, i);
    this.shown = shown;
    return shown;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  nudge(dir: -1 | 0 | 1) {
    if (this.brakeFrom || this.spinFrom) return;
    this.applyRate(dir === 0 ? 1 : dir < 0 ? 0.9 : 1.1);
  }

  brake() {
    if (!this.playing || this.brakeFrom || this.spinFrom) return;
    this.brakeFrom = this.ctx.currentTime;
  }

  backspin() {
    if (!this.playing || this.brakeFrom || this.spinFrom) return;
    this.spinFrom = this.ctx.currentTime;
    this.haltSources();
    this.queue = [];
    this.shown = -1;
    this.rewind(this.spinFrom);
  }

  cue() {
    const at = this.loopSteps > 0 ? this.loopStart : 0;
    if (!this.playing) {
      void this.play().then(() => this.jump(at));
      return;
    }
    this.jump(at);
  }

  setLoop(bars: number) {
    if (bars <= 0) {
      this.loopSteps = 0;
      this.loopStart = 0;
      return;
    }
    const size = Math.round(bars) * 16;
    this.loopSteps = size;
    if (size >= STEPS) {
      this.loopStart = 0;
      return;
    }
    const origin = this.playing ? this.step % STEPS : 0;
    let start = Math.floor(origin / size) * size;
    if (start + size > STEPS) start = STEPS - size;
    this.loopStart = Math.max(0, start);
  }

  setBands(low: number, mid: number, high: number) {
    const time = this.ctx.currentTime;
    this.low.gain.setTargetAtTime(this.bandDb(low), time, 0.02);
    this.mid.gain.setTargetAtTime(this.bandDb(mid), time, 0.02);
    this.high.gain.setTargetAtTime(this.bandDb(high), time, 0.02);
  }

  setFilter(open: number) {
    const amount = Math.min(1, Math.max(0, open));
    const freq = 240 * (18000 / 240) ** amount;
    const time = this.ctx.currentTime;
    this.sweep.frequency.cancelScheduledValues(time);
    this.sweep.frequency.setTargetAtTime(freq, time, 0.015);
    this.sweep.Q.setTargetAtTime(amount > 0.97 ? 0.45 : 0.85, time, 0.03);
  }

  blendFilter(fromOpen: number, toOpen: number, start: number, end: number) {
    const freq = (open: number) => {
      const amount = Math.min(1, Math.max(0, open));
      return 240 * (18000 / 240) ** amount;
    };
    const t0 = Math.max(start, this.ctx.currentTime);
    const t1 = Math.max(t0 + 0.08, end);
    const node = this.sweep.frequency;
    node.cancelScheduledValues(t0);
    node.setValueAtTime(freq(fromOpen), t0);
    node.exponentialRampToValueAtTime(Math.max(30, freq(toOpen)), t1);
  }

  nextDownbeat(bars = 1, minAhead = 0.28): number {
    const grid = Math.max(1, Math.round(bars)) * 16;
    const earliest = this.ctx.currentTime + minAhead;
    if (!this.playing) return earliest + (60 / Math.max(40, this.bpm)) * bars;
    let step = this.step;
    let time = this.nextTime;
    for (let i = 0; i < STEPS + 32; i += 1) {
      if (step % grid === 0 && time >= earliest) return time;
      time += this.stepDuration(step);
      step = this.forward(step);
    }
    return earliest;
  }

  private forward(step: number): number {
    const next = step + 1;
    if (this.loopSteps > 0) {
      const end = this.loopStart + this.loopSteps;
      return next >= end ? this.loopStart : next;
    }
    return next >= STEPS ? 0 : next;
  }

  setEcho(on: boolean) {
    const time = this.ctx.currentTime;
    const throwGain = this.echoThrow.gain;
    const feedback = this.delayFb.gain;
    const wet = this.delayWet.gain;
    const dry = this.dry.gain;
    throwGain.cancelScheduledValues(time);
    feedback.cancelScheduledValues(time);
    wet.cancelScheduledValues(time);
    dry.cancelScheduledValues(time);
    throwGain.setValueAtTime(throwGain.value, time);
    feedback.setValueAtTime(feedback.value, time);
    wet.setValueAtTime(wet.value, time);
    dry.setValueAtTime(dry.value, time);
    if (on) {
      throwGain.linearRampToValueAtTime(0.9, time + 0.02);
      feedback.linearRampToValueAtTime(0.78, time + 0.03);
      wet.linearRampToValueAtTime(0.95, time + 0.02);
      dry.linearRampToValueAtTime(0.55, time + 0.03);
      return;
    }
    throwGain.linearRampToValueAtTime(0, time + 0.04);
    feedback.linearRampToValueAtTime(0.2, time + 1.05);
    wet.linearRampToValueAtTime(0.18, time + 1.2);
    dry.linearRampToValueAtTime(1, time + 0.08);
  }

  private bandDb(amount: number): number {
    if (amount <= 0.02) return -36;
    return Math.max(-36, Math.min(6, 20 * Math.log10(amount)));
  }

  private applyRate(next: number) {
    this.rate = next;
    this.syncDelay();
  }

  private jump(at: number) {
    this.haltSources();
    this.queue = [];
    this.shown = -1;
    this.step = at;
    this.nextTime = this.ctx.currentTime + 0.04;
  }

  rampStem(id: StemId, to: number, seconds: number) {
    const gain = this.stems[id].fader.gain;
    const time = this.ctx.currentTime;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    gain.linearRampToValueAtTime(Math.max(0, to), time + Math.max(0.05, seconds));
  }

  setMaster(value: number) {
    this.master.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  }

  setBpm(bpm: number) {
    this.bpm = bpm;
    this.syncDelay();
  }

  setSwing(swing: number) {
    this.swing = swing;
  }

  setTrack(track: Track) {
    this.brakeFrom = 0;
    this.spinFrom = 0;
    this.rate = 1;
    this.loopSteps = 0;
    this.loopStart = 0;
    this.ringL.fill(0);
    this.ringR.fill(0);
    this.track = track;
    this.bpm = track.bpm;
    this.swing = track.swing;
    this.syncDelay();
    this.setMix(track.mix);
    if (this.playing) this.restartClock();
  }

  setMix(mix: Track["mix"]) {
    for (const meta of STEM_META) this.stems[meta.id].vol = mix[meta.id];
    this.applyFaders();
  }

  setMutes(muted: Record<StemId, boolean>) {
    for (const meta of STEM_META) this.stems[meta.id].muted = muted[meta.id];
    this.applyFaders();
  }

  setSolos(solo: Record<StemId, boolean>) {
    for (const meta of STEM_META) this.stems[meta.id].solo = solo[meta.id];
    this.applyFaders();
  }

  private audible(id: StemId): boolean {
    const chan = this.stems[id];
    const anySolo = STEM_META.some((meta) => this.stems[meta.id].solo);
    return !chan.muted && (!anySolo || chan.solo);
  }

  private applyFaders() {
    const time = this.ctx.currentTime;
    for (const meta of STEM_META) {
      const chan = this.stems[meta.id];
      const target = this.audible(meta.id) ? chan.vol : 0;
      const gain = chan.fader.gain;
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(gain.value, time);
      gain.setTargetAtTime(target, time, 0.012);
    }
  }

  private syncDelay() {
    const dotted = Math.min(1.2, (60 / (this.bpm * Math.max(0.2, this.rate))) * 0.75);
    this.delay.delayTime.setTargetAtTime(dotted, this.ctx.currentTime, 0.04);
  }

  async play(when = 0) {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const at = when > this.ctx.currentTime ? when : this.ctx.currentTime + 0.05;
    if (this.playing) this.restartClock(at);
    else {
      this.playing = true;
      this.brakeFrom = 0;
      this.spinFrom = 0;
      this.rate = 1;
      this.step = 0;
      this.shown = -1;
      this.queue = [];
      this.nextTime = at;
      this.timer = window.setInterval(this.tick, 25);
      this.tick();
    }
  }

  stop() {
    this.playing = false;
    this.brakeFrom = 0;
    this.spinFrom = 0;
    this.rate = 1;
    this.syncDelay();
    window.clearInterval(this.timer);
    this.timer = 0;
    this.haltSources();
    this.queue = [];
    this.shown = -1;
    const time = this.ctx.currentTime;
    for (const meta of STEM_META) {
      const pump = this.pumps[meta.id];
      if (!pump) continue;
      pump.gain.cancelScheduledValues(time);
      pump.gain.setValueAtTime(1, time);
    }
  }

  dispose() {
    this.stop();
    cancelAnimationFrame(this.raf);
    if (this.recorder) {
      this.recorder.onaudioprocess = null;
      this.recorder.disconnect();
    }
    if (this.ownsContext) void this.ctx.close();
  }

  private restartClock(when = 0) {
    this.haltSources();
    this.queue = [];
    this.shown = -1;
    this.step = 0;
    this.brakeFrom = 0;
    this.spinFrom = 0;
    this.rate = 1;
    this.nextTime = when > this.ctx.currentTime ? when : this.ctx.currentTime + 0.05;
  }

  private haltSources() {
    const time = this.ctx.currentTime;
    for (const src of this.sources.splice(0)) {
      try {
        src.stop(time);
      } catch {
        /* already stopped */
      }
    }
  }

  private tick = () => {
    if (!this.playing) return;
    if (this.brakeFrom) {
      const progress = (this.ctx.currentTime - this.brakeFrom) / 0.85;
      if (progress >= 1) {
        this.stop();
        return;
      }
      this.applyRate(Math.max(0.12, (1 - progress) ** 1.7));
    } else if (this.spinFrom) {
      const elapsed = this.ctx.currentTime - this.spinFrom;
      if (elapsed >= 0.7) {
        this.spinFrom = 0;
        this.rate = 1;
        this.syncDelay();
        this.haltSources();
        this.queue = [];
        this.nextTime = this.ctx.currentTime + 0.02;
      } else {
        const p = elapsed / 0.7;
        this.rate = 1.15 + Math.sin(p * Math.PI) * 5.2;
      }
    }
    const horizon = this.ctx.currentTime + 0.14;
    let guard = 0;
    while (this.nextTime < horizon && guard < 24) {
      if (!this.spinFrom) this.schedule(this.step, this.nextTime);
      this.queue.push({ step: this.step, time: this.nextTime });
      this.nextTime += this.stepDuration(this.step);
      this.step = this.nextStep();
      guard += 1;
    }
  };

  private nextStep(): number {
    const dir = this.spinFrom ? -1 : 1;
    const next = this.step + dir;
    if (this.loopSteps > 0) {
      const end = this.loopStart + this.loopSteps;
      if (dir > 0) return next >= end ? this.loopStart : next;
      return next < this.loopStart ? end - 1 : next;
    }
    if (dir > 0) return next >= STEPS ? 0 : next;
    return next < 0 ? STEPS - 1 : next;
  }

  private rewind(time: number) {
    const taken = this.reversedTake(1.35);
    if (taken) {
      const src = this.ctx.createBufferSource();
      src.buffer = taken;
      src.playbackRate.setValueAtTime(0.62, time);
      src.playbackRate.exponentialRampToValueAtTime(2.8, time + 0.42);
      src.playbackRate.exponentialRampToValueAtTime(1.15, time + 0.66);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.92, time + 0.02);
      g.gain.setValueAtTime(1, time + 0.48);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.68);
      src.connect(g);
      g.connect(this.master);
      src.start(time);
      src.stop(time + 0.7);
      this.watch(src, [g]);
    } else {
      this.syntheticSpin(time);
    }
    const hiss = this.ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2400;
    const hg = this.ctx.createGain();
    hg.gain.setValueAtTime(0.0001, time);
    hg.gain.exponentialRampToValueAtTime(0.04, time + 0.05);
    hg.gain.exponentialRampToValueAtTime(0.0001, time + 0.66);
    hiss.connect(hp);
    hp.connect(hg);
    hg.connect(this.master);
    hiss.start(time);
    hiss.stop(time + 0.68);
    this.watch(hiss, [hp, hg]);
  }

  private reversedTake(seconds: number): AudioBuffer | null {
    const rate = this.ctx.sampleRate;
    const size = this.ringL.length;
    const n = Math.min(size - 1, Math.floor(rate * seconds));
    if (n < rate * 0.25) return null;
    const buf = this.ctx.createBuffer(2, n, rate);
    const left = buf.getChannelData(0);
    const right = buf.getChannelData(1);
    let energy = 0;
    const start = this.ringWrite;
    for (let i = 0; i < n; i += 1) {
      const idx = (start - 1 - i + size) % size;
      const l = this.ringL[idx] ?? 0;
      const r = this.ringR[idx] ?? 0;
      left[i] = l;
      right[i] = r;
      energy += l * l;
    }
    if (energy / n < 0.00002) return null;
    return buf;
  }

  private syntheticSpin(time: number) {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(92, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.18);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.0001, time);
    og.gain.exponentialRampToValueAtTime(0.4, time + 0.015);
    og.gain.exponentialRampToValueAtTime(0.0001, time + 0.2);
    osc.connect(og);
    og.connect(this.master);
    osc.start(time);
    osc.stop(time + 0.22);
    this.watch(osc, [og]);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2.2;
    bp.frequency.setValueAtTime(180, time + 0.06);
    bp.frequency.exponentialRampToValueAtTime(4600, time + 0.5);
    bp.frequency.exponentialRampToValueAtTime(900, time + 0.66);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, time + 0.06);
    g.gain.exponentialRampToValueAtTime(0.28, time + 0.14);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.66);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(time);
    src.stop(time + 0.68);
    this.watch(src, [bp, g]);
  }

  private stepDuration(step: number): number {
    const eighth = 60 / (this.bpm * this.rate) / 2;
    const ratio = 0.5 + this.swing * 0.16;
    return step % 2 === 0 ? eighth * ratio : eighth * (1 - ratio);
  }

  private seconds(step: number, len: number): number {
    let total = 0;
    for (let i = 0; i < Math.max(1, len); i += 1) {
      total += this.stepDuration(step + i);
    }
    return total;
  }

  private schedule(step: number, time: number) {
    const track = this.track;
    const at = ((step % STEPS) + STEPS) % STEPS;
    const kick = track.kick[at] ?? 0;
    if (kick > 0) {
      this.kick(time, kick);
      if (this.audible("kick")) this.duck(time);
    }
    const clap = track.clap[at] ?? 0;
    if (clap > 0) this.clap(time, clap);
    const open = track.hatOpen[at] ?? 0;
    const hat = track.hat[at] ?? 0;
    if (open > 0) this.hat(time, open, true);
    else if (hat > 0) this.hat(time, hat, false);
    this.note("bass", track.bass[at], step, time);
    this.note("stab", track.stab[at], step, time);
    this.note("lead", track.lead[at], step, time);
    this.note("pad", track.pad[at], step, time);
    this.note("arp", track.arp[at], step, time);
  }

  private duck(time: number) {
    const kind = this.track.kind;
    const floor = kind === "lofi" ? 0.78 : kind === "deep" ? 0.42 : kind === "acid" ? 0.34 : 0.22;
    const back = Math.min(0.48, (60 / this.bpm) * (kind === "lofi" ? 0.3 : kind === "deep" ? 0.7 : 0.55));
    for (const id of DUCK[kind]) {
      const pump = this.pumps[id];
      if (!pump) continue;
      const gain = pump.gain;
      gain.cancelScheduledValues(time);
      gain.setValueAtTime(floor, time);
      gain.linearRampToValueAtTime(1, time + back);
    }
  }

  private note(stem: StemId, ev: NoteEvent | null | undefined, step: number, time: number) {
    if (!ev) return;
    const hold = this.seconds(step, ev.len);
    if (stem === "bass") this.bass(time, ev, hold);
    else if (stem === "stab") this.stab(time, ev, hold);
    else if (stem === "lead") this.lead(time, ev, hold);
    else if (stem === "pad") this.pad(time, ev, hold);
    else this.arp(time, ev, hold);
  }

  private kick(time: number, vel: number) {
    const dest = this.stems.kick.input;
    const lofi = this.track.kind === "lofi";
    const body = this.ctx.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(lofi ? 108 : 168, time);
    body.frequency.exponentialRampToValueAtTime(49, time + 0.055);
    body.frequency.exponentialRampToValueAtTime(36, time + 0.22);
    const bg = this.ctx.createGain();
    bg.gain.setValueAtTime(0.0001, time);
    bg.gain.exponentialRampToValueAtTime((lofi ? 0.62 : 0.95) * vel, time + 0.004);
    bg.gain.exponentialRampToValueAtTime(0.0001, time + 0.36);
    body.connect(bg);
    bg.connect(dest);
    body.start(time);
    body.stop(time + 0.4);
    this.watch(body, [bg]);

    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(54, time);
    const sg = this.ctx.createGain();
    sg.gain.setValueAtTime(0.0001, time);
    sg.gain.exponentialRampToValueAtTime((lofi ? 0.32 : 0.55) * vel, time + 0.012);
    sg.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
    sub.connect(sg);
    sg.connect(dest);
    sub.start(time);
    sub.stop(time + 0.34);
    this.watch(sub, [sg]);

    const click = this.ctx.createBufferSource();
    click.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = lofi ? 680 : 1600;
    const cg = this.ctx.createGain();
    cg.gain.setValueAtTime((lofi ? 0.08 : 0.42) * vel, time);
    cg.gain.exponentialRampToValueAtTime(0.0001, time + 0.015);
    click.connect(hp);
    hp.connect(cg);
    cg.connect(dest);
    click.start(time);
    click.stop(time + 0.03);
    this.watch(click, [hp, cg]);
  }

  private clap(time: number, vel: number) {
    const dest = this.stems.clap.input;
    const lofi = this.track.kind === "lofi";
    const freq = lofi ? 780 : this.track.kind === "deep" ? 1250 : 1750;
    for (const delay of [0, 0.01, 0.021]) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = freq;
      bp.Q.value = 0.85;
      const g = this.ctx.createGain();
      const t = time + delay;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime((lofi ? 0.55 : 0.7) * vel, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.038);
      src.connect(bp);
      bp.connect(g);
      g.connect(dest);
      src.start(t);
      src.stop(t + 0.05);
      this.watch(src, [bp, g]);
    }
    const tail = this.ctx.createBufferSource();
    tail.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq * 0.82;
    bp.Q.value = 0.55;
    const g = this.ctx.createGain();
    const t = time + 0.018;
    const decay = lofi ? 0.28 : this.track.kind === "deep" ? 0.2 : 0.13;
    g.gain.setValueAtTime(0.5 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    tail.connect(bp);
    bp.connect(g);
    g.connect(dest);
    tail.start(t);
    tail.stop(t + decay + 0.02);
    this.watch(tail, [bp, g]);
  }

  private hat(time: number, vel: number, open: boolean) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    const lofi = this.track.kind === "lofi";
    hp.frequency.value = open ? (lofi ? 3400 : 5200) : lofi ? 2200 : this.track.kind === "acid" ? 7800 : 6400;
    const g = this.ctx.createGain();
    const decay = open
      ? lofi
        ? 0.2
        : this.track.kind === "deep"
          ? 0.15
          : 0.12
      : lofi
        ? 0.06
        : this.track.kind === "acid"
          ? 0.026
          : 0.038;
    g.gain.setValueAtTime(Math.max(0.001, vel * (lofi ? (open ? 0.5 : 0.4) : open ? 0.58 : 0.44)), time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.stems.hats.input);
    src.start(time);
    src.stop(time + decay + 0.02);
    this.watch(src, [hp, g]);
  }

  private bass(time: number, ev: NoteEvent, hold: number) {
    const freq = midiHz(ev.notes[0] ?? 45);
    if (this.track.kind === "acid") {
      this.acid(time, freq, ev, hold);
      return;
    }
    if (this.track.kind === "lofi") {
      this.tone({
        dest: this.stems.bass.input,
        time,
        freqs: [freq],
        type: "sine",
        detune: [0],
        peak: ev.vel * 0.46,
        attack: 0.02,
        decay: 0.22,
        sustain: 0.8,
        hold,
        release: 0.16,
        filterType: "lowpass",
        fStart: 140,
        fPeak: 360,
        fEnd: 160,
        q: 0.5,
        fAttack: 0.04,
        wide: false,
      });
      return;
    }
    const deep = this.track.kind === "deep";
    this.tone({
      dest: this.stems.bass.input,
      time,
      freqs: [freq],
      type: "sine",
      detune: [0],
      peak: ev.vel * (deep ? 0.55 : 0.48),
      attack: 0.006,
      decay: deep ? 0.18 : 0.1,
      sustain: deep ? 0.75 : 0.4,
      hold,
      release: deep ? 0.1 : 0.05,
      filterType: "lowpass",
      fStart: 200,
      fPeak: 800,
      fEnd: 200,
      q: 0.6,
      fAttack: 0.02,
      wide: false,
    });
    this.tone({
      dest: this.stems.bass.input,
      time,
      freqs: [freq],
      type: "sawtooth",
      detune: [0],
      peak: ev.vel * (deep ? 0.16 : 0.28),
      attack: 0.006,
      decay: deep ? 0.2 : 0.12,
      sustain: deep ? 0.55 : 0.28,
      hold,
      release: 0.06,
      filterType: "lowpass",
      fStart: deep ? 140 : 180,
      fPeak: deep ? 340 : 780,
      fEnd: deep ? 120 : 170,
      q: deep ? 3 : 7,
      fAttack: 0.03,
      wide: false,
    });
  }

  private acid(time: number, freq: number, ev: NoteEvent, hold: number) {
    const peak = ev.accent ? 2600 : 980;
    this.tone({
      dest: this.stems.bass.input,
      time,
      freqs: [freq],
      type: "sawtooth",
      detune: [4],
      peak: ev.vel * 0.4,
      attack: 0.004,
      decay: 0.09,
      sustain: 0.18,
      hold: Math.max(0.05, hold * 0.85),
      release: 0.04,
      filterType: "lowpass",
      fStart: Math.max(80, freq * 1.1),
      fPeak: peak,
      fEnd: Math.max(90, freq * 1.3),
      q: ev.accent ? 15 : 10,
      fAttack: 0.018,
      wide: false,
    });
  }

  private stab(time: number, ev: NoteEvent, hold: number) {
    const kind = this.track.kind;
    const freqs = ev.notes.map((n) => midiHz(n));
    if (kind === "lofi") {
      this.tone({
        dest: this.stems.stab.input,
        time,
        freqs,
        type: "sine",
        detune: [-6, 5],
        peak: ev.vel * 0.24,
        attack: 0.02,
        decay: 0.22,
        sustain: 0.28,
        hold,
        release: 0.22,
        filterType: "lowpass",
        fStart: 280,
        fPeak: 720,
        fEnd: 240,
        q: 0.6,
        fAttack: 0.04,
        wide: true,
      });
      return;
    }
    if (kind === "deep") {
      this.tone({
        dest: this.stems.stab.input,
        time,
        freqs,
        type: "triangle",
        detune: [0],
        peak: ev.vel * 0.22,
        attack: 0.012,
        decay: 0.18,
        sustain: 0.2,
        hold,
        release: 0.16,
        filterType: "lowpass",
        fStart: 360,
        fPeak: 980,
        fEnd: 280,
        q: 0.8,
        fAttack: 0.03,
        wide: true,
      });
      return;
    }
    this.tone({
      dest: this.stems.stab.input,
      time,
      freqs,
      type: "sawtooth",
      detune: [-6, 5],
      peak: ev.vel * (kind === "acid" ? 0.14 : 0.26),
      attack: 0.004,
      decay: kind === "acid" ? 0.08 : 0.13,
      sustain: 0.08,
      hold: Math.min(hold, kind === "acid" ? 0.08 : 0.14),
      release: 0.07,
      filterType: "lowpass",
      fStart: 420,
      fPeak: ev.accent || kind === "house" ? 2400 : 1700,
      fEnd: 380,
      q: kind === "acid" ? 5 : 2.4,
      fAttack: 0.012,
      wide: true,
    });
  }

  private lead(time: number, ev: NoteEvent, hold: number) {
    const kind = this.track.kind;
    const freq = midiHz(ev.notes[0] ?? 69);
    if (kind === "lofi") {
      this.tone({
        dest: this.stems.lead.input,
        time,
        freqs: [freq],
        type: "sine",
        detune: [0],
        peak: ev.vel * 0.2,
        attack: 0.04,
        decay: 0.2,
        sustain: 0.62,
        hold,
        release: 0.28,
        filterType: "lowpass",
        fStart: 280,
        fPeak: 640,
        fEnd: 320,
        q: 0.5,
        fAttack: 0.06,
        wide: false,
      });
      return;
    }
    if (kind === "deep") {
      this.tone({
        dest: this.stems.lead.input,
        time,
        freqs: [freq],
        type: "triangle",
        detune: [0],
        peak: ev.vel * 0.2,
        attack: 0.06,
        decay: 0.22,
        sustain: 0.6,
        hold,
        release: 0.24,
        filterType: "lowpass",
        fStart: 300,
        fPeak: 880,
        fEnd: 420,
        q: 0.6,
        fAttack: 0.1,
        wide: false,
      });
      return;
    }
    if (kind === "acid") {
      this.tone({
        dest: this.stems.lead.input,
        time,
        freqs: [freq],
        type: "sawtooth",
        detune: [3],
        peak: ev.vel * 0.12,
        attack: 0.008,
        decay: 0.1,
        sustain: 0.16,
        hold: Math.min(hold, 0.4),
        release: 0.08,
        filterType: "lowpass",
        fStart: Math.max(180, freq),
        fPeak: 980,
        fEnd: 360,
        q: 3.2,
        fAttack: 0.04,
        wide: false,
      });
      return;
    }
    this.tone({
      dest: this.stems.lead.input,
      time,
      freqs: [freq, freq],
      type: "triangle",
      detune: [-5, 6],
      peak: ev.vel * 0.16,
      attack: 0.016,
      decay: 0.18,
      sustain: 0.38,
      hold,
      release: 0.16,
      filterType: "lowpass",
      fStart: 280,
      fPeak: 980,
      fEnd: 420,
      q: 0.7,
      fAttack: 0.05,
      wide: true,
    });
  }

  private pad(time: number, ev: NoteEvent, hold: number) {
    const kind = this.track.kind;
    const freqs = ev.notes.flatMap((n) => [midiHz(n), midiHz(n)]);
    const detune = ev.notes.flatMap(() => [-9, 11]);
    this.tone({
      dest: this.stems.pad.input,
      time,
      freqs,
      type: kind === "acid" || kind === "lofi" ? "sine" : "sawtooth",
      detune,
      peak: ev.vel * (kind === "lofi" ? 0.1 : kind === "acid" ? 0.1 : 0.075),
      attack: kind === "lofi" ? 0.7 : kind === "deep" ? 0.55 : 0.4,
      decay: 0.35,
      sustain: 0.85,
      hold,
      release: 0.55,
      filterType: "lowpass",
      fStart: 280,
      fPeak: kind === "lofi" ? 520 : kind === "acid" ? 420 : kind === "deep" ? 760 : 900,
      fEnd: 360,
      q: 0.5,
      fAttack: 0.4,
      wide: true,
    });
  }

  private arp(time: number, ev: NoteEvent, hold: number) {
    const kind = this.track.kind;
    const freq = midiHz(ev.notes[0] ?? 69);
    this.tone({
      dest: this.stems.arp.input,
      time,
      freqs: [freq],
      type: kind === "lofi" ? "sine" : kind === "deep" ? "triangle" : "square",
      detune: [0],
      peak: ev.vel * (kind === "lofi" ? 0.22 : kind === "acid" ? 0.14 : 0.24),
      attack: kind === "lofi" ? 0.02 : 0.004,
      decay: kind === "lofi" ? 0.18 : kind === "deep" ? 0.12 : 0.07,
      sustain: 0.12,
      hold: Math.max(hold, 0.05),
      release: 0.05,
      filterType: "lowpass",
      fStart: 500,
      fPeak: kind === "lofi" ? 880 : ev.accent ? 2400 : 1600,
      fEnd: 480,
      q: kind === "acid" ? 3 : 1,
      fAttack: 0.012,
      wide: false,
    });
  }

  private tone(opts: {
    dest: AudioNode;
    time: number;
    freqs: number[];
    type: OscillatorType;
    detune: number[];
    peak: number;
    attack: number;
    decay: number;
    sustain: number;
    hold: number;
    release: number;
    filterType: BiquadFilterType;
    fStart: number;
    fPeak: number;
    fEnd: number;
    q: number;
    fAttack: number;
    wide: boolean;
  }) {
    const filter = this.ctx.createBiquadFilter();
    filter.type = opts.filterType;
    filter.Q.setValueAtTime(opts.q, opts.time);
    const startF = Math.max(30, opts.fStart);
    const peakF = Math.max(startF + 8, opts.fPeak);
    const endF = Math.max(30, opts.fEnd);
    filter.frequency.setValueAtTime(startF, opts.time);
    const attackAt = opts.time + Math.max(0.008, opts.fAttack);
    filter.frequency.exponentialRampToValueAtTime(peakF, attackAt);
    const endAt = Math.max(attackAt + 0.02, opts.time + Math.max(0.05, opts.hold));
    if (Math.abs(endF - peakF) > 4) {
      filter.frequency.exponentialRampToValueAtTime(endF, endAt);
    }
    const gain = this.ctx.createGain();
    const stopAt = this.env(
      gain,
      opts.time,
      opts.peak,
      opts.attack,
      opts.decay,
      opts.sustain,
      opts.hold,
      opts.release,
    );
    filter.connect(gain);
    gain.connect(opts.dest);
    const extra: AudioNode[] = [filter, gain];
    const oscs = opts.freqs.map((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = opts.type;
      osc.frequency.setValueAtTime(Math.max(28, freq), opts.time);
      const cents = opts.detune[i] ?? opts.detune[opts.detune.length - 1] ?? 0;
      osc.detune.setValueAtTime(cents, opts.time);
      if (opts.wide && opts.freqs.length > 1) {
        const panner = this.ctx.createStereoPanner();
        const span = opts.freqs.length - 1;
        panner.pan.setValueAtTime((i / span) * 1.1 - 0.55, opts.time);
        osc.connect(panner);
        panner.connect(filter);
        extra.push(panner);
      } else {
        osc.connect(filter);
      }
      osc.start(opts.time);
      osc.stop(stopAt + 0.02);
      return osc;
    });
    let left = oscs.length;
    for (const osc of oscs) {
      this.watch(osc, () => {
        left -= 1;
        if (left > 0) return;
        for (const node of extra) {
          try {
            node.disconnect();
          } catch {
            /* already gone */
          }
        }
      });
    }
  }

  private env(
    node: GainNode,
    time: number,
    peak: number,
    attack: number,
    decay: number,
    sustain: number,
    hold: number,
    release: number,
  ): number {
    const p = Math.max(0.001, peak);
    const s = Math.max(0.001, p * Math.min(1, Math.max(0, sustain)));
    const a = Math.max(0.004, attack);
    const d = Math.max(0.004, decay);
    const r = Math.max(0.012, release);
    const g = node.gain;
    g.setValueAtTime(0.0001, time);
    g.exponentialRampToValueAtTime(p, time + a);
    const decayAt = time + a + d;
    if (Math.abs(p - s) > 0.0008) g.exponentialRampToValueAtTime(s, decayAt);
    const relAt = Math.max(decayAt, time + Math.max(hold, a));
    g.setValueAtTime(s, relAt);
    const end = relAt + r;
    g.exponentialRampToValueAtTime(0.0001, end);
    return end;
  }

  private watch(src: AudioScheduledSourceNode, cleanup?: AudioNode[] | (() => void)) {
    this.sources.push(src);
    src.onended = () => {
      const i = this.sources.indexOf(src);
      if (i >= 0) this.sources.splice(i, 1);
      try {
        src.disconnect();
      } catch {
        /* already gone */
      }
      if (typeof cleanup === "function") cleanup();
      else {
        for (const node of cleanup ?? []) {
          try {
            node.disconnect();
          } catch {
            /* already gone */
          }
        }
      }
    };
  }
}
