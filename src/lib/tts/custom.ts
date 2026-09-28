// "Your own server": any OpenAI-compatible speech endpoint ({base}/audio/speech), such as
// Kokoro-FastAPI, openedai-speech or LocalAI. The bearer key is optional.

import { getSettings } from '../settings'
import { isWav, wavDuration } from './audio'
import { audioBlob, fetchBytes, fetchJson, keyFor, TtsError } from './http'
import { ENGINE_INFO } from './info'
import { KOKORO_VOICES } from './kokoro-voices'
import type { SynthEngine, SynthResult, VoiceInfo } from './types'

const PROVIDER = 'Your server'

/** OpenAI's classic voice names, which most compatible servers accept. */
const OPENAI_STYLE: VoiceInfo[] = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'].map((id) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
}))

const KOKORO_BY_ID = new Map(KOKORO_VOICES.map((v) => [v.id, v]))

const baseUrl = () => getSettings().customTtsBaseUrl.trim().replace(/\/+$/, '')
const model = () => getSettings().ttsModels.custom.trim() || 'kokoro'

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  const key = keyFor('custom')
  if (key) h.Authorization = `Bearer ${key}`
  return h
}

const unreachable = (base: string) =>
  `Couldn't reach your server at ${base}. Make sure it's running and allows requests from this site (CORS).`

/**
 * A friendly reason the address can't work from this page, checked before any request:
 * it must be an http(s) URL, and a secure (https) page may only call plain http:// on this
 * computer (browsers block other "mixed content", and so does the app's security policy).
 */
function addressProblem(base: string): string | null {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return 'Your server address should look like http://localhost:8880/v1. Check it in Settings.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Your server address should start with http:// or https://. Check it in Settings.'
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol === 'http:' && !local && typeof location !== 'undefined' && location.protocol === 'https:') {
    return 'Browsers only let this page use a secure https:// server, or a plain http:// server on this computer (localhost). Change the address in Settings.'
  }
  return null
}

const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/ogg': 'audio/ogg',
  'audio/opus': 'audio/ogg',
  'audio/aac': 'audio/aac',
  'audio/flac': 'audio/flac',
}

async function synthesize(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
  const base = baseUrl()
  if (!base) throw new Error(customEngine.notReadyReason() ?? 'Add your server address in Settings.')
  const problem = addressProblem(base)
  if (problem) throw new TtsError(problem)
  const { bytes, type } = await fetchBytes(
    `${base}/audio/speech`,
    {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({
        model: model(),
        input: text,
        voice: voice || getSettings().voices.custom || 'alloy',
        response_format: 'mp3',
      }),
    },
    signal,
    { provider: PROVIDER, unreachable: unreachable(base), timeoutMs: 120_000 },
  )
  // Some servers label audio as application/octet-stream: trust a WAV header over the label.
  if (isWav(bytes)) return { blob: audioBlob(bytes, 'audio/wav', PROVIDER), duration: wavDuration(bytes) }
  return { blob: audioBlob(bytes, AUDIO_TYPES[type] ?? 'audio/mpeg', PROVIDER) }
}

// ---------------------------------------------------------------------------
// Voices: Kokoro-FastAPI style GET {base}/audio/voices, else sensible defaults
// ---------------------------------------------------------------------------

type ServerVoice = string | { id?: string; voice_id?: string; name?: string; overall_grade?: string }

function mapServerVoice(v: ServerVoice | null): VoiceInfo | null {
  if (!v) return null
  const id = typeof v === 'string' ? v : (v.id ?? v.voice_id ?? v.name)
  if (!id || typeof id !== 'string') return null
  const known = KOKORO_BY_ID.get(id)
  if (known) return { ...known }
  const grade = typeof v === 'object' && v.overall_grade ? `Grade ${v.overall_grade}` : undefined
  return { id, name: (typeof v === 'object' && v.name) || id, description: grade }
}

let voiceCache: { key: string; voices: Promise<VoiceInfo[]> } | null = null

async function fetchServerVoices(base: string): Promise<VoiceInfo[]> {
  const res = await fetchJson<{ voices?: (ServerVoice | null)[] } | (ServerVoice | null)[] | null>(
    `${base}/audio/voices`,
    { headers: headers(false) },
    new AbortController().signal,
    { provider: PROVIDER, unreachable: unreachable(base), timeoutMs: 8_000 },
  )
  const list = Array.isArray(res) ? res : Array.isArray(res?.voices) ? res.voices : []
  return list.map(mapServerVoice).filter((v): v is VoiceInfo => v !== null)
}

function defaults(): VoiceInfo[] {
  const looksKokoro = /kokoro/i.test(model()) || /:8880\b/.test(baseUrl())
  return (looksKokoro ? KOKORO_VOICES : OPENAI_STYLE).map((v) => ({ ...v }))
}

/** Always include the voice currently chosen in Settings, even if the server didn't list it. */
function withSelected(list: VoiceInfo[]): VoiceInfo[] {
  const selected = getSettings().voices.custom
  if (selected && !list.some((v) => v.id === selected)) return [{ id: selected, name: selected }, ...list]
  return list
}

async function listVoices(): Promise<VoiceInfo[]> {
  const base = baseUrl()
  if (!base || addressProblem(base)) return withSelected(defaults())
  const cacheKey = `${base}|${keyFor('custom') ?? ''}`
  if (voiceCache?.key !== cacheKey) {
    const voices = fetchServerVoices(base).then((list) => (list.length ? list : defaults()))
    voiceCache = { key: cacheKey, voices }
    voices.catch(() => {
      if (voiceCache?.voices === voices) voiceCache = null
    })
  }
  return withSelected(await voiceCache.voices.catch(() => defaults()))
}

export const customEngine: SynthEngine = {
  info: ENGINE_INFO.custom,
  kind: 'synth',
  maxChunkChars: 400,
  prefetch: 2,
  cacheable: true,
  modelId: model,
  isReady: () => !!baseUrl(),
  notReadyReason: () => (baseUrl() ? null : 'Add the address of your OpenAI-compatible speech server in Settings.'),
  listVoices,
  synthesize,
  estimateCost: () => null,
}
