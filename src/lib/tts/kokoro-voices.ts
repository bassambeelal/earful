import type { VoiceInfo } from './types'

// Kokoro-82M v1.0 English voices with the upstream model card's overall grade.
// Shared by the on-device engine and by "Your own server" (Kokoro-FastAPI).

type Row = [id: string, name: string, grade: string]

const ROWS: Row[] = [
  ['af_heart', 'Heart', 'A'],
  ['af_bella', 'Bella', 'A-'],
  ['af_nicole', 'Nicole', 'B-'],
  ['af_aoede', 'Aoede', 'C+'],
  ['af_kore', 'Kore', 'C+'],
  ['af_sarah', 'Sarah', 'C+'],
  ['af_alloy', 'Alloy', 'C'],
  ['af_nova', 'Nova', 'C'],
  ['af_sky', 'Sky', 'C-'],
  ['af_jessica', 'Jessica', 'D'],
  ['af_river', 'River', 'D'],
  ['am_fenrir', 'Fenrir', 'C+'],
  ['am_michael', 'Michael', 'C+'],
  ['am_puck', 'Puck', 'C+'],
  ['am_echo', 'Echo', 'D'],
  ['am_eric', 'Eric', 'D'],
  ['am_liam', 'Liam', 'D'],
  ['am_onyx', 'Onyx', 'D'],
  ['am_santa', 'Santa', 'D-'],
  ['am_adam', 'Adam', 'F+'],
  ['bf_emma', 'Emma', 'B-'],
  ['bf_isabella', 'Isabella', 'C'],
  ['bf_alice', 'Alice', 'D'],
  ['bf_lily', 'Lily', 'D'],
  ['bm_fable', 'Fable', 'C'],
  ['bm_george', 'George', 'C'],
  ['bm_lewis', 'Lewis', 'D+'],
  ['bm_daniel', 'Daniel', 'D'],
]

const RECOMMENDED = new Set(['af_heart', 'af_bella'])

export const KOKORO_DEFAULT_VOICE = 'af_heart'

export const KOKORO_VOICES: VoiceInfo[] = ROWS.map(([id, name, grade]) => {
  const british = id[0] === 'b'
  return {
    id,
    name,
    lang: british ? 'en-GB' : 'en-US',
    gender: id[1] === 'f' ? 'female' : 'male',
    description: `${british ? 'British' : 'American'} · Grade ${grade}`,
    recommended: RECOMMENDED.has(id),
  }
})

export const KOKORO_VOICE_IDS = new Set(ROWS.map((r) => r[0]))
