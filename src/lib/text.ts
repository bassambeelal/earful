import type { Block } from '../types'

/** A word inside a sentence. Offsets are relative to Sentence.text. */
export interface WordSpan {
  start: number
  end: number
}

/**
 * The unit of playback and highlighting. Offsets `start`/`end` point into
 * blocks[block].text; `text` is exactly blocks[block].text.slice(start, end).
 */
export interface Sentence {
  index: number
  block: number
  start: number
  end: number
  text: string
  words: WordSpan[]
}

/** Sentences longer than this are split at clause boundaries so every TTS engine can take them. */
export const MAX_SENTENCE_CHARS = 320

const ABBREVIATIONS = new Set(
  [
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'e.g', 'i.e', 'eg', 'ie',
    'fig', 'figs', 'no', 'nos', 'vol', 'vols', 'pp', 'p', 'ch', 'sec', 'eq', 'eqs', 'approx', 'dept',
    'inc', 'ltd', 'co', 'corp', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
    'nov', 'dec', 'u.s', 'u.k', 'a.m', 'p.m', 'al', 'cf', 'ca', 'op', 'ed', 'eds', 'rev', 'gen', 'col',
    'lt', 'sgt', 'capt', 'gov', 'sen', 'rep', 'ave', 'blvd', 'rd',
  ].map((a) => a.toLowerCase()),
)

const segmenterCache = new Map<string, { sentence: Intl.Segmenter | null; word: Intl.Segmenter | null }>()

function segmenters(lang: string) {
  let s = segmenterCache.get(lang)
  if (!s) {
    let sentence: Intl.Segmenter | null = null
    let word: Intl.Segmenter | null = null
    try {
      if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        sentence = new Intl.Segmenter(lang, { granularity: 'sentence' })
        word = new Intl.Segmenter(lang, { granularity: 'word' })
      }
    } catch {
      /* invalid lang tag or unsupported */
    }
    s = { sentence, word }
    segmenterCache.set(lang, s)
  }
  return s
}

/** Returns [start, end) ranges of raw sentence segments in `text`. */
function rawSentenceRanges(text: string, lang: string): Array<[number, number]> {
  const { sentence } = segmenters(lang)
  const out: Array<[number, number]> = []
  if (sentence) {
    for (const seg of sentence.segment(text)) out.push([seg.index, seg.index + seg.segment.length])
    return out
  }
  // Fallback: split after . ! ? (optionally followed by quotes/brackets) and whitespace.
  const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (!m[0]) break
    out.push([m.index, m.index + m[0].length])
  }
  return out.length ? out : [[0, text.length]]
}

function endsWithAbbreviation(segment: string): boolean {
  const m = /([A-Za-z](?:[A-Za-z.]*[A-Za-z])?)\.\s*$/.exec(segment)
  if (!m) return false
  const word = m[1].toLowerCase()
  if (ABBREVIATIONS.has(word)) return true
  // Single capital initial like "J." in "J. R. R. Tolkien"
  return /^[A-Z]$/.test(m[1])
}

/** Merge segments broken after abbreviations/initials and glue tiny fragments to neighbours. */
function mergeRanges(text: string, ranges: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = []
  for (const r of ranges) {
    const prev = merged[merged.length - 1]
    if (prev) {
      const prevText = text.slice(prev[0], prev[1])
      const curText = text.slice(r[0], r[1]).trim()
      const startsLower = /^[a-z0-9(]/.test(curText)
      if (endsWithAbbreviation(prevText) || curText.length < 3 || (startsLower && !/[.!?…]["'”’)\]]*\s*$/.test(prevText))) {
        prev[1] = r[1]
        continue
      }
      if (startsLower && endsWithAbbreviation(prevText + ' ')) {
        prev[1] = r[1]
        continue
      }
    }
    merged.push([r[0], r[1]])
  }
  return merged
}

/** Split a too-long range at the best clause boundary, recursively. */
function splitLong(text: string, [s, e]: [number, number], out: Array<[number, number]>) {
  if (e - s <= MAX_SENTENCE_CHARS) {
    out.push([s, e])
    return
  }
  const slice = text.slice(s, e)
  const target = Math.min(MAX_SENTENCE_CHARS, Math.floor(slice.length / 2) + 40)
  const patterns = [/[;:]\s+/g, /[,—–]\s+/g, /\s+(?:and|but|or|which|because|while|although|so)\s+/g, /\s+/g]
  let cut = -1
  for (const re of patterns) {
    let best = -1
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(slice))) {
      const pos = m.index + m[0].length
      if (pos > 40 && pos <= target + 60 && pos < slice.length - 20) best = pos
      if (pos > target + 60) break
    }
    if (best > 0) {
      cut = best
      break
    }
  }
  if (cut <= 0) cut = Math.min(slice.length, MAX_SENTENCE_CHARS)
  splitLong(text, [s, s + cut], out)
  splitLong(text, [s + cut, e], out)
}

/** Word spans of `text` (relative offsets). Numbers and word-like tokens count as words. */
export function wordSpans(text: string, lang = 'en'): WordSpan[] {
  const { word } = segmenters(lang)
  const out: WordSpan[] = []
  if (word) {
    for (const seg of word.segment(text)) {
      if (seg.isWordLike || /[\p{L}\p{N}]/u.test(seg.segment)) out.push({ start: seg.index, end: seg.index + seg.segment.length })
    }
    return out
  }
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’\-.]*/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length })
  return out
}

/** Split blocks into playable sentences. Deterministic: same input -> same indices. */
export function segmentBlocks(blocks: Block[], lang = 'en'): Sentence[] {
  const sentences: Sentence[] = []
  blocks.forEach((block, bi) => {
    const text = block.text
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return
    const ranges: Array<[number, number]> = []
    for (const r of mergeRanges(text, rawSentenceRanges(text, lang))) splitLong(text, r, ranges)
    for (let [s, e] of ranges) {
      // Trim whitespace so highlights hug the text.
      while (s < e && /\s/.test(text[s])) s++
      while (e > s && /\s/.test(text[e - 1])) e--
      if (e <= s) continue
      const t = text.slice(s, e)
      if (!/[\p{L}\p{N}]/u.test(t)) {
        // Pure punctuation: attach to previous sentence in the same block if any.
        const prev = sentences[sentences.length - 1]
        if (prev && prev.block === bi) {
          prev.end = e
          prev.text = text.slice(prev.start, e)
          prev.words = wordSpans(prev.text, lang)
        }
        continue
      }
      sentences.push({ index: sentences.length, block: bi, start: s, end: e, text: t, words: wordSpans(t, lang) })
    }
  })
  return sentences
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)
  return m ? m.length : 0
}

// ---------------------------------------------------------------------------
// Spoken text: what we actually send to a TTS engine, with a map back to display offsets.
// ---------------------------------------------------------------------------

export interface SpeakFilters {
  /** Skip [12], [3-5], (Smith, 2020), (Smith et al., 2019; Doe 2021) and superscript footnote marks. */
  skipCitations: boolean
  /** Skip http(s)://... and www.... */
  skipUrls: boolean
  /** Skip everything inside (parentheses). */
  skipParentheticals: boolean
}

export interface SpokenText {
  /** Text to synthesize. May be empty (sentence should then be skipped). */
  text: string
  /** map[i] = offset in Sentence.text of spoken char i. Length is text.length + 1 (last entry = end). */
  map: number[]
}

const CITATION_RES = [
  /\s?\[\d+(?:\s*[,–\-]\s*\d+)*\]/g,
  /\s?\((?:see\s+)?[A-Z][\p{L}'’\-]+(?:\s+(?:et\s+al\.?|and|&)\s*(?:[A-Z][\p{L}'’\-]+)?)?,?\s+\d{4}[a-z]?(?:\s*[;,]\s*[A-Z][\p{L}'’\-]+(?:\s+(?:et\s+al\.?|and|&)\s*(?:[A-Z][\p{L}'’\-]+)?)?,?\s+\d{4}[a-z]?)*(?:,\s*p+\.\s*\d+(?:[–\-]\d+)?)?\)/gu,
  /[¹²³⁴⁵⁶⁷⁸⁹⁰]+/g,
]
const URL_RE = /\s?(?:https?:\/\/|www\.)[^\s)\]]+/g
const PAREN_RE = /\s?\([^()]*\)/g

/** Build the spoken form of a sentence, removing filtered spans and keeping an offset map. */
export function toSpoken(sentence: Sentence, filters: SpeakFilters): SpokenText {
  const src = sentence.text
  const remove: Array<[number, number]> = []
  const collect = (re: RegExp) => {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      remove.push([m.index, m.index + m[0].length])
    }
  }
  if (filters.skipUrls) collect(URL_RE)
  if (filters.skipCitations) CITATION_RES.forEach(collect)
  if (filters.skipParentheticals) collect(PAREN_RE)

  const removed = new Uint8Array(src.length)
  for (const [s, e] of remove) removed.fill(1, s, e)

  let text = ''
  const map: number[] = []
  let lastWasSpace = true
  for (let i = 0; i < src.length; i++) {
    if (removed[i]) continue
    const ch = src[i]
    const isSpace = /\s/.test(ch)
    if (isSpace) {
      if (lastWasSpace) continue
      text += ' '
      map.push(i)
      lastWasSpace = true
    } else {
      text += ch
      map.push(i)
      lastWasSpace = false
    }
  }
  // Trim trailing space.
  while (text.endsWith(' ')) {
    text = text.slice(0, -1)
    map.pop()
  }
  map.push(src.length)
  if (!/[\p{L}\p{N}]/u.test(text)) return { text: '', map: [src.length] }
  return { text, map }
}

/** Map a [start,end) range in spoken text back to display offsets in Sentence.text. */
export function spokenToDisplay(spoken: SpokenText, start: number, end: number): WordSpan {
  const clamp = (n: number) => Math.max(0, Math.min(spoken.map.length - 1, n))
  const s = spoken.map[clamp(start)]
  const eIdx = clamp(end - 1)
  const e = end > start ? spoken.map[eIdx] + 1 : s
  return { start: s, end: Math.max(s, e) }
}

/** Find the word in `sentence` that contains (or follows) display offset `offset`. */
export function wordAt(sentence: Sentence, offset: number): WordSpan | null {
  for (const w of sentence.words) if (offset < w.end) return w
  return sentence.words[sentence.words.length - 1] ?? null
}

/** Stable short id. */
export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Normalise whitespace inside a text run (used by importers). */
export function cleanText(s: string): string {
  return s
    .replace(/­/g, '') // soft hyphen
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Rough reading time in seconds at `rate`x for `words` words (≈160 wpm at 1x). */
export function estimateSeconds(words: number, rate = 1): number {
  return (words / 160) * 60 / Math.max(0.25, rate)
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '–'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m} min`
  return `${s}s`
}
