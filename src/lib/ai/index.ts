// CONTRACT STUB — replaced by the AI module implementation.
// Bring-your-own-key LLM access, called directly from the browser.
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

export declare const AI_PROVIDERS: AiProviderInfo[]

/** True if the currently selected provider is usable (key present or keyless & available). */
export declare function aiReady(): boolean
/** Human reason when not ready. */
export declare function aiNotReadyReason(): string | null

/** Run a chat completion with the user's selected provider/model/key. Resolves with the full text. */
export declare function chat(opts: ChatOptions): Promise<string>

/** Validate a key with a tiny request. Resolves with an ok flag and a human message. */
export declare function testAiKey(provider: AiProviderId): Promise<{ ok: boolean; message: string }>
