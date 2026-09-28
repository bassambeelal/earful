// Shared plumbing for the cloud engines: fetch with friendly errors, timeouts
// and abort handling, plus small formatting helpers.

import { getSettings, type KeyId } from '../settings'

export { splitText } from './split'

export function abortError(message = 'The operation was aborted.'): DOMException {
  return new DOMException(message, 'AbortError')
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError'
}

/** Rejects with an AbortError as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** The trimmed API key for `id`, or undefined. */
export function keyFor(id: KeyId): string | undefined {
  const k = getSettings().keys[id]?.trim()
  return k || undefined
}

export interface RequestOptions {
  /** Shown in messages: "Couldn't reach OpenAI." */
  provider: string
  /** Override the network-failure message (e.g. for a self-hosted server). */
  unreachable?: string
  /** ms before giving up. Default 60 s. */
  timeoutMs?: number
}

/** Pull a human message out of a provider's JSON or text error body. */
function providerMessage(body: string): string {
  let msg = ''
  try {
    const j = JSON.parse(body) as Record<string, unknown>
    const err = j.error as Record<string, unknown> | string | undefined
    const detail = j.detail as Record<string, unknown> | string | Array<{ msg?: string }> | undefined
    if (typeof err === 'string') msg = err
    else if (err && typeof err.message === 'string') msg = err.message
    else if (typeof detail === 'string') msg = detail
    else if (Array.isArray(detail)) msg = detail.map((d) => d?.msg).filter(Boolean).join('; ')
    else if (detail && typeof detail.message === 'string') msg = detail.message
    else if (typeof j.message === 'string') msg = j.message
  } catch {
    // Not JSON: use the text if it looks like a sentence rather than an HTML page.
    if (!/^\s*</.test(body)) msg = body
  }
  msg = msg.replace(/\s+/g, ' ').trim()
  return msg.length > 240 ? msg.slice(0, 237) + '…' : msg
}

/**
 * Error thrown by the cloud engines. `status` (HTTP) and `retryAfter` (seconds) let the
 * player decide whether a retry is worthwhile; quota problems carry no status on purpose.
 */
export class TtsError extends Error {
  status?: number
  retryAfter?: number
}

/** Seconds in a duration like "41s", "7.66s", "1m30s" or "460ms". */
function parseDuration(s: string): number | undefined {
  let total = 0
  for (const [, n, unit] of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(n) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : unit === 's' ? 1 : 0.001)
  }
  return total > 0 ? total : undefined
}

/**
 * How long the provider asks us to wait, in seconds. Browsers only expose Retry-After to
 * cross-origin pages when the provider allows it, so the error body is checked too
 * (Gemini's RetryInfo "retryDelay": "41s", or "Please try again in 7.66s").
 */
function retryAfterSeconds(res: Response, body: string): number | undefined {
  const header = res.headers.get('retry-after')?.trim()
  if (header) {
    const secs = Number(header)
    if (secs > 0) return secs
    const at = Date.parse(header)
    if (!Number.isNaN(at) && at > Date.now()) return (at - Date.now()) / 1000
  }
  const hint =
    /"retryDelay"\s*:\s*"([\d.]+s)"/.exec(body)?.[1] ??
    /(?:retry|try again)(?:\s+(?:in|after))?\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s)\s*)+)/i.exec(body)?.[1]
  return hint ? parseDuration(hint) : undefined
}

function waitHint(seconds: number | undefined): string {
  if (!seconds) return 'a moment'
  if (seconds < 60) return `about ${Math.max(1, Math.ceil(seconds))} seconds`
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`
}

const BAD_KEY = /api key not valid|invalid api key|incorrect api key|invalid_api_key|api_key_invalid/i

function httpError(provider: string, res: Response, body: string): TtsError {
  const status = res.status
  const msg = providerMessage(body)
  const retryAfter = retryAfterSeconds(res, body)
  const quota = /quota|credit|billing|insufficient|exceeds your|payment/i.test(msg)
  // Gemini reports short per-minute limits as "quota exceeded" plus a retry delay: those are
  // rate limits worth retrying. Daily limits and an empty balance are not.
  const rateLimited = status === 429 && (!quota || (retryAfter !== undefined && !/per ?day|daily|insufficient_quota/i.test(body)))
  let text: string
  let keepStatus = true
  if (quota && !rateLimited) {
    text = `You've hit your ${provider} usage limit or quota. Wait a bit, or check your plan and billing.${msg ? ` (${msg})` : ''}`
    keepStatus = false
  } else if (rateLimited) {
    text = `${provider} is limiting requests right now. Wait ${waitHint(retryAfter)} and try again.`
  } else if (status === 401 || BAD_KEY.test(msg)) {
    // Keep the provider's reason when it's more specific (e.g. a key missing the speech permission).
    const detail = msg && !BAD_KEY.test(msg) ? ` (${msg})` : ''
    text = `${provider} didn't accept your API key. Check it in Settings.${detail}`
  } else if (status === 403) {
    text = `${provider} refused the request. Check that your API key is correct and allowed to use speech.${msg ? ` (${msg})` : ''}`
  } else if (status >= 500) {
    text = `${provider} is having trouble right now (error ${status}). Try again shortly.`
  } else {
    text = msg ? `${provider}: ${msg}` : `${provider} couldn't handle this request (error ${status}).`
  }
  const err = new TtsError(text)
  if (keepStatus) err.status = status
  if (keepStatus && retryAfter) err.retryAfter = retryAfter
  return err
}

/**
 * fetch() + read the body, throwing friendly TtsErrors (bad key, quota, rate limit,
 * provider message, unreachable, timeout) and a DOMException 'AbortError' when `signal` aborts.
 * The timeout and abort cover the whole exchange, including the body download.
 */
async function call<T>(url: string, init: RequestInit, signal: AbortSignal, opts: RequestOptions, read: (res: Response) => Promise<T>): Promise<T> {
  if (signal.aborted) throw abortError()
  const ctrl = new AbortController()
  let timedOut = false
  const onAbort = () => ctrl.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, opts.timeoutMs ?? 60_000)
  const timeoutError = () => {
    const e = new TtsError(`${opts.provider} took too long to answer. Try again.`)
    e.status = 408
    return e
  }
  try {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal })
    } catch {
      if (signal.aborted) throw abortError()
      if (timedOut) throw timeoutError()
      // Like fetch() itself, a network failure is a TypeError (the player retries those).
      throw new TypeError(opts.unreachable ?? `Couldn't reach ${opts.provider}. Check your connection.`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (signal.aborted) throw abortError()
      throw httpError(opts.provider, res, body)
    }
    try {
      return await read(res)
    } catch (e) {
      if (signal.aborted) throw abortError()
      if (timedOut) throw timeoutError()
      if (e instanceof SyntaxError) throw new TtsError(`${opts.provider} sent a reply Earful couldn't understand.`)
      if (e instanceof TtsError) throw e
      throw new TypeError(`The connection to ${opts.provider} dropped. Check your connection and try again.`)
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** POST/GET and return the raw body bytes plus the response content type. */
export function fetchBytes(url: string, init: RequestInit, signal: AbortSignal, opts: RequestOptions) {
  return call(url, init, signal, opts, async (res) => ({
    bytes: new Uint8Array(await res.arrayBuffer()),
    type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
  }))
}

/** POST/GET and parse a JSON body. */
export function fetchJson<T>(url: string, init: RequestInit, signal: AbortSignal, opts: RequestOptions): Promise<T> {
  return call(url, init, signal, opts, (res) => res.json() as Promise<T>)
}

/** Blob of `bytes` with the given audio type, rejecting empty or non-audio (e.g. JSON) bodies. */
export function audioBlob(bytes: Uint8Array<ArrayBuffer>, type: string, provider: string): Blob {
  if (!bytes.length) throw new TtsError(`${provider} returned no audio. Try again.`)
  if (bytes[0] === 0x7b /* { */ || bytes[0] === 0x3c /* < */) {
    throw new TtsError(`${provider} sent a reply without audio. Check the model and voice in Settings.`)
  }
  return new Blob([bytes], { type })
}

/** "≈ $0.03" or "< $0.01". */
export function formatCost(usd: number): string {
  if (usd < 0.01) return '< $0.01'
  return `≈ $${usd >= 100 ? usd.toFixed(0) : usd.toFixed(2)}`
}
