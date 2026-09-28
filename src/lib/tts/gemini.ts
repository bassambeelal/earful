// Google Gemini text-to-speech through the Interactions API (the documented path for the
// Gemini TTS models in 2026): POST https://generativelanguage.googleapis.com/v1beta/interactions
// The key goes in the x-goog-api-key header, never in the URL. `store: false` keeps the
// request from being retained server-side. Unary responses are WAV (Gemini 3.8 TTS) or raw
// 16-bit PCM at 24 kHz (older preview models); both are handled.

import { getSettings } from '../settings'
import { base64ToBytes, isWav, pcm16ToWav, wavDuration } from './audio'
import { fetchJson, formatCost, keyFor, TtsError } from './http'
import { ENGINE_INFO } from './info'
import type { SynthEngine, SynthResult, VoiceInfo } from './types'

const PROVIDER = 'Gemini'
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
const DEFAULT_MODEL = 'gemini-3.8-flash-lite-tts'

type Row = [name: string, gender: 'female' | 'male', style: string]

// The 30 prebuilt voices, with Google's one-word style descriptor. All are multilingual.
const ROWS: Row[] = [
  ['Kore', 'female', 'Firm'],
  ['Sulafat', 'female', 'Warm'],
  ['Charon', 'male', 'Informative'],
  ['Zephyr', 'female', 'Bright'],
  ['Puck', 'male', 'Upbeat'],
  ['Fenrir', 'male', 'Excitable'],
  ['Leda', 'female', 'Youthful'],
  ['Orus', 'male', 'Firm'],
  ['Aoede', 'female', 'Breezy'],
  ['Callirrhoe', 'female', 'Easy-going'],
  ['Autonoe', 'female', 'Bright'],
  ['Enceladus', 'male', 'Breathy'],
  ['Iapetus', 'male', 'Clear'],
  ['Umbriel', 'male', 'Easy-going'],
  ['Algieba', 'male', 'Smooth'],
  ['Despina', 'female', 'Smooth'],
  ['Erinome', 'female', 'Clear'],
  ['Algenib', 'male', 'Gravelly'],
  ['Rasalgethi', 'male', 'Informative'],
  ['Laomedeia', 'female', 'Upbeat'],
  ['Achernar', 'female', 'Soft'],
  ['Alnilam', 'male', 'Firm'],
  ['Schedar', 'male', 'Even'],
  ['Gacrux', 'female', 'Mature'],
  ['Pulcherrima', 'female', 'Forward'],
  ['Achird', 'male', 'Friendly'],
  ['Zubenelgenubi', 'male', 'Casual'],
  ['Vindemiatrix', 'female', 'Gentle'],
  ['Sadachbia', 'male', 'Lively'],
  ['Sadaltager', 'male', 'Knowledgeable'],
]

const RECOMMENDED = new Set(['Kore', 'Sulafat', 'Charon'])

const VOICES: VoiceInfo[] = ROWS.map(([name, gender, style]) => ({
  id: name,
  name,
  gender,
  description: style,
  recommended: RECOMMENDED.has(name),
}))

const model = () => getSettings().ttsModels.gemini.trim() || DEFAULT_MODEL

interface AudioPart {
  data: string
  mime: string
}

/**
 * Find the last base64 audio block anywhere in the reply. Tolerates both the Interactions
 * shape (steps[].content[] {type:'audio', data, mime_type}) and generateContent's inlineData.
 */
function findAudio(node: unknown, found: AudioPart[] = []): AudioPart[] {
  if (Array.isArray(node)) {
    node.forEach((n) => findAudio(n, found))
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>
    const mime = String(o.mime_type ?? o.mimeType ?? '')
    if (typeof o.data === 'string' && (o.type === 'audio' || mime.startsWith('audio/'))) {
      found.push({ data: o.data, mime })
    } else {
      Object.values(o).forEach((v) => findAudio(v, found))
    }
  }
  return found
}

function toResult(part: AudioPart): SynthResult {
  const bytes = base64ToBytes(part.data)
  if (isWav(bytes)) return { blob: new Blob([bytes], { type: 'audio/wav' }), duration: wavDuration(bytes) }
  if (/mulaw|alaw/i.test(part.mime)) throw new TtsError('Gemini returned an unsupported audio format.')
  const rate = Number(/rate=(\d+)/i.exec(part.mime)?.[1]) || 24000
  return { blob: pcm16ToWav(bytes, rate), duration: bytes.length / 2 / rate }
}

async function synthesize(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
  const key = keyFor('gemini')
  if (!key) throw new Error(geminiEngine.notReadyReason() ?? 'Add your Gemini key in Settings.')
  const body = {
    model: model(),
    input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: voice || 'Kore' }] },
    store: false,
  }
  const reply = await fetchJson<unknown>(
    ENDPOINT,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    signal,
    { provider: PROVIDER, timeoutMs: 90_000 },
  )
  const parts = findAudio(reply)
  const last = parts[parts.length - 1]
  if (!last) throw new TtsError("Gemini didn't return audio for this passage. Try again, or pick another Gemini voice model.")
  return toResult(last)
}

/** USD per character from audio-token pricing (25 tokens/s, ~15 chars/s): Flash-Lite $6, Flash $9, Pro $20 per 1M tokens. */
function pricePerChar(m: string): number {
  const perToken = /lite/.test(m) ? 6e-6 : /pro/.test(m) ? 20e-6 : 9e-6
  return (perToken * 25) / 15
}

export const geminiEngine: SynthEngine = {
  info: ENGINE_INFO.gemini,
  kind: 'synth',
  maxChunkChars: 500,
  prefetch: 2,
  cacheable: true,
  modelId: model,
  isReady: () => !!keyFor('gemini'),
  notReadyReason: () => (keyFor('gemini') ? null : 'Add your Gemini API key in Settings to use Gemini voices.'),
  listVoices: async () => VOICES,
  synthesize,
  estimateCost: (chars) => formatCost(chars * pricePerChar(model())),
}
