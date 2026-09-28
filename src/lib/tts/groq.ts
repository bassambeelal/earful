// Groq: OpenAI-compatible POST https://api.groq.com/openai/v1/audio/speech with Canopy Labs'
// Orpheus English model. Orpheus accepts at most 200 characters per request and only returns
// WAV, so longer passages are split and the WAV pieces joined.

import { getSettings } from '../settings'
import { concatWav, wavDuration } from './audio'
import { audioBlob, fetchBytes, formatCost, keyFor, splitText, TtsError } from './http'
import { ENGINE_INFO } from './info'
import type { SynthEngine, SynthResult, VoiceInfo } from './types'

const PROVIDER = 'Groq'
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/speech'
const DEFAULT_MODEL = 'canopylabs/orpheus-v1-english'
const MAX_INPUT = 200

const VOICES: VoiceInfo[] = [
  { id: 'autumn', name: 'Autumn', gender: 'female', lang: 'en-US', description: 'American English', recommended: true },
  { id: 'diana', name: 'Diana', gender: 'female', lang: 'en-US', description: 'American English' },
  { id: 'hannah', name: 'Hannah', gender: 'female', lang: 'en-US', description: 'American English' },
  { id: 'troy', name: 'Troy', gender: 'male', lang: 'en-US', description: 'American English', recommended: true },
  { id: 'austin', name: 'Austin', gender: 'male', lang: 'en-US', description: 'American English' },
  { id: 'daniel', name: 'Daniel', gender: 'male', lang: 'en-US', description: 'American English' },
]

const model = () => getSettings().ttsModels.groq.trim() || DEFAULT_MODEL

async function synthesize(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
  const key = keyFor('groq')
  if (!key) throw new Error(groqEngine.notReadyReason() ?? 'Add your Groq key in Settings.')
  const m = model()
  const one = async (input: string) => {
    const { bytes } = await fetchBytes(
      ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, input, voice: voice || 'autumn', response_format: 'wav' }),
      },
      signal,
      { provider: PROVIDER },
    )
    audioBlob(bytes, 'audio/wav', PROVIDER) // validates the body
    return bytes
  }

  const pieces = text.length > MAX_INPUT ? splitText(text, MAX_INPUT) : [text]
  const wavs: Uint8Array<ArrayBuffer>[] = []
  for (const piece of pieces) wavs.push(await one(piece))
  if (wavs.length === 1) return { blob: new Blob([wavs[0]], { type: 'audio/wav' }), duration: wavDuration(wavs[0]) }
  const joined = concatWav(wavs)
  if (!joined) throw new TtsError('Groq returned audio in an unexpected format. Try again.')
  return { blob: joined, duration: wavs.reduce((t, w) => t + (wavDuration(w) ?? 0), 0) || undefined }
}

export const groqEngine: SynthEngine = {
  info: ENGINE_INFO.groq,
  kind: 'synth',
  // Longer than Orpheus' 200-character limit on purpose: synthesize() splits at sentence or
  // clause boundaries and joins the WAV pieces, so the player can plan normal-sized chunks.
  maxChunkChars: 400,
  prefetch: 2,
  cacheable: true,
  modelId: model,
  isReady: () => !!keyFor('groq'),
  notReadyReason: () => (keyFor('groq') ? null : 'Add your Groq API key in Settings to use Groq voices.'),
  listVoices: async () => VOICES,
  synthesize,
  // Orpheus English: $22 per 1M characters.
  estimateCost: (chars) => formatCost(chars * 22e-6),
}
