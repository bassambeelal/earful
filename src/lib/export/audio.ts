// Audio export: synthesize a range of sentences with an audio-producing voice and save it
// as one MP3 or WAV file. Uses the same chunking, filters and audio cache as the player,
// so anything already listened to with a paid voice isn't paid for twice.
import type { Block } from '../../types'
import { getSettings, type EngineId } from '../settings'
import type { Sentence, SpeakFilters } from '../text'
import { getEngine } from '../tts/registry'
import { blocksFor, headingSkip, makePlan, nextPlayable, planChunk, type Chunk } from '../player/plan'
import { ensureEngineReady, friendlyError, synthesizeChunk, type PreparedAudio } from '../player/synth'
import { abortable, abortError, clamp, isAbortError, throwIfAborted } from '../player/util'
import { createMp3Sink, createWavSink } from './encode'
import { timeStretch } from './stretch'

export interface ExportAudioOptions {
  sentences: Sentence[]
  /**
   * The document's blocks, used to skip headings when "read headings" is off. Optional when
   * `sentences` is the open document's own array (the library's blocks are used then).
   */
  blocks?: Block[]
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

/** Every clip is resampled to this rate: plenty for speech, and native for most voices. */
const SAMPLE_RATE = 24000
/** Audiobook-standard quality for mono speech (about 29 MB per hour; memory matters for long books). */
const MP3_KBPS = 64

/** Approximate size of the exported file per second of audio, for estimates in the UI. */
export const EXPORT_BYTES_PER_SEC: Record<ExportAudioOptions['format'], number> = { mp3: (MP3_KBPS * 1000) / 8, wav: SAMPLE_RATE * 2 }

const BROWSER_VOICE_MESSAGE = 'Browser voices can’t be saved as audio files. Choose an offline or premium voice to export.'

/**
 * Synthesize a range of sentences into one downloadable audio file.
 * Headings are skipped when "read headings" is off (pass `blocks` unless `sentences` is the open
 * document's own array); paragraph pauses follow the reading settings. `rate` is applied with a
 * pitch-preserving time stretch. Rejects with an AbortError when `signal` aborts.
 */
export async function exportAudio(opts: ExportAudioOptions): Promise<Blob> {
  const outer = opts.signal
  throwIfAborted(outer)
  if (opts.engine === 'browser') throw new Error(BROWSER_VOICE_MESSAGE)
  const engine = getEngine(opts.engine)
  if (engine.kind !== 'synth') throw new Error(BROWSER_VOICE_MESSAGE)

  // Our own controller also cancels prefetched synthesis when something fails.
  const ctrl = new AbortController()
  const signal = ctrl.signal
  const onOuterAbort = () => ctrl.abort()
  outer?.addEventListener('abort', onOuterAbort, { once: true })
  let decoder: Decoder | null = null
  try {
    const chunks = planRange(opts, engine.maxChunkChars)
    if (!chunks.length) throw new Error('There’s nothing to read aloud in the selected part.')
    // May download the offline voice model first.
    await ensureEngineReady(opts.engine, engine, signal)

    const rate = Number.isFinite(opts.rate) ? clamp(opts.rate as number, 0.5, 4) : 1
    const pauseSamples = Math.round(((Math.max(0, getSettings().reading.paragraphPauseMs) / 1000) * SAMPLE_RATE) / rate)
    decoder = createDecoder(SAMPLE_RATE)
    const sink = opts.format === 'mp3' ? await createMp3Sink(SAMPLE_RATE, MP3_KBPS) : createWavSink(SAMPLE_RATE)

    const total = chunks.length
    const ahead = Math.max(1, Math.floor(engine.prefetch || 1))
    const inflight: Array<Promise<PreparedAudio>> = []
    let started = 0
    const fill = () => {
      while (started < total && inflight.length <= ahead) {
        const p = synthesizeChunk(opts.engine, engine, opts.voice ?? '', chunks[started].text, signal)
        p.catch(() => {}) // surfaced when awaited below
        inflight.push(p)
        started++
      }
    }

    opts.onProgress?.(0, total)
    for (let k = 0; k < total; k++) {
      fill()
      const pending = inflight.shift()
      if (!pending) break
      const audio = await abortable(pending, signal)
      fill()
      let samples = await decoder.decode(audio.blob)
      throwIfAborted(signal)
      if (rate !== 1) samples = await timeStretch(samples, SAMPLE_RATE, rate, signal)
      await sink.write(samples, signal)
      if (chunks[k].blockEnd && k < total - 1 && pauseSamples > 0) await sink.write(new Float32Array(pauseSamples), signal)
      opts.onProgress?.(k + 1, total)
    }
    return await sink.finish()
  } catch (e) {
    if (isAbortError(e) || outer?.aborted) throw abortError()
    throw new Error(friendlyError(e, 'The audio file couldn’t be created. Please try again.'))
  } finally {
    ctrl.abort()
    outer?.removeEventListener('abort', onOuterAbort)
    decoder?.close()
  }
}

function planRange(opts: ExportAudioOptions, maxChunkChars: number): Chunk[] {
  const { sentences } = opts
  if (!sentences?.length) return []
  const last = sentences.length - 1
  const lo = clamp(Math.floor(Math.min(opts.from, opts.to)) || 0, 0, last)
  const hi = clamp(Math.floor(Math.max(opts.from, opts.to)) || 0, 0, last)
  const readHeadings = getSettings().reading.readHeadings
  const blocks = readHeadings ? null : (opts.blocks ?? blocksFor(sentences))
  const plan = makePlan(sentences, opts.filters, headingSkip(blocks, sentences, readHeadings))
  const maxChars = Math.max(80, maxChunkChars || 400)
  const chunks: Chunk[] = []
  let i = nextPlayable(plan, lo, hi)
  while (i >= 0) {
    const { chunk, next } = planChunk(plan, i, { maxChars, last: hi })
    chunks.push(chunk)
    i = next
  }
  return chunks
}

interface Decoder {
  /** Decode any browser-playable clip to mono samples at the decoder's sample rate. */
  decode(blob: Blob): Promise<Float32Array>
  close(): void
}

function createDecoder(sampleRate: number): Decoder {
  let ctx: BaseAudioContext
  if (typeof OfflineAudioContext !== 'undefined') {
    // decodeAudioData resamples to the context's rate, so every clip comes out at `sampleRate`.
    ctx = new OfflineAudioContext(1, 1, sampleRate)
  } else if (typeof AudioContext !== 'undefined') {
    ctx = new AudioContext({ sampleRate })
  } else {
    throw new Error('This browser can’t process audio, so exporting isn’t available here.')
  }
  return {
    async decode(blob) {
      let buffer: AudioBuffer
      try {
        buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
      } catch {
        throw new Error('The audio from this voice couldn’t be decoded for export. Try another voice or format.')
      }
      return toMono(buffer)
    },
    close() {
      if (ctx instanceof AudioContext) ctx.close().catch(() => {})
    },
  }
}

function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  if (channels === 1) return buffer.getChannelData(0)
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] += data[i] / channels
  }
  return out
}

/** A file name every OS accepts (document titles can contain / : ? and friends). */
function safeFileName(name: string): string {
  const clean = Array.from(String(name ?? ''), (ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127 || '<>:"/\\|?*'.includes(ch) ? ' ' : ch
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (!clean) return 'earful-audio'
  if (clean.length <= 150) return clean
  const ext = /\.[a-z0-9]{1,5}$/i.exec(clean)?.[0] ?? ''
  return clean.slice(0, 150 - ext.length).trim() + ext
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = safeFileName(fileName)
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Give the browser (Safari especially) time to start the download before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
