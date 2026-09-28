import type { AiProviderId } from '../settings'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  messages: ChatMessage[]
  signal?: AbortSignal
  /** Streaming callback with each new text delta. */
  onToken?: (delta: string) => void
  temperature?: number
  maxTokens?: number
  /** Ask the model for a JSON object response. */
  json?: boolean
  /** Override provider (defaults to settings.ai.provider). */
  provider?: AiProviderId
}

/** Static info per provider for the settings UI. */
export interface AiProviderInfo {
  id: AiProviderId
  label: string
  keyUrl?: string
  modelSuggestions: string[]
  /** True if it needs no key (Chrome built-in AI). */
  keyless?: boolean
}

/** A fully resolved request handed to a provider adapter. */
export interface ProviderRequest {
  provider: AiProviderId
  label: string
  model: string
  key: string
  messages: ChatMessage[]
  signal?: AbortSignal
  onToken: (delta: string) => void
  temperature?: number
  maxTokens?: number
  json?: boolean
}
