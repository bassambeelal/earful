// CONTRACT STUB — replaced by the player module implementation (audio export lives with the player).
import type { EngineId } from '../settings'
import type { Sentence, SpeakFilters } from '../text'

export interface ExportAudioOptions {
  sentences: Sentence[]
  /** Inclusive sentence index range. */
  from: number
  to: number
  /** Must be a 'synth' engine (Web Speech audio cannot be captured). */
  engine: EngineId
  voice: string
  format: 'mp3' | 'wav'
  filters: SpeakFilters
  /** Speed baked into the file (1 = natural). Pitch preserved where possible. */
  rate?: number
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

/** Synthesize a range of sentences into one downloadable audio file. */
export declare function exportAudio(opts: ExportAudioOptions): Promise<Blob>

/** Trigger a browser download for a blob. */
export declare function downloadBlob(blob: Blob, fileName: string): void
