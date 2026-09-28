// OpenAI Chat Completions and compatible servers (OpenRouter, Groq, Ollama, LM Studio, ...).
import { getSettings } from '../settings'
import { AiError, streamError } from './errors'
import { parseJson, postJson, readSse } from './sse'
import type { ProviderRequest } from './types'

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
  error?: unknown
}

/** OpenAI reasoning models reject temperature/max_tokens and take reasoning_effort instead. */
export function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase().replace(/^openai\//, '')
  return /^(o\d|gpt-5|gpt-6)/.test(m) && !m.includes('chat')
}

/** Resolve the chat completions URL for the custom (OpenAI-compatible) provider. */
export function customChatUrl(): string {
  const base = getSettings().ai.customBaseUrl.trim().replace(/\/+$/, '')
  if (!base) return ''
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

function endpoint(req: ProviderRequest): { url: string; headers: Record<string, string>; displayUrl?: string } {
  const auth: Record<string, string> = req.key ? { Authorization: `Bearer ${req.key}` } : {}
  switch (req.provider) {
    case 'openai':
      return { url: 'https://api.openai.com/v1/chat/completions', headers: auth }
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: { ...auth, 'HTTP-Referer': location.origin, 'X-Title': 'Earful' },
      }
    case 'groq':
      return { url: 'https://api.groq.com/openai/v1/chat/completions', headers: auth }
    default: {
      const url = customChatUrl()
      if (!url) throw new AiError('config', 'Add the address of your OpenAI-compatible server in Settings → AI.')
      return { url, headers: auth, displayUrl: getSettings().ai.customBaseUrl }
    }
  }
}

/**
 * Open or routed models that think before answering. Their hidden reasoning usually counts
 * against max_tokens, so a small limit can leave nothing for the answer.
 */
function thinksFirst(model: string): boolean {
  return (
    isOpenAiReasoningModel(model) ||
    /gpt-oss|qwen3|qwq|deepseek-r1|deepseek-reasoner|reasoner|thinking|magistral|phi-4-reasoning|\br1\b|claude-(?:opus|sonnet|fable|mythos)-[4-9]|gemini-[2-9]/i.test(model)
  )
}

function buildBody(req: ProviderRequest, withJson: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true }
  const model = req.model.toLowerCase()
  if (req.provider === 'openai') {
    const reasoning = isOpenAiReasoningModel(req.model)
    if (reasoning) {
      body.reasoning_effort = 'low'
      // Reasoning tokens count against this limit, so leave headroom.
      if (req.maxTokens) body.max_completion_tokens = req.maxTokens + 4096
    } else {
      if (req.maxTokens) body.max_completion_tokens = req.maxTokens
      if (req.temperature !== undefined) body.temperature = req.temperature
    }
  } else {
    if (req.maxTokens) body.max_tokens = req.maxTokens + (thinksFirst(model) ? 2048 : 0)
    // OpenAI reasoning models reject temperature; OpenRouter ignores it for them anyway.
    if (req.temperature !== undefined && !isOpenAiReasoningModel(model)) body.temperature = req.temperature
    if (req.provider === 'openrouter' && isOpenAiReasoningModel(model)) body.reasoning_effort = 'low'
    if (req.provider === 'groq') {
      // https://console.groq.com/docs/reasoning
      if (model.includes('gpt-oss')) {
        body.reasoning_effort = 'low'
        body.include_reasoning = false
      } else if (/^qwen\/qwen3/.test(model)) {
        // Keep <think> text out of the answer (and JSON mode requires parsed/hidden).
        body.reasoning_format = 'hidden'
      }
    }
  }
  if (withJson) body.response_format = { type: 'json_object' }
  return body
}

/**
 * Hides <think>…</think> reasoning that some open models (DeepSeek R1, Qwen 3, …)
 * put at the start of their answer.
 */
class ThinkFilter {
  private state: 'start' | 'thinking' | 'answer' = 'start'
  private pending = ''

  push(delta: string): string {
    if (this.state === 'answer') return delta
    this.pending += delta
    if (this.state === 'start') {
      const trimmed = this.pending.trimStart()
      if (!trimmed) return ''
      if ('<think>'.startsWith(trimmed.slice(0, 7)) && trimmed.length < 7) return ''
      if (!trimmed.startsWith('<think>')) {
        this.state = 'answer'
        const out = this.pending
        this.pending = ''
        return out
      }
      this.state = 'thinking'
    }
    const end = this.pending.indexOf('</think>')
    if (end < 0) return ''
    const out = this.pending.slice(end + 8).replace(/^\s+/, '')
    this.pending = ''
    this.state = 'answer'
    return out
  }

  /** Text held back when the stream ended mid-check. */
  finish(): string {
    const out = this.state === 'start' ? this.pending : ''
    this.pending = ''
    return out
  }
}

async function run(req: ProviderRequest, withJson: boolean): Promise<string> {
  const { url, headers, displayUrl } = endpoint(req)
  const res = await postJson({ url, headers, displayUrl, body: buildBody(req, withJson), signal: req.signal, label: req.label, model: req.model })
  const filter = new ThinkFilter()
  let text = ''
  const emit = (s: string) => {
    if (!s) return
    text += s
    req.onToken(s)
  }
  // A few compatible servers ignore stream:true and send one JSON response.
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    const full = parseJson<{ choices?: Array<{ message?: { content?: string } }>; error?: unknown }>(await res.text())
    if (full?.error) throw streamError(req.label, req.model, full.error)
    emit(filter.push(full?.choices?.[0]?.message?.content ?? ''))
    emit(filter.finish())
    return text
  }
  for await (const ev of readSse(res, req.signal)) {
    const data = ev.data.trim()
    if (!data || data === '[DONE]') continue
    const chunk = parseJson<ChatChunk>(data)
    if (!chunk) continue
    if (chunk.error) throw streamError(req.label, req.model, chunk.error)
    const choice = chunk.choices?.[0]
    const delta = choice?.delta?.content
    if (delta) emit(filter.push(delta))
    if (choice?.finish_reason === 'content_filter' && !text) {
      throw new AiError('refused', `${req.label} declined to answer this request because of its content filter.`)
    }
  }
  emit(filter.finish())
  return text
}

export async function openAiCompatibleChat(req: ProviderRequest): Promise<string> {
  try {
    return await run(req, !!req.json)
  } catch (e) {
    // Some models/servers don't support JSON mode; our prompts ask for JSON anyway.
    if (req.json && e instanceof AiError && (e.status === 400 || e.status === 404 || e.status === 422) && /response_format|json/i.test(e.message)) {
      return run(req, false)
    }
    throw e
  }
}
