// Bring-your-own-key LLM access, called directly from the browser.
// Keys live in settings (localStorage) and are only ever sent to the chosen provider.
import { getSettings, type AiProviderId, type KeyId } from '../settings'
import { anthropicChat } from './anthropic'
import { chromeChat, useChromeAi } from './chrome'
import { AiError, abortError, describeAiError, isAbortError } from './errors'
import { geminiChat } from './gemini'
import { customChatUrl, openAiCompatibleChat } from './openai'
import type { AiProviderInfo, ChatOptions, ProviderRequest } from './types'

export type { ChatMessage, ChatOptions, AiProviderInfo } from './types'
export { AiError, describeAiError, isAbortError } from './errors'
export type { AiErrorKind } from './errors'
export { useChromeAi, prepareChromeAi, refreshChromeAi } from './chrome'
export type { ChromeAiStatus } from './chrome'

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    // Verified against OpenAI's model list (Sept 2026). gpt-5-mini / gpt-5-nano are deprecated.
    modelSuggestions: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-5.5', 'gpt-5.4-mini'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    keyUrl: 'https://platform.claude.com/settings/keys',
    modelSuggestions: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5'],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    modelSuggestions: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.8-flash'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    modelSuggestions: [
      'openai/gpt-6-luna',
      'anthropic/claude-haiku-4.5',
      'google/gemini-3.5-flash',
      'meta-llama/llama-3.3-70b-instruct',
      // Picks a model per request; can route to pricier models.
      'openrouter/auto',
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    modelSuggestions: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'qwen/qwen3.8-27b'],
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    modelSuggestions: ['llama3.2', 'qwen3', 'gemma3', 'mistral'],
  },
  {
    id: 'chrome',
    label: 'Chrome built-in AI',
    keyUrl: 'https://developer.chrome.com/docs/ai/get-started',
    modelSuggestions: [],
    keyless: true,
  },
]

export function providerInfo(id: AiProviderId): AiProviderInfo {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0]
}

/** Model id used for a provider ('' for Chrome, which has one built-in model). */
export function aiModel(provider: AiProviderId = getSettings().ai.provider): string {
  if (provider === 'chrome') return ''
  const s = getSettings()
  return (s.ai.models[provider] || '').trim()
}

/** Short "Provider · model" label for the UI. */
export function aiLabel(provider: AiProviderId = getSettings().ai.provider): string {
  const info = providerInfo(provider)
  const model = aiModel(provider)
  return model ? `${info.label.replace(/ \(.*\)$/, '')} · ${model}` : info.label
}

function keyFor(provider: AiProviderId): string {
  if (provider === 'chrome') return ''
  return (getSettings().keys[provider as KeyId] || '').trim()
}

function notReadyReason(provider: AiProviderId): string | null {
  const info = providerInfo(provider)
  if (provider === 'chrome') {
    switch (useChromeAi.getState().status) {
      case 'available':
        return null
      case 'checking':
        return 'Checking whether Chrome’s built-in AI is available…'
      case 'downloadable':
        return 'Chrome’s built-in AI needs a one-time download before it can be used.'
      case 'downloading':
        return 'Chrome is downloading its built-in AI model. This can take a few minutes.'
      case 'unsupported':
        return 'This browser doesn’t have built-in AI. Use a recent desktop version of Chrome, or add an API key for another provider.'
      default:
        return 'Chrome’s built-in AI isn’t available on this device. Add an API key for another provider instead.'
    }
  }
  if (provider === 'custom') {
    if (!customChatUrl()) return 'Add the address of your OpenAI-compatible server (for example Ollama or LM Studio) in Settings.'
    if (!aiModel(provider)) return 'Choose a model name for your server in Settings.'
    return null
  }
  if (!keyFor(provider)) return `Add your ${info.label} API key in Settings to use the AI tools.`
  if (!aiModel(provider)) return `Choose a ${info.label} model in Settings.`
  return null
}

/** True if the currently selected provider is usable (key present or keyless & available). */
export function aiReady(): boolean {
  return notReadyReason(getSettings().ai.provider) === null
}

/** Human reason when not ready. */
export function aiNotReadyReason(): string | null {
  return notReadyReason(getSettings().ai.provider)
}

/** How much text the tools should send per request for a provider (local models get less). */
export interface AiBudget {
  /** Characters per map/transform chunk. */
  chunkChars: number
  /** Characters of document context for a single request. */
  contextChars: number
  /** Parallel requests for chunked work. */
  concurrency: number
}

export function aiBudget(provider: AiProviderId = getSettings().ai.provider): AiBudget {
  switch (provider) {
    case 'chrome':
      return { chunkChars: 4000, contextChars: 6000, concurrency: 1 }
    case 'custom':
      return { chunkChars: 6000, contextChars: 12000, concurrency: 1 }
    case 'groq':
      return { chunkChars: 12000, contextChars: 24000, concurrency: 2 }
    default:
      return { chunkChars: 12000, contextChars: 40000, concurrency: 3 }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Run a chat completion with the user's selected provider/model/key. Resolves with the full text. */
export async function chat(opts: ChatOptions): Promise<string> {
  const provider = opts.provider ?? getSettings().ai.provider
  const reason = notReadyReason(provider)
  if (reason && !(provider === 'chrome' && useChromeAi.getState().status === 'downloadable')) throw new AiError('config', reason)
  const info = providerInfo(provider)
  let emitted = false
  const req: ProviderRequest = {
    provider,
    label: info.label.replace(/ \(.*\)$/, ''),
    model: aiModel(provider),
    key: keyFor(provider),
    messages: opts.messages,
    signal: opts.signal,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    json: opts.json,
    onToken: (d) => {
      emitted = true
      opts.onToken?.(d)
    },
  }
  const adapter =
    provider === 'anthropic' ? anthropicChat : provider === 'gemini' ? geminiChat : provider === 'chrome' ? chromeChat : openAiCompatibleChat

  // Retry transient failures (rate limits, overloaded servers) if nothing was streamed yet.
  for (let attempt = 0; ; attempt++) {
    try {
      return await adapter(req)
    } catch (e) {
      if (opts.signal?.aborted || isAbortError(e)) throw abortError()
      const retry = e instanceof AiError && e.retryable && !emitted && attempt < 2
      if (!retry) throw e
      const wait = e.retryAfter !== undefined ? e.retryAfter * 1000 : 1500 * 2 ** attempt + Math.random() * 500
      if (wait > 20000) throw e
      await sleep(wait, opts.signal)
    }
  }
}

/** Validate a key with a tiny request. Resolves with an ok flag and a human message. */
export async function testAiKey(provider: AiProviderId): Promise<{ ok: boolean; message: string }> {
  const reason = notReadyReason(provider)
  if (reason && !(provider === 'chrome' && useChromeAi.getState().status === 'downloadable')) return { ok: false, message: reason }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const reply = await chat({
      provider,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 16,
      signal: ctrl.signal,
    })
    const label = providerInfo(provider).label
    const model = aiModel(provider)
    return {
      ok: true,
      message: reply.trim() ? `It works! ${label}${model ? ` (${model})` : ''} is ready.` : `Connected to ${label}, but the model sent an empty reply.`,
    }
  } catch (e) {
    if (isAbortError(e)) return { ok: false, message: 'The provider took too long to answer. Check your connection and try again.' }
    return { ok: false, message: describeAiError(e) }
  } finally {
    clearTimeout(timer)
  }
}
