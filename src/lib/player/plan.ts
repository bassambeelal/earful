// Turns sentences into what actually gets spoken: filtered spoken text, skipped
// sentences, and (for audio-producing engines) chunks of several sentences.
// Shared by the live player and the audio exporter so both speak identical text.
import type { Block } from '../../types'
import { useLibrary } from '../library'
import { toSpoken, wordAt, type Sentence, type SpeakFilters, type SpokenText, type WordSpan } from '../text'

export interface Plan {
  sentences: Sentence[]
  filters: SpeakFilters
  /** Sentences never spoken whatever their text (headings when "read headings" is off). */
  skip: (index: number) => boolean
  /** Memoised spoken text per sentence index. */
  cache: Map<number, SpokenText>
}

export function makePlan(sentences: Sentence[], filters: SpeakFilters, skip: (index: number) => boolean = () => false): Plan {
  return { sentences, filters, skip, cache: new Map() }
}

/**
 * Blocks behind `sentences`, taken from the library's open document when it matches
 * (by id when given, otherwise by the identity of the sentences array).
 */
export function blocksFor(sentences: Sentence[], docId?: string): Block[] | null {
  const open = useLibrary.getState().open
  if (!open) return null
  const match = docId ? open.meta.id === docId : open.sentences === sentences
  return match ? open.content.blocks : null
}

/** A skip predicate for heading sentences when headings shouldn't be read. */
export function headingSkip(blocks: Block[] | null, sentences: Sentence[], readHeadings: boolean): (index: number) => boolean {
  if (readHeadings || !blocks) return () => false
  return (i) => blocks[sentences[i]?.block]?.type === 'heading'
}

export function spokenOf(plan: Plan, i: number): SpokenText {
  let s = plan.cache.get(i)
  if (!s) {
    const sentence = plan.sentences[i]
    s = !sentence || plan.skip(i) ? { text: '', map: [sentence?.text.length ?? 0] } : toSpoken(sentence, plan.filters)
    plan.cache.set(i, s)
  }
  return s
}

export function isPlayable(plan: Plan, i: number): boolean {
  return spokenOf(plan, i).text.length > 0
}

/** First playable sentence in [from, last], or -1. */
export function nextPlayable(plan: Plan, from: number, last = plan.sentences.length - 1): number {
  const end = Math.min(last, plan.sentences.length - 1)
  for (let i = Math.max(0, from); i <= end; i++) if (isPlayable(plan, i)) return i
  return -1
}

/** Last playable sentence at or before `from`, or -1. */
export function prevPlayable(plan: Plan, from: number): number {
  for (let i = Math.min(from, plan.sentences.length - 1); i >= 0; i--) if (isPlayable(plan, i)) return i
  return -1
}

/**
 * Spoken text starting at the word that contains display offset `wordOffset`.
 * Returns the whole sentence when there is no offset or it can't be honoured.
 * The returned map still points into Sentence.text, so spokenToDisplay() works unchanged.
 */
export function spokenFrom(sentence: Sentence, spoken: SpokenText, wordOffset?: number): SpokenText {
  if (wordOffset == null || !(wordOffset > 0) || !spoken.text) return spoken
  const word = wordAt(sentence, wordOffset)
  if (!word) return spoken
  let k = 0
  while (k < spoken.text.length && spoken.map[k] < word.start) k++
  while (k < spoken.text.length && spoken.text[k] === ' ') k++
  if (k === 0 || k >= spoken.text.length) return spoken
  const text = spoken.text.slice(k)
  if (!/[\p{L}\p{N}]/u.test(text)) return spoken
  return { text, map: spoken.map.slice(k) }
}

/** The first word actually spoken from `spoken`. */
export function firstSpokenWord(sentence: Sentence, spoken: SpokenText): WordSpan | null {
  return wordAt(sentence, spoken.map[0] ?? 0)
}

export interface ChunkPart {
  sentence: number
  spoken: SpokenText
  /** Start of this sentence's spoken text inside Chunk.text. */
  offset: number
}

export interface Chunk {
  parts: ChunkPart[]
  /** Exactly what is sent to the engine (parts joined by single spaces). */
  text: string
  /** The next spoken sentence is in another block (or there is none): a paragraph pause follows. */
  blockEnd: boolean
}

export interface ChunkOptions {
  maxChars: number
  /** Only this one sentence (fast start after play/seek). */
  single?: boolean
  /** Start the first sentence at this display offset. */
  wordOffset?: number
  /** Don't go past this sentence index. */
  last?: number
}

/**
 * Build the chunk starting at playable sentence `from`: consecutive playable sentences
 * of the same block, up to maxChars. Returns the chunk and the next playable index (-1 at the end).
 */
export function planChunk(plan: Plan, from: number, opts: ChunkOptions): { chunk: Chunk; next: number } {
  const last = opts.last ?? plan.sentences.length - 1
  const first = plan.sentences[from]
  const spoken = spokenFrom(first, spokenOf(plan, from), opts.wordOffset)
  const parts: ChunkPart[] = [{ sentence: from, spoken, offset: 0 }]
  let text = spoken.text
  let next = nextPlayable(plan, from + 1, last)
  while (!opts.single && next >= 0 && plan.sentences[next].block === first.block) {
    const sp = spokenOf(plan, next)
    if (text.length + 1 + sp.text.length > opts.maxChars) break
    parts.push({ sentence: next, spoken: sp, offset: text.length + 1 })
    text += ' ' + sp.text
    next = nextPlayable(plan, next + 1, last)
  }
  const blockEnd = next < 0 || plan.sentences[next].block !== first.block
  return { chunk: { parts, text, blockEnd }, next }
}
