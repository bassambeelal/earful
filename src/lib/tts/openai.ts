// OpenAI text-to-speech: POST https://api.openai.com/v1/audio/speech
// Models: gpt-4o-mini-tts (steerable with `instructions`), tts-1, tts-1-hd. Max input 4096 chars.

import { getSettings } from '../settings'
import { audioBlob, fetchBytes, formatCost, keyFor, splitText } from './http'
import { ENGINE_INFO } from './info'
import type { SynthEngine, SynthResult, VoiceInfo } from './types'

const PROVIDER = 'OpenAI'
const ENDPOINT = 'https://api.openai.com/v1/audio/speech'
const MAX_INPUT = 4096

type Row = [id: string, gender: VoiceInfo['gender'], description: string, newModelsOnly?: boolean]

// OpenAI recommends marin and cedar for the best quality.
const ROWS: Row[] = [
  ['marin', 'female', 'Natural and warm · best quality', true],
  ['cedar', 'male', 'Natural and grounded · best quality', true],
  ['coral', 'female', 'Warm and friendly'],
  ['sage', 'female', 'Calm and thoughtful'],
  ['nova', 'female', 'Bright and upbeat'],
  ['shimmer', 'female', 'Light and clear'],
  ['alloy', 'neutral', 'Balanced and neutral'],
  ['ash', 'male', 'Clear and confident'],
  ['ballad', 'male', 'Soft and expressive', true],
  ['echo', 'male', 'Calm and even'],
  ['fable', 'male', 'Storyteller'],
  ['onyx', 'male', 'Deep and steady'],
  ['verse', 'male', 'Expressive and dynamic', true],
]

/** tts-1 and tts-1-hd predate the newer voices and ignore `instructions`. */
const isLegacyModel = (model: string) => /^tts-1/.test(model)

function voicesFor(model: string): VoiceInfo[] {
  const legacy = isLegacyModel(model)
  return ROWS.filter((r) => !(legacy && r[3])).map(([id, gender, description]) => ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    gender,
    description,
    recommended: id === 'marin' || id === 'cedar' || (legacy && id === 'coral'),
  }))
}

const model = () => getSettings().ttsModels.openai.trim() || 'gpt-4o-mini-tts'

async function synthesize(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
  const key = keyFor('openai')
  if (!key) throw new Error(openaiEngine.notReadyReason() ?? 'Add your OpenAI key in Settings.')
  const m = model()
  const allowed = voicesFor(m)
  // Keep a voice the list doesn't know (custom voices, new releases) unless the model is legacy.
  const v = voice && (!isLegacyModel(m) || allowed.some((a) => a.id === voice)) ? voice : allowed[0].id
  const instructions = getSettings().openaiInstructions.trim()

  const one = async (input: string) => {
    const body: Record<string, unknown> = { model: m, input, voice: v, response_format: 'mp3' }
    if (instructions && !isLegacyModel(m)) body.instructions = instructions
    const { bytes } = await fetchBytes(
      ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      signal,
      { provider: PROVIDER },
    )
    return audioBlob(bytes, 'audio/mpeg', PROVIDER)
  }

  if (text.length <= MAX_INPUT) return { blob: await one(text) }
  // Rare (the player sends ~500 chars): MP3 streams can simply be concatenated.
  const parts: Blob[] = []
  for (const piece of splitText(text, MAX_INPUT)) parts.push(await one(piece))
  return { blob: new Blob(parts, { type: 'audio/mpeg' }) }
}

/** USD per character: gpt-4o-mini-tts ≈ $0.015/min of audio (~900 chars), tts-1 $15/1M, tts-1-hd $30/1M. */
function pricePerChar(m: string): number {
  if (/^tts-1-hd/.test(m)) return 30e-6
  if (/^tts-1/.test(m)) return 15e-6
  return 16e-6
}

export const openaiEngine: SynthEngine = {
  info: ENGINE_INFO.openai,
  kind: 'synth',
  maxChunkChars: 500,
  prefetch: 2,
  cacheable: true,
  modelId: model,
  isReady: () => !!keyFor('openai'),
  notReadyReason: () => (keyFor('openai') ? null : 'Add your OpenAI API key in Settings to use OpenAI voices.'),
  listVoices: async () => voicesFor(model()),
  synthesize,
  estimateCost: (chars) => formatCost(chars * pricePerChar(model())),
}
