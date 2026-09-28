// Friendly, user-facing errors for AI requests. Messages never contain API keys.

export type AiErrorKind =
  | 'config'
  | 'auth'
  | 'credits'
  | 'rate'
  | 'context'
  | 'model'
  | 'network'
  | 'server'
  | 'refused'
  | 'bad-response'

export class AiError extends Error {
  kind: AiErrorKind
  status?: number
  /** Worth retrying automatically (rate limits, overloaded servers). */
  retryable: boolean
  /** Seconds the provider asked us to wait, if it said. */
  retryAfter?: number

  constructor(kind: AiErrorKind, message: string, opts: { status?: number; retryable?: boolean; retryAfter?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.kind = kind
    this.status = opts.status
    this.retryable = opts.retryable ?? false
    this.retryAfter = opts.retryAfter
  }
}

export function isAbortError(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError'
}

export function abortError(): DOMException {
  return new DOMException('The request was stopped.', 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

/** Human message for any error thrown by the AI layer. */
export function describeAiError(e: unknown): string {
  if (isAbortError(e)) return 'Stopped.'
  if (e instanceof AiError) return e.message
  if (e instanceof Error && e.message) return e.message
  return 'Something went wrong. Please try again.'
}

/** Mask anything that looks like an API key before it can reach the UI. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk-ant-|sk-or-|sk-proj-|sk-|gsk_|AIza|xai-)[A-Za-z0-9_\-*.]{4,}/g, '[key]')
    .replace(/Bearer\s+[A-Za-z0-9_\-.]{8,}/gi, 'Bearer [key]')
}

const CONTEXT_RE =
  /context[_ ]length|context window|maximum context|too many tokens|prompt is too long|input is too long|too large|exceeds? (?:the )?(?:maximum|max|limit)|reduce the length|token limit|request_too_large|input token count/i
const QUOTA_RE = /quota|insufficient_quota|billing|credit|balance|payment|exceeded your current/i
const KEY_RE = /api[_ ]?key|x-api-key|invalid.*key|key.*invalid|unauthori[sz]ed|authentication/i

/** Pull a readable message out of a provider's error body (OpenAI, Anthropic, Gemini, OpenRouter shapes). */
export function extractErrorMessage(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  try {
    const j = JSON.parse(trimmed) as unknown
    const pick = (v: unknown): string => {
      if (!v) return ''
      if (typeof v === 'string') return v
      if (Array.isArray(v)) return pick(v[0])
      if (typeof v === 'object') {
        const o = v as Record<string, unknown>
        return pick(o.message) || pick(o.error) || pick(o.detail) || pick(o.msg) || ''
      }
      return ''
    }
    return redactSecrets(pick(j)).slice(0, 400)
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy). Keep it short.
    return redactSecrets(trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).slice(0, 200)
  }
}

function parseRetryAfter(res: Response | null): number | undefined {
  const h = res?.headers.get('retry-after')
  if (!h) return undefined
  const secs = Number(h)
  if (Number.isFinite(secs)) return Math.max(0, secs)
  const date = Date.parse(h)
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined
}

/** Map an HTTP error (status + body) to a friendly AiError. */
export function httpError(opts: { label: string; model: string; status: number; body: string; res?: Response | null }): AiError {
  const { label, model, status } = opts
  const detail = extractErrorMessage(opts.body)
  const retryAfter = parseRetryAfter(opts.res ?? null)
  const withDetail = (msg: string) => (detail ? `${msg} (${label} said: “${detail}”)` : msg)

  if (CONTEXT_RE.test(detail) || status === 413) {
    return new AiError(
      'context',
      'This text is too long for the selected model. Try a smaller scope, such as one chapter, or pick a model with a larger context window.',
      { status },
    )
  }
  if (status === 401 || (status === 400 && KEY_RE.test(detail) && /invalid|not valid|missing|expired/i.test(detail))) {
    return new AiError('auth', `${label} didn’t accept your API key. Check it in Settings → AI.`, { status })
  }
  if (status === 402) {
    return new AiError('credits', withDetail(`Your ${label} account is out of credits. Add credits on the provider’s website, then try again.`), { status })
  }
  if (status === 403) {
    return new AiError(
      'auth',
      withDetail(`${label} refused this request. Your API key may not have access to “${model}”, or the service isn’t available in your region.`),
      { status },
    )
  }
  if (status === 404) {
    return new AiError('model', withDetail(`${label} couldn’t find the model “${model}”. Pick another model in Settings → AI.`), { status })
  }
  if (status === 429) {
    if (QUOTA_RE.test(detail) && !/rate|per minute|per day|RPM|TPM/i.test(detail)) {
      return new AiError('credits', withDetail(`You’ve used up your ${label} quota or credits. Check your plan and billing on the provider’s website.`), { status })
    }
    return new AiError('rate', `${label} is limiting how fast requests can be made. Wait a moment and try again.`, {
      status,
      retryable: true,
      retryAfter,
    })
  }
  if (status === 408 || status === 409 || status >= 500) {
    return new AiError('server', `${label} is busy or having trouble right now. Try again in a minute.`, { status, retryable: true, retryAfter })
  }
  if (status === 400 || status === 422) {
    return new AiError('bad-response', withDetail(`${label} couldn’t process this request.`), { status })
  }
  return new AiError('server', withDetail(`${label} returned an unexpected error (${status}).`), { status })
}

/** Map a streamed error object (sent inside the SSE stream) to a friendly AiError. */
export function streamError(label: string, model: string, err: unknown): AiError {
  const o = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>
  const type = String(o.type ?? o.code ?? o.status ?? '')
  const statusByType: Record<string, number> = {
    overloaded_error: 529,
    api_error: 500,
    rate_limit_error: 429,
    authentication_error: 401,
    permission_error: 403,
    not_found_error: 404,
    invalid_request_error: 400,
    request_too_large: 413,
    billing_error: 402,
  }
  const numeric = Number(o.code)
  const status = statusByType[type] ?? (Number.isFinite(numeric) && numeric >= 400 ? numeric : 500)
  return httpError({ label, model, status, body: JSON.stringify({ message: o.message ?? type }) })
}

export function networkError(label: string, url: string): AiError {
  let local = false
  try {
    const host = new URL(url).hostname
    local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local') || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)
  } catch {
    /* ignore */
  }
  if (local) {
    return new AiError(
      'network',
      `Couldn’t reach ${url}. Make sure your local server (Ollama, LM Studio, …) is running and allows requests from this site. For Ollama, set OLLAMA_ORIGINS to this site’s address (or *) and restart it; in LM Studio, turn on “Enable CORS”. If your browser asks whether this site may use devices on your local network, choose Allow.`,
      { retryable: false },
    )
  }
  return new AiError(
    'network',
    `Couldn’t reach ${label}. Check your internet connection. A browser extension, firewall or network filter may also be blocking the request.`,
    { retryable: false },
  )
}
