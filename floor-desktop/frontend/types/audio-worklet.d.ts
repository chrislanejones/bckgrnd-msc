/**
 * Ambient types for the audio thread.
 *
 * TypeScript's DOM lib covers `AudioContext` and `AudioWorkletNode` but not the
 * `AudioWorkletGlobalScope` a processor runs in — `AudioWorkletProcessor`,
 * `registerProcessor`, and the `sampleRate` global are all absent, so a processor
 * written against it either fails to typecheck or silently degrades to `any`.
 *
 * These declarations are deliberately structural and minimal: they describe the
 * surface this project uses, not the whole specification.
 */

declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;

interface AudioWorkletProcessorOptions {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  outputChannelCount?: number[];
  parameterData?: Record<string, Float32Array>;
  processorOptions?: unknown;
}

interface MessagePortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  start(): void;
  close(): void;
}

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePortLike;

  constructor(options?: AudioWorkletProcessorOptions);

  /**
   * Render one quantum. Returning false parks the processor; returning true keeps it
   * alive for the next block. The output arrays must be filled every call.
   */
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletProcessorOptions) => AudioWorkletProcessor,
): void;

interface Window {
  AudioWorkletProcessor: typeof AudioWorkletProcessor;
  registerProcessor: typeof registerProcessor;
}