// Anthropic Messages API, called directly from the browser (BYOK).
import { AiError, streamError } from './errors'
import { splitSystem } from './messages'
import { parseJson, postJson, readSse } from './sse'
import type { ProviderRequest } from './types'

interface StreamEvent {
  type: string
  delta?: { type?: string; text?: string; stop_reason?: string | null }
  error?: unknown
}

/** Models that accept output_config.effort (Opus 4.5+, Sonnet 4.6+, Sonnet 5, Fable, Mythos). Haiku 4.5 rejects it. */
function supportsEffort(model: string): boolean {
  return /^claude-(?:opus-(?:5|4-[5-9])|sonnet-(?:5|4-[6-9])|fable-5|mythos-5)/.test(model)
}

/** Newer models think adaptively by default; thinking tokens share max_tokens. */
function thinksByDefault(model: string): boolean {
  return /^claude-(?:opus-5|sonnet-5|fable-5|mythos-5)/.test(model)
}

export async function anthropicChat(req: ProviderRequest): Promise<string> {
  const { system, turns: messages } = splitSystem(req.messages)
  // The conversation must start with a user turn.
  if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(Start of conversation.)' })

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: (req.maxTokens ?? 8192) + (thinksByDefault(req.model) ? 8192 : 0),
    stream: true,
    messages,
  }
  if (system) body.system = system
  // Study tools value speed over depth. Sampling parameters are rejected by current models, so they're omitted.
  if (supportsEffort(req.model)) body.output_config = { effort: 'low' }

  const res = await postJson({
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': req.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body,
    signal: req.signal,
    label: req.label,
    model: req.model,
  })

  let text = ''
  for await (const ev of readSse(res, req.signal)) {
    const data = parseJson<StreamEvent>(ev.data)
    if (!data) continue
    if (data.type === 'error') throw streamError(req.label, req.model, data.error)
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
      text += data.delta.text
      req.onToken(data.delta.text)
    } else if (data.type === 'message_delta' && data.delta?.stop_reason === 'refusal' && !text.trim()) {
      throw new AiError('refused', 'Claude declined to answer this request.')
    }
  }
  return text
}
