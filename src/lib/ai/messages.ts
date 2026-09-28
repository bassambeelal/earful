import type { ChatMessage } from './types'

export interface Turn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Split a conversation into one system prompt and clean user/assistant turns:
 * empty messages are dropped and consecutive turns from the same role are merged,
 * because Anthropic and Gemini reject empty text and expect alternating roles.
 */
export function splitSystem(messages: ChatMessage[]): { system: string; turns: Turn[] } {
  const system = messages
    .filter((m) => m.role === 'system' && m.content.trim())
    .map((m) => m.content)
    .join('\n\n')
  const turns: Turn[] = []
  for (const m of messages) {
    if (m.role === 'system' || !m.content.trim()) continue
    const prev = turns[turns.length - 1]
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${m.content}`
    else turns.push({ role: m.role, content: m.content })
  }
  return { system, turns }
}
