// Engine plumbing shared by the player and the exporter: readiness checks,
// cached + retried synthesis, and friendly error messages.
import { getCachedAudio, hashKey, putCachedAudio } from '../db'
import { getSettings, type EngineId } from '../settings'
import { loadKokoro, useKokoroStatus } from '../tts/kokoro'
import type { KokoroStatus, SynthEngine, SynthResult, TtsEngine, WordTiming } from '../tts/types'
import { abortable, abortError, delay, isAbortError, throwIfAborted } from './util'

export interface PreparedAudio {
  blob: Blob
  /** Seconds, when known without decoding. */
  duration?: number
  /** Exact word timings (seconds, char offsets into the synthesized text). */
  words?: WordTiming[]
}

const MAX_RETRIES = 2

/**
 * Resolve once `engine` can be used. The offline Kokoro model is downloaded/loaded on demand
 * (`onWaiting` is called first so callers can show a buffering state); any other engine that
 * isn't ready (usually a missing API key) throws its own reason.
 */
export async function ensureEngineReady(engineId: EngineId, engine: TtsEngine, signal: AbortSignal, onWaiting?: () => void): Promise<void> {
  if (engine.isReady()) return
  if (engineId === 'kokoro') {
    onWaiting?.()
    await waitForKokoro(signal)
    if (engine.isReady()) return
  }
  throw new Error(engine.notReadyReason() || 'This voice isn’t ready yet. Check its settings and try again.')
}

function waitForKokoro(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false
    let unsubscribe = () => {}
    const finish = (err?: unknown) => {
      if (done) return
      done = true
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    const onAbort = () => finish(abortError())
    if (signal.aborted) return finish(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    // Only a *transition* to 'error' counts: a stale error from an earlier attempt is retried by loadKokoro().
    unsubscribe = useKokoroStatus.subscribe((s: KokoroStatus) => {
      if (s.state === 'ready') finish()
      else if (s.state === 'error') finish(new Error(s.error || 'The offline voice couldn’t be loaded.'))
    })
    loadKokoro().then(
      () => finish(),
      (e) => finish(useKokoroStatus.getState().error ? new Error(useKokoroStatus.getState().error) : e),
    )
    if (useKokoroStatus.getState().state === 'ready') finish()
  })
}

async function cacheKey(engineId: EngineId, engine: SynthEngine, voice: string, text: string): Promise<string | null> {
  const s = getSettings()
  const parts = [engineId, engine.modelId(), voice, text]
  // Settings that change the audio without changing the model id.
  if (engineId === 'openai' && s.openaiInstructions.trim()) parts.push(s.openaiInstructions.trim())
  if (engineId === 'custom') parts.push(s.customTtsBaseUrl.trim())
  try {
    return await hashKey(parts.join('|'))
  } catch {
    return null // crypto.subtle is unavailable outside secure contexts: just skip the cache
  }
}

/** Synthesize `text`, using the IndexedDB audio cache for cacheable engines and retrying transient failures. */
export async function synthesizeChunk(engineId: EngineId, engine: SynthEngine, voice: string, text: string, signal: AbortSignal): Promise<PreparedAudio> {
  const key = engine.cacheable ? await cacheKey(engineId, engine, voice, text) : null
  if (key) {
    try {
      const hit = await getCachedAudio(key)
      if (hit?.blob?.size) return { blob: hit.blob, duration: hit.duration, words: hit.words }
    } catch {
      /* cache unavailable (e.g. private browsing): synthesize instead */
    }
  }
  throwIfAborted(signal)
  const result = await synthesizeWithRetry(engine, text, voice, signal)
  if (!result?.blob?.size) throw new Error('The voice service returned no audio. Please try again.')
  if (key) putCachedAudio({ key, blob: result.blob, words: result.words, duration: result.duration }).catch(() => {})
  return { blob: result.blob, duration: result.duration, words: result.words }
}

async function synthesizeWithRetry(engine: SynthEngine, text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await abortable(engine.synthesize(text, voice, signal), signal)
    } catch (e) {
      if (isAbortError(e) || signal.aborted) throw abortError()
      if (attempt >= MAX_RETRIES || !isTransient(e)) throw e
      await delay(retryDelay(attempt, e), signal)
    }
  }
}

function numberProp(e: unknown, ...names: string[]): number | undefined {
  if (!e || typeof e !== 'object') return undefined
  for (const n of names) {
    const v = (e as Record<string, unknown>)[n]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/** Network failures, timeouts, rate limits and server errors are worth another try. */
export function isTransient(e: unknown): boolean {
  if (e instanceof TypeError) return true // fetch() network failure
  const status = numberProp(e, 'status', 'statusCode')
  if (status) return status === 408 || status === 429 || status >= 500
  const msg = e instanceof Error ? e.message : String(e ?? '')
  return /\b(408|429|50[0-4])\b|rate.?limit|too many requests|timed? ?out|network|failed to fetch|load failed|overloaded|temporarily|service unavailable/i.test(msg)
}

function retryDelay(attempt: number, e: unknown): number {
  const retryAfter = numberProp(e, 'retryAfter')
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, 10_000)
  return (attempt === 0 ? 1000 : 2500) + Math.random() * 400
}

/** A short, human message for any error thrown while producing speech. */
export function friendlyError(e: unknown, fallback = 'Something went wrong while reading aloud. Please try again.'): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : ''
  if (!msg) return fallback
  if (/^(failed to fetch|networkerror|load failed|network ?error)/i.test(msg.trim())) {
    return 'Couldn’t reach the voice service. Check your internet connection (or that your server is running) and try again.'
  }
  return msg.length > 300 ? fallback : msg
}
