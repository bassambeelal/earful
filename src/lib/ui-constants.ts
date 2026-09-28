// Constants used across the UI.

export const REPO_URL = 'https://github.com/bassambeelal/earful'

/** Set at build time via `define` / VITE_APP_VERSION; falls back to the current release. */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || '1.0.0'

/** What a voice says when previewed. */
export const VOICE_PREVIEW_TEXT = 'Hi! This is how I sound.'

/** Where to create an API key for each premium voice provider. */
export const KEY_LINKS = {
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
  groq: 'https://console.groq.com/keys',
} as const

/** Model id suggestions for the cloud voice engines (free-text inputs; any id works). */
export const TTS_MODEL_SUGGESTIONS = {
  openai: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'],
  gemini: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts'],
  elevenlabs: ['eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3', 'eleven_flash_v2'],
  groq: ['canopylabs/orpheus-v1-english', 'canopylabs/orpheus-arabic-saudi'],
  custom: ['kokoro', 'tts-1'],
} as const

export const SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 2, 3]
