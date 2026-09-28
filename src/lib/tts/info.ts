import type { EngineId } from '../settings'
import type { EngineInfo } from './types'

// Static metadata for every engine. Kept separate from the engines so the
// registry and each engine can share it without circular imports.
// Prices are approximate pay-as-you-go rates checked against provider pages (2026).
export const ENGINE_INFO: Record<EngineId, EngineInfo> = {
  browser: {
    id: 'browser',
    label: 'Browser voices',
    description: 'Built into your device. Instant and free; quality depends on your browser and system.',
    kind: 'speech',
    needsKey: null,
    free: true,
    offline: true,
  },
  kokoro: {
    id: 'kokoro',
    label: 'Natural voices (offline)',
    description: 'Lifelike English voices that run on your device after a one-time download. Free and private.',
    kind: 'synth',
    needsKey: null,
    free: true,
    offline: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    description: 'Expressive voices you can steer with style instructions. Uses your OpenAI key.',
    kind: 'synth',
    needsKey: 'openai',
    free: false,
    offline: false,
    priceHint: '≈ $15 / 1M chars',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    description: '30 natural voices that speak 100+ languages. Uses your Gemini key; a free tier is available.',
    kind: 'synth',
    needsKey: 'gemini',
    free: false,
    offline: false,
    priceHint: 'Free tier, then ≈ $10 / 1M chars',
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'Studio-quality voices with exact word timing. Uses your ElevenLabs key.',
    kind: 'synth',
    needsKey: 'elevenlabs',
    free: false,
    offline: false,
    priceHint: '$50–100 / 1M chars',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    description: 'Fast, expressive English voices (Orpheus). Uses your Groq key.',
    kind: 'synth',
    needsKey: 'groq',
    free: false,
    offline: false,
    priceHint: '$22 / 1M chars',
  },
  custom: {
    id: 'custom',
    label: 'Your own server',
    description: 'Any OpenAI-compatible speech server, such as Kokoro-FastAPI running on your computer.',
    kind: 'synth',
    needsKey: null,
    free: true,
    offline: false,
  },
}
