// Google Gemini (generateContent streaming). The key goes in a header, never in the URL.
import { AiError, streamError } from './errors'
import { splitSystem } from './messages'
import { parseJson, postJson, readSse } from './sse'
import type { ProviderRequest } from './types'

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
  error?: unknown
}

const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'])

export async function geminiChat(req: ProviderRequest): Promise<string> {
  const model = req.model.replace(/^models\//, '')
  const { system, turns } = splitSystem(req.messages)
  const contents = turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))

  const gen3 = /^gemini-[3-9]/.test(model)
  const generationConfig: Record<string, unknown> = {}
  if (req.json) generationConfig.responseMimeType = 'application/json'
  // Gemini 3 models want default sampling; a light thinking level keeps study tools fast.
  if (gen3) {
    if (!model.includes('lite')) generationConfig.thinkingConfig = { thinkingLevel: 'low' }
  } else if (req.temperature !== undefined) {
    generationConfig.temperature = req.temperature
  }

  const body: Record<string, unknown> = { contents }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig

  const res = await postJson({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    headers: { 'x-goog-api-key': req.key },
    body,
    signal: req.signal,
    label: req.label,
    model,
  })

  let text = ''
  let blocked = ''
  for await (const ev of readSse(res, req.signal)) {
    const chunk = parseJson<GeminiChunk>(ev.data)
    if (!chunk) continue
    if (chunk.error) throw streamError(req.label, model, chunk.error)
    if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason
    const cand = chunk.candidates?.[0]
    for (const part of cand?.content?.parts ?? []) {
      if (part.thought || !part.text) continue
      text += part.text
      req.onToken(part.text)
    }
    if (cand?.finishReason && BLOCKED.has(cand.finishReason)) blocked = cand.finishReason
  }
  if (!text.trim() && blocked) {
    throw new AiError(
      'refused',
      blocked === 'RECITATION'
        ? 'Gemini stopped because the answer would repeat copyrighted text word for word. Try a different request.'
        : 'Gemini declined to answer this request because of its safety filters.',
    )
  }
  return text
}
