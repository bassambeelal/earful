import { useEffect, useState } from 'react'
import type { EngineId } from '../../lib/settings'
import type { VoiceInfo } from '../../lib/tts/types'
import { getEngine } from '../../lib/tts/registry'

/** Voices for an engine. Re-lists when the browser's voice list changes (Web Speech loads voices lazily). */
export function useVoices(engineId: EngineId | null): { voices: VoiceInfo[]; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ id: EngineId | null; voices: VoiceInfo[]; loading: boolean; error: string | null }>({
    id: null,
    voices: [],
    loading: true,
    error: null,
  })

  useEffect(() => {
    if (!engineId) return
    let cancelled = false
    const load = () => {
      getEngine(engineId)
        .listVoices()
        .then((voices) => {
          if (!cancelled) setState({ id: engineId, voices, loading: false, error: null })
        })
        .catch((e: unknown) => {
          if (!cancelled) setState({ id: engineId, voices: [], loading: false, error: e instanceof Error ? e.message : 'Voices could not be loaded.' })
        })
    }
    setState((s) => (s.id === engineId ? s : { id: engineId, voices: [], loading: true, error: null }))
    load()
    const synth = engineId === 'browser' && typeof window !== 'undefined' ? window.speechSynthesis : undefined
    synth?.addEventListener('voiceschanged', load)
    return () => {
      cancelled = true
      synth?.removeEventListener('voiceschanged', load)
    }
  }, [engineId])

  if (state.id !== engineId) return { voices: [], loading: true, error: null }
  return state
}

/** Display name of the selected voice for an engine (falls back to a friendly label). */
export function useVoiceName(engineId: EngineId, voiceId: string | undefined): string {
  const { voices } = useVoices(engineId)
  if (!voiceId) return engineId === 'browser' ? 'Default voice' : 'Choose a voice'
  const v = voices.find((x) => x.id === voiceId)
  if (v) return v.name
  // Web Speech voice ids are voiceURIs, which can be long; keep the tail.
  return voiceId.length > 24 ? voiceId.split(/[/#]/).pop() || voiceId : voiceId
}
