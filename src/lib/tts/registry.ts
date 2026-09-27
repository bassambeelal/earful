// CONTRACT STUB — replaced by the TTS module implementation.
// Public API used by the player, the export dialog and the UI.
import type { EngineId } from '../settings'
import type { EngineInfo, TtsEngine } from './types'

export const ENGINE_ORDER: EngineId[] = ['browser', 'kokoro', 'openai', 'gemini', 'elevenlabs', 'groq', 'custom']

/** Static metadata for every engine (label, needsKey, free/offline, price hint). */
export declare const ENGINE_INFO: Record<EngineId, EngineInfo>

/** Returns the engine singleton for `id`. */
export declare function getEngine(id: EngineId): TtsEngine

/** Check an engine works (key valid, server reachable) with a tiny request. Never throws. */
export declare function testEngine(id: EngineId): Promise<{ ok: boolean; message: string }>
