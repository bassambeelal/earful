import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { SpeakFilters } from './text'

// All user settings, persisted to localStorage on this device only.
// API keys are stored here too — they never leave the browser except in the
// request to the provider the user chose.

export type EngineId = 'browser' | 'kokoro' | 'openai' | 'gemini' | 'elevenlabs' | 'groq' | 'custom'
export type AiProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | 'custom' | 'chrome'
export type KeyId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | 'elevenlabs' | 'custom'

export type Theme = 'system' | 'light' | 'dark' | 'sepia'
export type ReaderFont = 'serif' | 'sans' | 'hyperlegible' | 'dyslexic'

export interface DisplaySettings {
  theme: Theme
  font: ReaderFont
  /** px */
  fontSize: number
  lineHeight: number
  /** max text column width in ch */
  width: number
  highlightSentence: boolean
  highlightWord: boolean
  autoScroll: boolean
  /** Dim everything except the current sentence. */
  focusMode: boolean
}

export interface ReadingSettings extends SpeakFilters {
  /** Announce headings (read them) or skip them. */
  readHeadings: boolean
  /** Extra pause between paragraphs, ms (at 1x). */
  paragraphPauseMs: number
}

export interface Settings {
  engine: EngineId
  /** Selected voice id per engine. */
  voices: Partial<Record<EngineId, string>>
  rate: number
  keys: Partial<Record<KeyId, string>>
  /** Model ids for cloud TTS engines. */
  ttsModels: { openai: string; gemini: string; elevenlabs: string; groq: string; custom: string }
  /** Optional style instructions for OpenAI gpt-4o-mini-tts ("Speak calmly, like an audiobook narrator"). */
  openaiInstructions: string
  /** Base URL for an OpenAI-compatible TTS/LLM server (e.g. Kokoro-FastAPI, Ollama, LM Studio). */
  customTtsBaseUrl: string
  kokoro: { device: 'auto' | 'webgpu' | 'wasm'; autoload: boolean }
  ai: {
    provider: AiProviderId
    models: Record<Exclude<AiProviderId, 'chrome'>, string>
    customBaseUrl: string
  }
  reading: ReadingSettings
  display: DisplaySettings
  /** Seen the first-run welcome. */
  onboarded: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'browser',
  voices: { kokoro: 'af_heart', openai: 'marin', gemini: 'Kore', groq: 'autumn', custom: 'af_heart' },
  rate: 1,
  keys: {},
  ttsModels: {
    openai: 'gpt-4o-mini-tts',
    gemini: 'gemini-3.8-flash-lite-tts',
    elevenlabs: 'eleven_flash_v2_5',
    groq: 'canopylabs/orpheus-v1-english',
    custom: 'kokoro',
  },
  openaiInstructions: '',
  customTtsBaseUrl: 'http://localhost:8880/v1',
  kokoro: { device: 'auto', autoload: false },
  ai: {
    provider: 'openai',
    models: {
      openai: 'gpt-6-luna',
      anthropic: 'claude-haiku-4-5',
      gemini: 'gemini-3.5-flash-lite',
      openrouter: 'openai/gpt-6-luna',
      groq: 'llama-3.3-70b-versatile',
      custom: 'llama3.2',
    },
    customBaseUrl: 'http://localhost:11434/v1',
  },
  reading: {
    skipCitations: true,
    skipUrls: true,
    skipParentheticals: false,
    readHeadings: true,
    paragraphPauseMs: 250,
  },
  display: {
    theme: 'system',
    font: 'serif',
    fontSize: 20,
    lineHeight: 1.7,
    width: 68,
    highlightSentence: true,
    highlightWord: true,
    autoScroll: true,
    focusMode: false,
  },
  onboarded: false,
}

export const RATE_MIN = 0.5
export const RATE_MAX = 4

interface SettingsActions {
  set: (patch: Partial<Settings>) => void
  setDisplay: (patch: Partial<DisplaySettings>) => void
  setReading: (patch: Partial<ReadingSettings>) => void
  setKey: (id: KeyId, value: string) => void
  setVoice: (engine: EngineId, voice: string) => void
  setAi: (patch: Partial<Settings['ai']>) => void
  setAiModel: (provider: Exclude<AiProviderId, 'chrome'>, model: string) => void
  setTtsModel: (engine: keyof Settings['ttsModels'], model: string) => void
  reset: () => void
}

function deepMerge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k]
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v
  }
  return out as T
}

export const useSettings = create<Settings & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      setDisplay: (patch) => set((s) => ({ display: { ...s.display, ...patch } })),
      setReading: (patch) => set((s) => ({ reading: { ...s.reading, ...patch } })),
      setKey: (id, value) => set((s) => ({ keys: { ...s.keys, [id]: value.trim() || undefined } })),
      setVoice: (engine, voice) => set((s) => ({ voices: { ...s.voices, [engine]: voice } })),
      setAi: (patch) => set((s) => ({ ai: { ...s.ai, ...patch } })),
      setAiModel: (provider, model) => set((s) => ({ ai: { ...s.ai, models: { ...s.ai.models, [provider]: model } } })),
      setTtsModel: (engine, model) => set((s) => ({ ttsModels: { ...s.ttsModels, [engine]: model } })),
      reset: () => set({ ...DEFAULT_SETTINGS, keys: {} }),
    }),
    {
      name: 'earful:settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => {
        const { set: _a, setDisplay: _b, setReading: _c, setKey: _d, setVoice: _e, setAi: _f, setAiModel: _g, setTtsModel: _h, reset: _i, ...data } = s
        return data
      },
      merge: (persisted, current) => deepMerge(current, persisted),
    },
  ),
)

/** Non-React accessor. */
export const getSettings = () => useSettings.getState()

/** Resolve the effective theme ('system' -> light/dark). */
export function resolvedTheme(theme: Theme): 'light' | 'dark' | 'sepia' {
  if (theme !== 'system') return theme
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
