// Kokoro-82M local neural voices, running in a Web Worker via kokoro-js.
// Nothing heavy is loaded until loadKokoro() creates the worker.

import { create, type UseBoundStore, type StoreApi } from 'zustand'
import { getSettings } from '../settings'
import { encodeWav } from './audio'
import { abortError, raceAbort } from './http'
import { ENGINE_INFO } from './info'
import { KOKORO_DEFAULT_VOICE, KOKORO_VOICES, KOKORO_VOICE_IDS } from './kokoro-voices'
import { KOKORO_EXTRA_BYTES, KOKORO_FILES, KOKORO_MODEL_ID, type FromWorker, type ToWorker } from './kokoro-protocol'
import type { KokoroStatus, SynthEngine, SynthResult } from './types'

const IDLE: KokoroStatus = { state: 'idle', progress: 0, device: null, dtype: null }

/** Reactive status of the local model (download progress, ready, error). */
export const useKokoroStatus: UseBoundStore<StoreApi<KokoroStatus>> = create<KokoroStatus>()(() => ({ ...IDLE }))

const setStatus = (patch: Partial<KokoroStatus>) => useKokoroStatus.setState(patch)

interface Pending {
  text: string
  voice: string
  resolve: (r: SynthResult) => void
  reject: (e: unknown) => void
}

let worker: Worker | null = null
let loadPromise: Promise<void> | null = null
let loadSettle: { resolve: () => void; reject: (e: Error) => void } | null = null
let nextId = 1
const pending = new Map<number, Pending>()

function send(msg: ToWorker) {
  worker?.postMessage(msg)
}

// ---------------------------------------------------------------------------
// Watchdog. The GPU can stall (tab hidden, device lost after sleep, driver reset) and a stalled
// ONNX session never answers again. If the worker goes quiet while passages are waiting, restart
// it from the cached model and resend them; after a second GPU stall fall back to WASM.
// ---------------------------------------------------------------------------

const STALL_MS = { webgpu: 20_000, wasm: 90_000 }
const MAX_RESTARTS = 3
let lastActivity = 0
let watchdog: ReturnType<typeof setInterval> | null = null
let restarts = 0
let forcedDevice: 'wasm' | null = null

function touch() {
  lastActivity = performance.now()
}

function armWatchdog() {
  if (watchdog) return
  watchdog = setInterval(() => {
    if (!pending.size) {
      clearInterval(watchdog!)
      watchdog = null
      return
    }
    const { state, device } = useKokoroStatus.getState()
    if (state !== 'ready') return
    if (performance.now() - lastActivity > STALL_MS[device === 'webgpu' ? 'webgpu' : 'wasm']) recoverFromStall()
  }, 5_000)
}

function recoverFromStall() {
  const wasGpu = useKokoroStatus.getState().device === 'webgpu'
  restarts++
  if (restarts > MAX_RESTARTS) {
    const message = 'Natural voices stopped responding. Reload the page, or switch to another voice.'
    setStatus({ ...IDLE, state: 'error', error: message })
    teardown(new Error(message))
    return
  }
  if (wasGpu && restarts >= 2) forcedDevice = 'wasm'
  // Drop the stuck worker but keep the waiting passages; they are resent once the new one is ready.
  worker?.terminate()
  worker = null
  loadPromise = null
  loadSettle = null
  touch()
  loadKokoro().then(
    () => {
      touch()
      for (const [id, p] of pending) send({ type: 'generate', id, text: p.text, voice: p.voice })
    },
    () => {
      /* loadKokoro already failed everything that was waiting */
    },
  )
}

/** Stop the worker and fail everything in flight with `err`. */
function teardown(err: Error) {
  worker?.terminate()
  worker = null
  loadPromise = null
  loadSettle?.reject(err)
  loadSettle = null
  const waiting = [...pending.values()]
  pending.clear()
  waiting.forEach((p) => p.reject(err))
}

function onMessage(msg: FromWorker) {
  touch()
  switch (msg.type) {
    case 'progress':
      setStatus({ state: 'downloading', progress: msg.total ? Math.min(1, msg.loaded / msg.total) : 0, loaded: msg.loaded, total: msg.total })
      return
    case 'loading':
      setStatus({ state: 'loading', progress: 1, device: msg.device, dtype: msg.dtype })
      return
    case 'ready':
      setStatus({ state: 'ready', progress: 1, device: msg.device, dtype: msg.dtype, error: undefined })
      loadSettle?.resolve()
      loadSettle = null
      return
    case 'load-error':
      setStatus({ ...IDLE, state: 'error', error: msg.message })
      teardown(new Error(msg.message))
      return
    case 'audio': {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      restarts = 0
      p.resolve({ blob: encodeWav(msg.audio, msg.sampleRate), duration: msg.audio.length / msg.sampleRate })
      return
    }
    case 'error': {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      p.reject(new Error(msg.message))
      return
    }
  }
}

/**
 * Download (first time, cached afterwards) and initialise the model. Safe to call repeatedly.
 * Rejects with a friendly Error if it fails; the message is also kept in useKokoroStatus.
 */
export function loadKokoro(): Promise<void> {
  if (worker && useKokoroStatus.getState().state === 'ready') return Promise.resolve()
  if (loadPromise) return loadPromise
  const p = new Promise<void>((resolve, reject) => {
    loadSettle = { resolve, reject }
  })
  // Callers that fire and forget shouldn't trigger unhandled-rejection noise; awaiting callers still see the error.
  p.catch(() => {})
  loadPromise = p
  setStatus({ ...IDLE, state: 'downloading', error: undefined, loaded: undefined, total: undefined })
  const fail = (message: string) => {
    setStatus({ ...IDLE, state: 'error', error: message })
    teardown(new Error(message))
  }
  let w: Worker
  try {
    w = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module', name: 'kokoro' })
  } catch {
    fail("This browser can't run natural voices. Try an up-to-date Chrome, Edge, Firefox or Safari.")
    return p
  }
  worker = w
  // Ignore anything still in flight from a worker that has since been replaced or stopped.
  w.onmessage = (e: MessageEvent<FromWorker>) => {
    if (worker === w) onMessage(e.data)
  }
  w.onerror = (e) => {
    e.preventDefault()
    if (worker !== w) return
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false && useKokoroStatus.getState().state !== 'ready'
    fail(
      offline
        ? "You're offline, so the natural voices can't be downloaded. Connect to the internet and try again."
        : 'Natural voices stopped unexpectedly. Try loading them again.',
    )
  }
  send({ type: 'load', device: forcedDevice ?? getSettings().kokoro.device })
  return p
}

/** Terminate the worker and free memory (model stays cached on disk). */
export function unloadKokoro(): void {
  restarts = 0
  forcedDevice = null
  teardown(new Error('Natural voices were turned off.'))
  setStatus({ ...IDLE })
}

/** Remove the cached model files from Cache Storage. Also unloads the model. */
export async function deleteKokoroCache(): Promise<void> {
  unloadKokoro()
  if (typeof caches === 'undefined') return
  try {
    await caches.delete('kokoro-voices')
    if (!(await caches.has('transformers-cache'))) return
    const cache = await caches.open('transformers-cache')
    const keys = await cache.keys()
    const ours = keys.filter((r) => r.url.includes(`/${KOKORO_MODEL_ID}/`))
    if (ours.length === keys.length) await caches.delete('transformers-cache')
    else await Promise.all(ours.map((r) => cache.delete(r)))
  } catch {
    throw new Error("Couldn't remove the downloaded voices. Try clearing this site's data in your browser settings.")
  }
}

/** True if a Kokoro model file is already in Cache Storage (loading will not download it again). */
export async function isKokoroCached(): Promise<boolean> {
  if (typeof caches === 'undefined') return false
  try {
    if (!(await caches.has('transformers-cache'))) return false
    const cache = await caches.open('transformers-cache')
    const dtype = plannedDtype()
    const url = `https://huggingface.co/${KOKORO_MODEL_ID}/resolve/main/${KOKORO_FILES[dtype].file}`
    return (await cache.match(url)) !== undefined
  } catch {
    return false
  }
}

/** Best guess (without asking for a GPU adapter) of which model loadKokoro() will pick. */
function plannedDtype(): 'fp32' | 'q8' {
  const status = useKokoroStatus.getState()
  if (status.dtype === 'fp32' || status.dtype === 'q8') return status.dtype
  const pref = getSettings().kokoro.device
  const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  return pref !== 'wasm' && hasGpu ? 'fp32' : 'q8'
}

/** Approximate download size in MB for the dtype that would be used on this device. */
export function kokoroDownloadSizeMB(): number {
  return Math.round((KOKORO_FILES[plannedDtype()].bytes + KOKORO_EXTRA_BYTES) / 1_000_000)
}

async function synthesize(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
  if (signal.aborted) throw abortError()
  const { state } = useKokoroStatus.getState()
  if (state !== 'ready' || !worker) {
    if (!loadPromise) throw new Error(kokoroEngine.notReadyReason() ?? 'Natural voices are not ready yet.')
    await raceAbort(loadPromise, signal)
    // Turned off while we waited: posting to a missing worker would never settle.
    if (!worker) throw new Error('Natural voices were turned off. Load them again to keep listening.')
  }
  if (!text.trim()) return { blob: encodeWav(new Float32Array(2400), 24000), duration: 0.1 }
  const id = nextId++
  const sendVoice = KOKORO_VOICE_IDS.has(voice) ? voice : KOKORO_DEFAULT_VOICE
  if (!pending.size) touch()
  armWatchdog()
  return new Promise<SynthResult>((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id)
      send({ type: 'cancel', id })
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.set(id, {
      text,
      voice: sendVoice,
      resolve: (r) => {
        signal.removeEventListener('abort', onAbort)
        resolve(r)
      },
      reject: (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    })
    send({ type: 'generate', id, text, voice: sendVoice })
  })
}

export const kokoroEngine: SynthEngine = {
  info: ENGINE_INFO.kokoro,
  kind: 'synth',
  // The worker splits anything longer than ~240 characters into pieces the model can take.
  maxChunkChars: 320,
  get prefetch() {
    return useKokoroStatus.getState().device === 'webgpu' ? 3 : 2
  },
  cacheable: false,
  modelId: () => `kokoro-82m-v1.0-${useKokoroStatus.getState().dtype ?? plannedDtype()}`,
  isReady: () => useKokoroStatus.getState().state === 'ready' && worker !== null,
  notReadyReason() {
    const s = useKokoroStatus.getState()
    switch (s.state) {
      case 'ready':
        return null
      case 'downloading':
        return `Downloading natural voices… ${Math.round(s.progress * 100)}%`
      case 'loading':
        return 'Getting natural voices ready…'
      case 'error':
        return s.error ?? 'Natural voices failed to load. Try again.'
      default:
        return `Natural voices need a one-time download (about ${kokoroDownloadSizeMB()} MB). After that they work offline.`
    }
  },
  listVoices: async () => KOKORO_VOICES.map((v) => ({ ...v, local: true })),
  synthesize,
  estimateCost: () => null,
}
