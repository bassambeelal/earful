// Messages between kokoro.ts (main thread) and kokoro.worker.ts. Types only.

export type KokoroDevice = 'webgpu' | 'wasm'
export type KokoroDtype = 'fp32' | 'q8'

export type ToWorker =
  | { type: 'load'; device: 'auto' | KokoroDevice }
  | { type: 'generate'; id: number; text: string; voice: string }
  | { type: 'cancel'; id: number }

export type FromWorker =
  /** Download progress aggregated over all model files. */
  | { type: 'progress'; loaded: number; total: number }
  /** All files are downloaded; the model is being initialised. */
  | { type: 'loading'; device: KokoroDevice; dtype: KokoroDtype }
  | { type: 'ready'; device: KokoroDevice; dtype: KokoroDtype }
  | { type: 'load-error'; message: string }
  | { type: 'audio'; id: number; audio: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string }

export const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

/** Model file and size per dtype (from the Hugging Face repo), used for progress and size hints. */
export const KOKORO_FILES: Record<KokoroDtype, { file: string; bytes: number }> = {
  fp32: { file: 'onnx/model.onnx', bytes: 325_532_232 },
  q8: { file: 'onnx/model_quantized.onnx', bytes: 92_361_116 },
}

/** Tokenizer, config and a voice file or two. */
export const KOKORO_EXTRA_BYTES = 1_200_000
