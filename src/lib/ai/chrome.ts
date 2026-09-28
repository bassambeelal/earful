// Chrome's built-in AI (Prompt API, Gemini Nano on device). Keyless and private.
// https://developer.chrome.com/docs/ai/prompt-api
import { create } from 'zustand'
import { AiError, abortError, isAbortError } from './errors'
import { splitSystem } from './messages'
import type { ChatMessage, ProviderRequest } from './types'

export type ChromeAiStatus = 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' | 'checking'

interface LMSession {
  promptStreaming(input: string, opts?: { signal?: AbortSignal }): ReadableStream<string>
  destroy(): void
}

interface LMMonitor {
  addEventListener(type: 'downloadprogress', cb: (e: Event & { loaded: number }) => void): void
}

interface LMStatic {
  availability(opts?: Record<string, unknown>): Promise<string>
  create(opts?: {
    signal?: AbortSignal
    initialPrompts?: ChatMessage[]
    monitor?: (m: LMMonitor) => void
  }): Promise<LMSession>
}

function api(): LMStatic | null {
  const lm = (globalThis as { LanguageModel?: LMStatic }).LanguageModel
  return lm && typeof lm.availability === 'function' ? lm : null
}

interface ChromeAiState {
  status: ChromeAiStatus
  /** 0..1 while downloading, else null. */
  progress: number | null
}

export const useChromeAi = create<ChromeAiState>()(() => ({ status: api() ? 'checking' : 'unsupported', progress: null }))

function normalise(s: string): ChromeAiStatus {
  if (s === 'available' || s === 'readily') return 'available'
  if (s === 'downloadable' || s === 'after-download') return 'downloadable'
  if (s === 'downloading') return 'downloading'
  return 'unavailable'
}

/** Re-check availability (cheap). */
export async function refreshChromeAi(): Promise<ChromeAiStatus> {
  const lm = api()
  if (!lm) {
    useChromeAi.setState({ status: 'unsupported' })
    return 'unsupported'
  }
  try {
    const status = normalise(await lm.availability())
    // Don't clobber our own download progress with the browser's view.
    if (useChromeAi.getState().progress === null) useChromeAi.setState({ status })
    return status
  } catch {
    useChromeAi.setState({ status: 'unavailable' })
    return 'unavailable'
  }
}

if (typeof window !== 'undefined') void refreshChromeAi()

/**
 * Download the on-device model (needs a user click to start). Resolves when ready.
 * Progress is published on useChromeAi.
 */
export async function prepareChromeAi(signal?: AbortSignal): Promise<void> {
  const lm = api()
  if (!lm) throw new AiError('config', 'This browser doesn’t have built-in AI. It’s available in recent desktop versions of Google Chrome.')
  useChromeAi.setState({ status: 'downloading', progress: 0 })
  try {
    const session = await lm.create({
      signal,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => useChromeAi.setState({ progress: Math.max(0, Math.min(1, e.loaded)) }))
      },
    })
    session.destroy()
    useChromeAi.setState({ status: 'available', progress: null })
  } catch (e) {
    useChromeAi.setState({ progress: null })
    await refreshChromeAi()
    if (isAbortError(e) || signal?.aborted) throw abortError()
    throw new AiError(
      'config',
      'Chrome couldn’t download its built-in AI model. It needs about 22 GB of free disk space, a capable GPU or 16 GB of RAM, and an unmetered connection.',
    )
  }
}

export async function chromeChat(req: ProviderRequest): Promise<string> {
  const lm = api()
  if (!lm) throw new AiError('config', 'This browser doesn’t have built-in AI. Choose another AI provider in Settings.')
  const status = await refreshChromeAi()
  if (status === 'unavailable') throw new AiError('config', 'Chrome’s built-in AI isn’t available on this device. Choose another AI provider in Settings.')

  // Everything but the final user message becomes the session's initial context.
  const msgs = req.messages.slice()
  let lastUser = ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastUser = msgs[i].content
      msgs.splice(i, 1)
      break
    }
  }
  const { system, turns: history } = splitSystem(msgs)
  // The system prompt must come first.
  const initialPrompts: ChatMessage[] = [...(system ? [{ role: 'system' as const, content: system }] : []), ...history]
  const input = req.json ? `${lastUser}\n\nReply with only a JSON object.` : lastUser

  let session: LMSession
  try {
    session = await lm.create({ signal: req.signal, initialPrompts })
  } catch (e) {
    if (req.signal?.aborted || isAbortError(e)) throw abortError()
    throw chromeError(e)
  }
  let text = ''
  try {
    const reader = session.promptStreaming(input, { signal: req.signal }).getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      // The web Prompt API (LanguageModel, Chrome 138+) streams deltas. Very old builds streamed
      // the whole answer so far, but those used a different global that we don't look for.
      if (!value) continue
      text += value
      req.onToken(value)
    }
    return text
  } catch (e) {
    if (req.signal?.aborted || isAbortError(e)) throw abortError()
    throw chromeError(e)
  } finally {
    session.destroy()
  }
}

function chromeError(e: unknown): AiError {
  const name = e instanceof Error ? e.name : ''
  if (name === 'QuotaExceededError' || /quota|too large|context|overflow/i.test(String((e as Error)?.message ?? ''))) {
    return new AiError('context', 'This text is too long for Chrome’s built-in AI. Try a smaller scope, like one paragraph or a short selection.')
  }
  if (name === 'NotAllowedError') {
    return new AiError('config', 'Chrome needs you to click a button before its built-in AI can start. Try again.')
  }
  if (name === 'NotSupportedError') {
    return new AiError('config', 'Chrome’s built-in AI can’t handle this request (it may not support this language yet).')
  }
  return new AiError('server', 'Chrome’s built-in AI ran into a problem. Try again, or choose another AI provider in Settings.')
}
