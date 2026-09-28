// Runs Kokoro-82M (kokoro-js / transformers.js / ONNX Runtime) off the main thread.
// Model files (from huggingface.co) are cached by transformers.js in Cache Storage
// ('transformers-cache'); voice embeddings by kokoro-js in 'kokoro-voices'.

import { KokoroTTS, env } from 'kokoro-js'
import { env as hfEnv, type ProgressInfo } from '@huggingface/transformers'
import {
  KOKORO_EXTRA_BYTES,
  KOKORO_FILES,
  KOKORO_MODEL_ID,
  type FromWorker,
  type KokoroDevice,
  type KokoroDtype,
  type ToWorker,
} from './kokoro-protocol'
import { splitText } from './split'

/**
 * kokoro-js silently truncates input past 510 phoneme tokens, dropping the end of long
 * passages. Longer text is generated in pieces of about this many characters (numbers and
 * abbreviations expand when spoken, so this leaves roughly 2x headroom) and joined.
 */
const PIECE_CHARS = 240
/** Silence between joined pieces, in seconds. */
const PIECE_GAP_S = 0.12

type Voice = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice']

interface WorkerScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void
}
interface GpuLike {
  requestAdapter(): Promise<{ isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } } | null>
}

// transformers.js points ONNX Runtime at a CDN copy of its .wasm. Clearing that makes ONNX
// Runtime use the glue code embedded in its bundle build (onnxruntime-web's default export,
// ort.bundle.min.mjs) and the .wasm Vite emits from its `new URL(..., import.meta.url)`
// reference (dist/assets/ort-wasm-simd-threaded.jsep-[hash].wasm): same origin, same version,
// and cached by the service worker for offline use. Verified with `vite build` (Vite 8).
env.wasmPaths = undefined as unknown as typeof env.wasmPaths
// ONNX Runtime logs harmless graph-placement warnings through console.error; keep real errors only.
;(hfEnv.backends.onnx as { logLevel?: string }).logLevel = 'error'

const scope = self as unknown as WorkerScope
const post = (msg: FromWorker, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? [])

let tts: KokoroTTS | null = null
let loaded: { device: KokoroDevice; dtype: KokoroDtype } | null = null
let loading: Promise<void> | null = null

interface Job {
  id: number
  text: string
  voice: string
}
const queue: Job[] = []
let current: number | null = null
const cancelled = new Set<number>()

async function webgpuAvailable(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu
  if (!gpu) return false
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return false
    // Software adapters are slower than WASM for this model.
    return !(adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter)
  } catch {
    return false
  }
}

function friendlyLoadError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const name = (e as { name?: string } | null)?.name
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) {
    return 'Not enough free storage to save the natural voices. Free up some space and try again.'
  }
  if (/fetch|network|load failed|connection/i.test(msg)) {
    return "Couldn't download the natural voices. Check your connection and try again."
  }
  return `Natural voices couldn't start on this device (${msg}).`
}

/** Aggregates per-file progress events into one byte count, throttled to ~10 updates/s. */
function progressReporter(dtype: KokoroDtype, device: KokoroDevice) {
  const files = new Map<string, { loaded: number; total: number }>()
  const modelFile = KOKORO_FILES[dtype].file
  const expected = KOKORO_FILES[dtype].bytes + KOKORO_EXTRA_BYTES
  let last = 0
  let modelDone = false
  return (info: ProgressInfo) => {
    // Late events for small files would flip the status back from "loading" to "downloading".
    if (modelDone) return
    if (info.status === 'progress') {
      files.set(info.file, { loaded: info.loaded, total: info.total })
      let loaded = 0
      let total = 0
      for (const f of files.values()) {
        loaded += f.loaded
        total += f.total
      }
      const now = performance.now()
      if (now - last < 100 && loaded < total) return
      last = now
      post({ type: 'progress', loaded, total: Math.max(total, expected) })
    } else if (info.status === 'done' && info.file === modelFile) {
      modelDone = true
      post({ type: 'loading', device, dtype })
    }
  }
}

async function create(device: KokoroDevice): Promise<{ model: KokoroTTS; dtype: KokoroDtype }> {
  const dtype: KokoroDtype = device === 'webgpu' ? 'fp32' : 'q8'
  const model = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    dtype,
    device,
    progress_callback: progressReporter(dtype, device),
  })
  return { model, dtype }
}

/** A short generation that compiles GPU shaders and proves the output is valid. */
async function warmUp(model: KokoroTTS) {
  const out = await model.generate('Hello there.', { voice: 'af_heart', speed: 1 })
  if (!out.audio.length || Number.isNaN(out.audio[0]) || Number.isNaN(out.audio[out.audio.length >> 1])) {
    throw new Error('The graphics card produced invalid audio.')
  }
}

async function load(pref: 'auto' | KokoroDevice) {
  let device: KokoroDevice = pref !== 'wasm' && (await webgpuAvailable()) ? 'webgpu' : 'wasm'
  let created: KokoroTTS | null = null
  try {
    const { model, dtype } = await create(device)
    created = model
    if (device === 'webgpu') await warmUp(model)
    tts = model
    loaded = { device, dtype }
  } catch (e) {
    if (device !== 'webgpu') throw e
    // WebGPU failed (driver, memory, unsupported op): free the GPU session and fall back to WASM.
    await created?.model.dispose().catch(() => {})
    device = 'wasm'
    const { model, dtype } = await create(device)
    tts = model
    loaded = { device, dtype }
  }
  post({ type: 'ready', ...loaded })
  void pump()
}

/** Float32Array we can transfer without detaching memory the runtime still owns. */
function transferable(a: Float32Array): Float32Array<ArrayBuffer> {
  const own = a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.buffer instanceof ArrayBuffer
  return own ? (a as Float32Array<ArrayBuffer>) : new Float32Array(a)
}

/** Join mono segments with `gap` samples of silence between them. */
function join(parts: Float32Array[], gap: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1))
  let offset = 0
  parts.forEach((p, i) => {
    out.set(p, offset)
    offset += p.length + (i < parts.length - 1 ? gap : 0)
  })
  return out
}

/** Generate `job`, piece by piece for long text. Returns null if the job was cancelled meanwhile. */
async function generate(model: KokoroTTS, job: Job): Promise<{ audio: Float32Array<ArrayBuffer>; sampleRate: number } | null> {
  const pieces = splitText(job.text, PIECE_CHARS)
  const parts: Float32Array[] = []
  let sampleRate = 24000
  for (const piece of pieces) {
    if (cancelled.has(job.id)) return null
    const out = await model.generate(piece, { voice: job.voice as Voice, speed: 1 })
    sampleRate = out.sampling_rate
    parts.push(out.audio)
  }
  if (!parts.length) return { audio: new Float32Array(Math.round(sampleRate * 0.1)), sampleRate }
  const audio = parts.length === 1 ? transferable(parts[0]) : join(parts, Math.round(sampleRate * PIECE_GAP_S))
  return { audio, sampleRate }
}

async function pump() {
  if (current !== null || !tts) return
  const job = queue.shift()
  if (!job) return
  current = job.id
  try {
    const out = await generate(tts, job)
    if (out && !cancelled.has(job.id)) {
      post({ type: 'audio', id: job.id, audio: out.audio, sampleRate: out.sampleRate }, [out.audio.buffer])
    }
  } catch (e) {
    if (!cancelled.has(job.id)) {
      const msg = e instanceof Error ? e.message : String(e)
      post({ type: 'error', id: job.id, message: `Natural voices couldn't read this passage (${msg}).` })
    }
  } finally {
    cancelled.delete(job.id)
    current = null
    void pump()
  }
}

scope.addEventListener('message', (e) => {
  const msg = e.data
  switch (msg.type) {
    case 'load':
      if (tts && loaded) {
        post({ type: 'ready', ...loaded })
        return
      }
      if (!loading) {
        loading = load(msg.device).catch((err) => {
          loading = null
          post({ type: 'load-error', message: friendlyLoadError(err) })
        })
      }
      return
    case 'generate':
      queue.push({ id: msg.id, text: msg.text, voice: msg.voice })
      void pump()
      return
    case 'cancel': {
      const i = queue.findIndex((j) => j.id === msg.id)
      if (i >= 0) queue.splice(i, 1)
      else if (current === msg.id) cancelled.add(msg.id)
      return
    }
  }
})
