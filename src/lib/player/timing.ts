// Word timing estimation for engines that don't report word boundaries.
import type { WordTiming } from '../tts/types'

/** Share of the clip before the first word (engines add a little leading silence). */
const LEAD_IN = 0.03

/**
 * Spread `duration` seconds over the words of `text`. Longer words take longer, digits are
 * read out as longer words, and punctuation adds a pause after the word it ends.
 * Char offsets refer to `text`.
 */
export function estimateTimings(text: string, duration: number): WordTiming[] {
  if (!(duration > 0)) return []
  const tokens: Array<{ start: number; end: number; weight: number; pause: number }> = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const tok = m[0]
    const letters = tok.match(/\p{L}/gu)?.length ?? 0
    const digits = tok.match(/\p{N}/gu)?.length ?? 0
    const tail = tok.replace(/["'”’»)\]]+$/u, '').slice(-1)
    const pause = /[.!?…]/.test(tail) ? 6 : /[,;:—–]/.test(tail) ? 2.5 : 0
    const weight = letters + digits ? letters + digits * 2.5 + 1.5 : 0.5
    tokens.push({ start: m.index, end: m.index + tok.length, weight, pause })
  }
  if (!tokens.length) return []
  const total = tokens.reduce((s, t) => s + t.weight + t.pause, 0)
  const lead = duration * LEAD_IN
  const scale = (duration - lead) / total
  const out: WordTiming[] = []
  let t = lead
  for (const tok of tokens) {
    const start = t
    t += tok.weight * scale
    out.push({ start, end: t, charStart: tok.start, charEnd: tok.end })
    t += tok.pause * scale
  }
  return out
}

/**
 * Index of the timing being spoken at time `t` (the last one starting at or before `t`), or -1.
 * `hint` (the previous result) makes sequential lookups O(1).
 */
export function timingIndexAt(timings: WordTiming[], t: number, hint = 0): number {
  if (!timings.length) return -1
  let i = Math.min(Math.max(hint, 0), timings.length - 1)
  if (timings[i].start > t) {
    while (i >= 0 && timings[i].start > t) i--
    return i
  }
  while (i + 1 < timings.length && timings[i + 1].start <= t) i++
  return i
}
