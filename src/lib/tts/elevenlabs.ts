// ElevenLabs: POST /v1/text-to-speech/{voice_id}/with-timestamps returns base64 MP3 plus
// per-character timing, which we turn into exact word timings for highlighting.

import { getSettings } from '../settings'
import { base64ToBytes } from './audio'
import { audioBlob, fetchJson, formatCost, keyFor, TtsError } from './http'
import { ENGINE_INFO } from './info'
import type { SynthEngine, SynthResult, VoiceInfo, WordTiming } from './types'

const PROVIDER = 'ElevenLabs'
const API = 'https://api.elevenlabs.io'
const DEFAULT_MODEL = 'eleven_flash_v2_5'

type Row = [id: string, name: string, gender: 'female' | 'male' | 'neutral', lang: string, description: string]

// Classic premade voices, shown when the account's own list can't be fetched.
// ElevenLabs retires these on Dec 31, 2026 and only accounts created before March 2026
// can use them; with a key we always prefer the live list from the API.
const FALLBACK: Row[] = [
  ['EXAVITQu4vr4xnSDxMaL', 'Sarah', 'female', 'en-US', 'Mature, reassuring'],
  ['JBFqnCBsd6RMkjVDRZzb', 'George', 'male', 'en-GB', 'Warm storyteller'],
  ['FGY2WhTYpPnrIDTdsKH5', 'Laura', 'female', 'en-US', 'Enthusiastic'],
  ['nPczCjzI2devNBz1zQrb', 'Brian', 'male', 'en-US', 'Deep, resonant'],
  ['Xb7hH8MSUJpSbSDYk0k2', 'Alice', 'female', 'en-GB', 'Clear, engaging'],
  ['onwK4e9ZLuTAKqWW03F9', 'Daniel', 'male', 'en-GB', 'Steady broadcaster'],
  ['XrExE9yKIg1WjnnlVkGX', 'Matilda', 'female', 'en-US', 'Knowledgeable'],
  ['cjVigY5qzO86Huf0OWal', 'Eric', 'male', 'en-US', 'Smooth, trustworthy'],
  ['pFZP5JQG7iQjIQuC4Bku', 'Lily', 'female', 'en-GB', 'Velvety'],
  ['CwhRBWXzGAHq8TQ4Fs17', 'Roger', 'male', 'en-US', 'Laid-back'],
  ['cgSgspJ2msm6clMCkdW9', 'Jessica', 'female', 'en-US', 'Playful, bright'],
  ['iP95p4xoKVk53GoZ742B', 'Chris', 'male', 'en-US', 'Charming'],
  ['SAz9YHcvj6GT2YYXdXww', 'River', 'neutral', 'en-US', 'Relaxed, neutral'],
  ['TX3LPaxmHKxFdv7VOQHJ', 'Liam', 'male', 'en-US', 'Energetic'],
  ['bIHbv24MWmeRgasZH58o', 'Will', 'male', 'en-US', 'Relaxed optimist'],
  ['IKne3meq5aSn9XLyUdCD', 'Charlie', 'male', 'en-AU', 'Deep, confident'],
  ['N2lVS1w4EtoT3dr4eOWO', 'Callum', 'male', 'en-US', 'Husky'],
  ['pqHfZKP75CvOlQylNhV4', 'Bill', 'male', 'en-US', 'Wise, mature'],
]

const FALLBACK_VOICES: VoiceInfo[] = FALLBACK.map(([id, name, gender, lang, description], i) => ({
  id,
  name,
  gender,
  lang,
  description,
  recommended: i < 2,
}))

const model = () => getSettings().ttsModels.elevenlabs.trim() || DEFAULT_MODEL

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

interface ApiVoice {
  voice_id: string
  name: string
  category?: string
  description?: string | null
  labels?: Record<string, string | undefined>
}

let voiceCache: { key: string; voices: Promise<VoiceInfo[]> } | null = null

const ACCENT_LANG: Record<string, string> = { american: 'en-US', british: 'en-GB', australian: 'en-AU', irish: 'en-IE', indian: 'en-IN' }

function mapVoice(v: ApiVoice): VoiceInfo {
  const labels = v.labels ?? {}
  const gender = labels.gender?.toLowerCase()
  const accent = labels.accent?.toLowerCase() ?? ''
  const bits = [labels.descriptive ?? labels.description, labels.accent, labels.use_case?.replace(/_/g, ' ')].filter(Boolean)
  return {
    id: v.voice_id,
    // Newer library names read "Talia - Warm Soft Guide": keep the short name, move the rest to the hint.
    name: v.name.split(' - ')[0].trim() || v.name,
    gender: gender === 'female' || gender === 'male' || gender === 'neutral' ? gender : undefined,
    lang: labels.language ? labels.language : ACCENT_LANG[accent],
    description: (v.name.includes(' - ') ? v.name.split(' - ').slice(1).join(' - ') : bits.join(' · ')) || undefined,
    recommended: v.category === 'premade' || v.category === 'default' || undefined,
  }
}

async function fetchVoices(key: string): Promise<VoiceInfo[]> {
  const out: VoiceInfo[] = []
  let token: string | undefined
  // A few pages at most: premade + the account's own voices.
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${API}/v2/voices`)
    url.searchParams.set('page_size', '100')
    if (token) url.searchParams.set('next_page_token', token)
    const res = await fetchJson<{ voices?: ApiVoice[]; has_more?: boolean; next_page_token?: string | null }>(
      url.toString(),
      { headers: { 'xi-api-key': key } },
      new AbortController().signal,
      { provider: PROVIDER, timeoutMs: 15_000 },
    )
    out.push(...(res.voices ?? []).filter((v) => v?.voice_id && v?.name).map(mapVoice))
    if (!res.has_more || !res.next_page_token) break
    token = res.next_page_token
  }
  return out.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || a.name.localeCompare(b.name))
}

/** The account's voices (cached per key for the session), or the classic list if they can't be fetched. */
function listVoices(): Promise<VoiceInfo[]> {
  const key = keyFor('elevenlabs')
  if (!key) return Promise.resolve(FALLBACK_VOICES)
  if (voiceCache?.key !== key) {
    const voices = fetchVoices(key).then((list) => (list.length ? list : FALLBACK_VOICES))
    voiceCache = { key, voices }
    // Don't remember failures: try again next time.
    voices.catch(() => {
      if (voiceCache?.voices === voices) voiceCache = null
    })
  }
  return voiceCache.voices.catch(() => FALLBACK_VOICES)
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

interface Alignment {
  characters?: string[]
  character_start_times_seconds?: number[]
  character_end_times_seconds?: number[]
}

/**
 * Group runs of non-space characters into words. Offsets are into `text`; returns undefined
 * if the alignment doesn't line up with the text we sent.
 */
export function alignmentToWords(text: string, a: Alignment | null | undefined): WordTiming[] | undefined {
  const chars = a?.characters
  const starts = a?.character_start_times_seconds
  const ends = a?.character_end_times_seconds
  if (!chars?.length || !starts || !ends || starts.length !== chars.length || ends.length !== chars.length) return undefined
  // Normally identical to `text`; tolerate the provider trimming surrounding whitespace.
  const base = text.indexOf(chars.join(''))
  if (base < 0) return undefined
  const words: WordTiming[] = []
  let offset = base
  let current: WordTiming | null = null
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (!ch.trim()) {
      current = null
    } else if (current) {
      current.end = Math.max(current.end, ends[i])
      current.charEnd = offset + ch.length
    } else {
      current = { start: starts[i], end: ends[i], charStart: offset, charEnd: offset + ch.length }
      words.push(current)
    }
    offset += ch.length
  }
  return words
}

async function synthesize(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
  const key = keyFor('elevenlabs')
  if (!key) throw new Error(elevenlabsEngine.notReadyReason() ?? 'Add your ElevenLabs key in Settings.')
  const voiceId = voice || (await listVoices())[0]?.id
  if (!voiceId) throw new TtsError('Pick an ElevenLabs voice in Settings.')
  const res = await fetchJson<{ audio_base64?: string; alignment?: Alignment | null }>(
    `${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: model() }),
    },
    signal,
    { provider: PROVIDER },
  )
  if (!res.audio_base64) throw new TtsError('ElevenLabs returned no audio. Try again.')
  return {
    blob: audioBlob(base64ToBytes(res.audio_base64), 'audio/mpeg', PROVIDER),
    words: alignmentToWords(text, res.alignment),
  }
}

export const elevenlabsEngine: SynthEngine = {
  info: ENGINE_INFO.elevenlabs,
  kind: 'synth',
  maxChunkChars: 800,
  prefetch: 2,
  cacheable: true,
  modelId: model,
  isReady: () => !!keyFor('elevenlabs'),
  notReadyReason: () => (keyFor('elevenlabs') ? null : 'Add your ElevenLabs API key in Settings to use ElevenLabs voices.'),
  listVoices,
  synthesize,
  // Pay-as-you-go API rates: Flash/Turbo $0.05 per 1K chars, Multilingual/v3 $0.10.
  estimateCost: (chars) => formatCost(chars * (/flash|turbo/.test(model()) ? 50e-6 : 100e-6)),
}
