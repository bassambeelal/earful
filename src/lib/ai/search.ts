// Tiny BM25 retriever over document passages, used to pick context for "chat with doc".
import type { Block, DocContent } from '../../types'

export interface Passage {
  /** First and last block index (inclusive). */
  start: number
  end: number
  heading: string
  text: string
  terms: Map<string, number>
  length: number
}

interface PassageIndex {
  passages: Passage[]
  df: Map<string, number>
  avgLength: number
}

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'me my no not of on or our she so than that the their them then there these they this those to was we were what when ' +
    'where which who whom why will with would you your about after all also any because before being between both each ' +
    'more most other over same should some such through under until up very just only own again further once here out off ' +
    'tell explain say says said mean means does document text book chapter please'
  ).split(' '),
)

export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue
    // Light stemming so "planets"/"planet" and "running"/"run" match.
    let t = raw
    if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3)
    else if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y'
    else if (t.length > 4 && t.endsWith('es') && /(sh|ch|x|z|ss)es$/.test(t)) t = t.slice(0, -2)
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1)
    out.push(t)
  }
  return out
}

const cache = new WeakMap<DocContent, PassageIndex>()

const PASSAGE_CHARS = 1500

function blockText(b: Block): string {
  return b.type === 'heading' ? `${'#'.repeat(b.level ?? 2)} ${b.text}` : b.type === 'list-item' ? `- ${b.text}` : b.text
}

export function passageIndex(content: DocContent): PassageIndex {
  const hit = cache.get(content)
  if (hit) return hit
  const passages: Passage[] = []
  const chapterAtBlock = new Map(content.chapters.map((c) => [c.block, c.title]))
  let heading = ''
  let cur: { start: number; parts: string[]; len: number; heading: string } | null = null
  const flush = (end: number) => {
    if (!cur) return
    const text = cur.parts.join('\n\n')
    const terms = new Map<string, number>()
    const toks = tokenize(text)
    for (const t of toks) terms.set(t, (terms.get(t) ?? 0) + 1)
    passages.push({ start: cur.start, end, heading: cur.heading, text, terms, length: toks.length || 1 })
    cur = null
  }
  content.blocks.forEach((b, i) => {
    const chapter = chapterAtBlock.get(i)
    if (chapter || b.type === 'heading') {
      flush(i - 1)
      heading = chapter ?? b.text
    }
    if (cur && cur.len + b.text.length > PASSAGE_CHARS) flush(i - 1)
    if (!cur) cur = { start: i, parts: [], len: 0, heading }
    cur.parts.push(blockText(b))
    cur.len += b.text.length + 2
  })
  flush(content.blocks.length - 1)

  const df = new Map<string, number>()
  let total = 0
  for (const p of passages) {
    total += p.length
    for (const t of p.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const index = { passages, df, avgLength: total / Math.max(1, passages.length) }
  cache.set(content, index)
  return index
}

/** BM25 score for each passage against weighted query terms. */
export function scorePassages(index: PassageIndex, query: Map<string, number>): number[] {
  const k1 = 1.2
  const b = 0.75
  const N = index.passages.length
  return index.passages.map((p) => {
    let score = 0
    for (const [term, weight] of query) {
      const tf = p.terms.get(term)
      if (!tf) continue
      const df = index.df.get(term) ?? 0
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      score += weight * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * p.length) / index.avgLength)))
    }
    return score
  })
}
