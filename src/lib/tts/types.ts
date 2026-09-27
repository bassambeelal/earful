import type { EngineId, KeyId } from '../settings'

// Contracts for text-to-speech engines. Implementations live next to this file.
// Two kinds of engine exist:
//   - 'speech': the browser speaks directly (Web Speech API). Can't be recorded/exported.
//   - 'synth' : returns an audio Blob per chunk; the player plays it through an <audio> element.

export interface VoiceInfo {
  /** Stable id passed back to speak()/synthesize(). For Web Speech this is voiceURI. */
  id: string
  name: string
  /** BCP-47, e.g. "en-US". */
  lang?: string
  gender?: 'female' | 'male' | 'neutral'
  /** Short human hint ("Warm, audiobook", "Grade A"). */
  description?: string
  /** True if audio is produced on-device. */
  local?: boolean
  /** True for voices we recommend at the top of the list. */
  recommended?: boolean
}

/** Exact word timing when an engine provides alignment (ElevenLabs). Seconds; char offsets into the synthesized text. */
export interface WordTiming {
  start: number
  end: number
  charStart: number
  charEnd: number
}

export interface SynthResult {
  /** audio/wav, audio/mpeg, audio/ogg ... playable by HTMLAudioElement. */
  blob: Blob
  /** Seconds, if known without decoding. */
  duration?: number
  words?: WordTiming[]
}

export interface EngineInfo {
  id: EngineId
  label: string
  /** One-line description for the voice picker. */
  description: string
  kind: 'speech' | 'synth'
  /** Which API key this engine needs, or null if free. */
  needsKey: KeyId | null
  free: boolean
  offline: boolean
  /** e.g. "$15 / 1M chars" — shown next to premium engines. */
  priceHint?: string
}

interface EngineBase {
  info: EngineInfo
  /** True when the engine can be used right now (key present, model loaded, API available). */
  isReady(): boolean
  /** Human reason when !isReady() ("Add an OpenAI key in Settings"). */
  notReadyReason(): string | null
  listVoices(): Promise<VoiceInfo[]>
}

export interface SpeakOptions {
  voice: string | undefined
  /** 0.5 – 4 (engine clamps to what it supports). */
  rate: number
  lang?: string
  onStart?: () => void
  /** charIndex/charLength are offsets into the `text` passed to speak(). */
  onBoundary?: (charIndex: number, charLength: number | undefined) => void
}

export interface SpeechEngine extends EngineBase {
  kind: 'speech'
  /** Max rate this engine reliably supports (Web Speech voices often cap near 2-3x). */
  maxRate: number
  /**
   * Speak `text`. Resolves when finished. Rejects with an Error on failure.
   * If `signal` aborts, speech is cancelled immediately and the promise rejects with a DOMException named 'AbortError'.
   */
  speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void>
}

export interface SynthEngine extends EngineBase {
  kind: 'synth'
  /** Preferred max characters per synthesize() call. The player groups sentences up to this size. */
  maxChunkChars: number
  /** How many chunks the player should synthesize ahead of playback. */
  prefetch: number
  /** Whether results may be cached in IndexedDB (true for paid cloud voices). */
  cacheable: boolean
  /** Model id, included in cache keys so switching models doesn't replay stale audio. */
  modelId(): string
  synthesize(text: string, voice: string, signal: AbortSignal): Promise<SynthResult>
  /** Rough cost for `chars` characters, e.g. "≈ $0.03", or null if free. */
  estimateCost(chars: number): string | null
}

export type TtsEngine = SpeechEngine | SynthEngine

// ---------------------------------------------------------------------------
// Kokoro (local neural voices) lifecycle, exposed as a small store by ./kokoro.ts
// ---------------------------------------------------------------------------

export interface KokoroStatus {
  state: 'idle' | 'downloading' | 'loading' | 'ready' | 'error'
  /** 0..1 during download */
  progress: number
  /** Bytes loaded / total when known. */
  loaded?: number
  total?: number
  device: 'webgpu' | 'wasm' | null
  dtype: string | null
  error?: string
}
