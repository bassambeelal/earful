import { AiError, abortError, httpError, isAbortError, networkError } from './errors'

export interface SseEvent {
  event: string
  data: string
}

/** Parse a text/event-stream body into events. Comment lines (": ...") are ignored. */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!res.body) return
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  const onAbort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })
  let buffer = ''
  let event = ''
  let data: string[] = []
  const flush = (): SseEvent | null => {
    if (!data.length && !event) return null
    const out = { event: event || 'message', data: data.join('\n') }
    event = ''
    data = []
    return out
  }
  let finished = false
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<string>
      try {
        chunk = await reader.read()
      } catch (e) {
        if (signal?.aborted || isAbortError(e)) throw abortError()
        // The connection dropped mid-answer (Wi-Fi change, sleep, proxy timeout...).
        throw new AiError('network', 'The connection dropped while the answer was coming in. Check your connection and try again.', { retryable: true })
      }
      const { value, done } = chunk
      if (signal?.aborted) throw abortError()
      if (done) break
      buffer += value
      let nl: number
      while ((nl = buffer.search(/\r?\n|\r/)) >= 0) {
        // A trailing lone CR may be the first half of CRLF split across chunks.
        if (buffer[nl] === '\r' && nl === buffer.length - 1) break
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1))
        if (line === '') {
          const ev = flush()
          if (ev) yield ev
        } else if (line.startsWith(':')) {
          continue
        } else {
          const colon = line.indexOf(':')
          const field = colon < 0 ? line : line.slice(0, colon)
          let val = colon < 0 ? '' : line.slice(colon + 1)
          if (val.startsWith(' ')) val = val.slice(1)
          if (field === 'data') data.push(val)
          else if (field === 'event') event = val
        }
      }
    }
    if (buffer) {
      if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart())
      buffer = ''
    }
    finished = true
    const last = flush()
    if (last) yield last
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Stopped early (error, abort, or the consumer threw): stop downloading the rest of the answer.
    if (!finished) void reader.cancel().catch(() => {})
    else {
      try {
        reader.releaseLock()
      } catch {
        /* already released */
      }
    }
  }
}

/** Parse JSON from an SSE data line, returning null on garbage. */
export function parseJson<T = unknown>(data: string): T | null {
  try {
    return JSON.parse(data) as T
  } catch {
    return null
  }
}

/**
 * POST JSON and return the response if it is OK. Network failures and HTTP errors
 * become friendly AiErrors; aborts are rethrown as AbortError.
 */
export async function postJson(opts: {
  url: string
  body: unknown
  headers: Record<string, string>
  signal?: AbortSignal
  label: string
  model: string
  /** URL shown in network errors (defaults to url). */
  displayUrl?: string
}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: opts.signal,
      referrerPolicy: 'strict-origin-when-cross-origin',
    })
  } catch (e) {
    if (opts.signal?.aborted) throw abortError()
    if (e instanceof AiError) throw e
    throw networkError(opts.label, opts.displayUrl ?? opts.url)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw httpError({ label: opts.label, model: opts.model, status: res.status, body, res })
  }
  return res
}
