// Engine registry: static metadata, singletons and a connection test.
// Public API used by the player, the export dialog and the UI.
import { getSettings, type EngineId } from '../settings'
import { customEngine } from './custom'
import { elevenlabsEngine } from './elevenlabs'
import { geminiEngine } from './gemini'
import { groqEngine } from './groq'
import { isAbortError } from './http'
import { kokoroEngine } from './kokoro'
import { openaiEngine } from './openai'
import type { TtsEngine } from './types'
import { webSpeechEngine } from './webspeech'

export const ENGINE_ORDER: EngineId[] = ['browser', 'kokoro', 'openai', 'gemini', 'elevenlabs', 'groq', 'custom']

/** Static metadata for every engine (label, needsKey, free/offline, price hint). */
export { ENGINE_INFO } from './info'

const ENGINES: Record<EngineId, TtsEngine> = {
  browser: webSpeechEngine,
  kokoro: kokoroEngine,
  openai: openaiEngine,
  gemini: geminiEngine,
  elevenlabs: elevenlabsEngine,
  groq: groqEngine,
  custom: customEngine,
}

/** Returns the engine singleton for `id` (browser voices for an unknown id). */
export function getEngine(id: EngineId): TtsEngine {
  return ENGINES[id] ?? ENGINES.browser
}

/** Check an engine works (key valid, server reachable) with a tiny request. Never throws. */
export async function testEngine(id: EngineId): Promise<{ ok: boolean; message: string }> {
  const engine = getEngine(id)
  const label = engine.info.label
  try {
    if (!engine.isReady()) return { ok: false, message: engine.notReadyReason() ?? `${label} isn't ready yet.` }
    if (engine.kind === 'speech') {
      const voices = await engine.listVoices()
      return voices.length
        ? { ok: true, message: `${label} are available (${voices.length} voice${voices.length === 1 ? '' : 's'}).` }
        : { ok: true, message: `${label} are available, using your system's default voice.` }
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 45_000)
    try {
      // A short sentence rather than a single word: speech models sometimes answer "Hi" with text instead of audio.
      const result = await engine.synthesize('Hello, this is a quick test.', getSettings().voices[id] ?? '', ctrl.signal)
      if (!result.blob.size) return { ok: false, message: `${label} answered, but sent no audio.` }
    } finally {
      clearTimeout(timer)
    }
    return { ok: true, message: `${label} is working.` }
  } catch (e) {
    if (isAbortError(e)) return { ok: false, message: `${label} took too long to answer. Try again.` }
    const msg = e instanceof Error && e.message ? e.message : String(e)
    return { ok: false, message: msg || `${label} isn't working right now.` }
  }
}
