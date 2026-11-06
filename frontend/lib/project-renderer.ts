/** Shared browser/native/MCP renderer. No DOM, filesystem or narration processing. */
import { compileLanes, LANE_IDS } from './patterns';
import { sceneVector } from './scenes';
import { RENDERER_VERSION, type Snapshot } from './snapshot';
import type { TrackArrangement } from './types';

export type RenderSettings = { startSeconds: number; seconds: number; fadeInSeconds: number; fadeOutSeconds: number; tailSeconds: number; sampleRate: number };
export const DEFAULT_RENDER: RenderSettings = { startSeconds: 0, seconds: 30, fadeInSeconds: 0, fadeOutSeconds: 0.02, tailSeconds: 0, sampleRate: 48000 };
export interface RenderEngine {
  load_track_wasm(json: string): boolean; set_bpm(value: number): void; set_swing(value: number): void;
  set_master(value: number): void; queue_scene(id: number, timing: number, values: Float32Array): number;
  queue_patterns(id: number, timing: number, link: number, values: Float32Array): number;
  play(): void; end_score(): void; process(left: Float32Array, right: Float32Array): void; free(): void;
}

export function applyProject(engine: RenderEngine, snapshot: Snapshot, source: TrackArrangement) {
  const p = snapshot.project;
  if (!engine.load_track_wasm(JSON.stringify(source))) throw new Error('Engine rejected the source arrangement.');
  engine.set_bpm(p.params['transport.bpm']);
  engine.set_swing(p.params['transport.swing']);
  engine.set_master(p.params['master.level']);
  if (engine.queue_scene(1, 0, sceneVector(p)) !== 0) throw new Error('Engine rejected project mix settings.');
  const lanes = LANE_IDS.flatMap((l) => p.patterns[l] ? [p.patterns[l]!] : []);
  if (lanes.length && engine.queue_patterns(2, 0, 0, compileLanes(lanes)) !== 0) throw new Error('Engine rejected project patterns.');
}

export async function renderProject(
  EngineClass: new (rate: number) => RenderEngine, snapshot: Snapshot, source: TrackArrangement, settings: RenderSettings,
  signal?: AbortSignal, progress?: (percent: number) => void,
) {
  const s = { ...settings };
  for (const [key, value] of Object.entries(s)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid export setting: ${key}.`);
  if (![44100, 48000].includes(s.sampleRate) || s.seconds <= 0 || s.seconds > 600 || s.startSeconds > 600 || s.tailSeconds > 30 || s.fadeInSeconds + s.fadeOutSeconds > s.seconds) throw new Error('Unsupported export range, sample rate, fade or tail. Maximum range is ten minutes.');
  signal?.throwIfAborted();
  const musicFrames = Math.round(s.seconds * s.sampleRate);
  const frames = musicFrames + Math.round(s.tailSeconds * s.sampleRate);
  const skip = Math.round(s.startSeconds * s.sampleRate);
  const wav = new Uint8Array(44 + frames * 4);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, s.sampleRate, true); view.setUint32(28, s.sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, frames * 4, true);
  const engine = new EngineClass(s.sampleRate);
  let peak = 0; let sum = 0;
  try {
    applyProject(engine, structuredClone(snapshot), source);
    engine.play();
    const left = new Float32Array(128), right = new Float32Array(128);
    let yieldAt = 0;
    for (let at = 0; at < skip + frames;) {
      if (at === skip + musicFrames) engine.end_score();
      const boundary = at < skip + musicFrames ? skip + musicFrames : skip + frames;
      const count = Math.min(128, boundary - at);
      engine.process(left.subarray(0, count), right.subarray(0, count));
      for (let i = 0; i < count; i++) {
        const n = at + i - skip;
        if (n < 0 || n >= frames) continue;
        const fadeIn = s.fadeInSeconds * s.sampleRate, fadeOut = s.fadeOutSeconds * s.sampleRate;
        let gain = 1;
        if (fadeIn > 0 && n < fadeIn) gain *= 0.5 - 0.5 * Math.cos(Math.PI * n / fadeIn);
        if (fadeOut > 0 && frames - 1 - n < fadeOut) gain *= 0.5 - 0.5 * Math.cos(Math.PI * (frames - 1 - n) / fadeOut);
        for (let ch = 0; ch < 2; ch++) {
          const value = (ch ? right[i] : left[i]) * gain;
          if (!Number.isFinite(value)) throw new Error('Engine produced a non-finite sample. Export discarded.');
          peak = Math.max(peak, Math.abs(value)); sum += value * value;
          view.setInt16(44 + n * 4 + ch * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true);
        }
      }
      at += count;
      if (at >= yieldAt) {
        yieldAt = at + 16384;
        progress?.(Math.floor(100 * at / (skip + frames)));
        await new Promise((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
      }
    }
  } finally { engine.free(); }
  signal?.throwIfAborted(); progress?.(100);
  return { wav, projectId: snapshot.id, revision: snapshot.revision, renderer: RENDERER_VERSION,
    frames, sampleRate: s.sampleRate, seconds: frames / s.sampleRate, format: 'wav/pcm16/stereo', peak, rms: Math.sqrt(sum / (frames * 2)), warnings: [] as string[] };
}
