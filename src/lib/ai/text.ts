// Text helpers for the AI tools: scopes, chunking, Markdown <-> blocks.
import type { Block, Chapter } from '../../types'
import type { OpenDoc } from '../library'
import { cleanText } from '../text'

export type AiScope = 'chapter' | 'document' | 'paragraph' | 'selection'

export interface ScopedText {
  scope: AiScope
  /** Human label, e.g. "Chapter 3: The Sea" or "Whole document". */
  label: string
  /** Chapter title when scope is 'chapter' and the doc has chapters. */
  chapterTitle?: string
  blocks: Block[]
  /** Blocks as lightly marked-up text (# headings, - lists, > quotes). */
  text: string
}

/** The chapter containing a sentence, as a block range [start, end). Null if the doc has no chapters. */
export function chapterAt(doc: OpenDoc, sentence: number): { title: string; start: number; end: number } | null {
  const chapters = [...doc.content.chapters].sort((a, b) => a.block - b.block)
  if (!chapters.length) return null
  const block = doc.sentences[Math.max(0, Math.min(sentence, doc.sentences.length - 1))]?.block ?? 0
  let idx = -1
  for (let i = 0; i < chapters.length; i++) if (chapters[i].block <= block) idx = i
  if (idx < 0) return { title: 'Opening pages', start: 0, end: chapters[0].block }
  const start = chapters[idx].block
  const next = chapters.slice(idx + 1).find((c) => c.block > start)
  return { title: chapters[idx].title, start, end: next ? next.block : doc.content.blocks.length }
}

export function selectionToBlocks(selection: string): Block[] {
  return selection
    .split(/\n\s*\n|\r?\n/)
    .map((p) => cleanText(p))
    .filter(Boolean)
    .map((text) => ({ type: 'paragraph' as const, text }))
}

export function blocksToText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
          return `${'#'.repeat(Math.min(6, Math.max(1, b.level ?? 2)))} ${b.text}`
        case 'list-item':
          return `- ${b.text}`
        case 'quote':
          return `> ${b.text}`
        case 'code':
          return '```\n' + b.text + '\n```'
        default:
          return b.text
      }
    })
    .join('\n\n')
}

/** Text for a scope. Falls back sensibly (no chapters -> whole doc, no selection -> paragraph). */
export function scopedText(doc: OpenDoc, scope: AiScope, currentSentence: number, selection?: string | null): ScopedText {
  const blocks = doc.content.blocks
  if (scope === 'selection' && selection?.trim()) {
    const sel = selectionToBlocks(selection)
    return { scope, label: 'Selected text', blocks: sel, text: blocksToText(sel) }
  }
  if (scope === 'chapter') {
    const ch = chapterAt(doc, currentSentence)
    if (ch && ch.end > ch.start && !(ch.start === 0 && ch.end >= blocks.length)) {
      const part = blocks.slice(ch.start, ch.end)
      return { scope, label: ch.title, chapterTitle: ch.title, blocks: part, text: blocksToText(part) }
    }
  }
  if (scope === 'paragraph' || scope === 'selection') {
    const b = doc.sentences[currentSentence]?.block ?? 0
    const part = blocks.slice(b, b + 1)
    return { scope: 'paragraph', label: 'Current paragraph', blocks: part, text: blocksToText(part) }
  }
  return { scope: 'document', label: 'Whole document', blocks, text: blocksToText(blocks) }
}

/** Plain text around a sentence (for Explain / Chat grounding). */
export function contextAround(doc: OpenDoc, sentence: number, chars: number): string {
  const s = doc.sentences
  if (!s.length) return ''
  const i = Math.max(0, Math.min(sentence, s.length - 1))
  let lo = i
  let hi = i
  let len = s[i].text.length
  while (len < chars && (lo > 0 || hi < s.length - 1)) {
    if (lo > 0) len += s[--lo].text.length + 1
    if (hi < s.length - 1 && len < chars) len += s[++hi].text.length + 1
  }
  let out = ''
  let block = -1
  for (let k = lo; k <= hi; k++) {
    out += block === -1 ? s[k].text : block !== s[k].block ? `\n\n${s[k].text}` : ` ${s[k].text}`
    block = s[k].block
  }
  return out
}

/** Split a long string at sentence (then word) boundaries into pieces of at most `size`. */
function splitLong(text: string, size: number): string[] {
  if (text.length <= size) return [text]
  const out: string[] = []
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*["'”’)\]]*\s*/g) ?? [text]
  let cur = ''
  for (const s of sentences) {
    if (s.length > size) {
      if (cur) out.push(cur.trim())
      cur = ''
      for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size).trim())
      continue
    }
    if (cur.length + s.length > size && cur) {
      out.push(cur.trim())
      cur = ''
    }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

/** Chunk text at paragraph boundaries into pieces of about `size` characters. */
export function chunkText(text: string, size: number): string[] {
  const paras = text.split(/\n\s*\n/).flatMap((p) => splitLong(p.trim(), size)).filter(Boolean)
  const chunks: string[] = []
  let cur = ''
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > size) {
      chunks.push(cur)
      cur = ''
    }
    cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur) chunks.push(cur)
  return chunks
}

/** Group blocks into chunks of about `size` characters, splitting giant blocks. */
export function chunkBlocks(blocks: Block[], size: number): Block[][] {
  const chunks: Block[][] = []
  let cur: Block[] = []
  let len = 0
  const push = (b: Block) => {
    if (cur.length && len + b.text.length > size) {
      chunks.push(cur)
      cur = []
      len = 0
    }
    cur.push(b)
    len += b.text.length + 2
  }
  for (const b of blocks) {
    if (b.text.length > size && b.type !== 'heading') {
      for (const piece of splitLong(b.text, size)) push({ ...b, text: piece })
    } else push(b)
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

/** Evenly sample chunks of a long text so the result fits `budget` characters. */
export function sampleText(text: string, budget: number): string {
  if (text.length <= budget) return text
  const pieceSize = Math.max(1000, Math.floor(budget / 8))
  const pieces = chunkText(text, pieceSize)
  const take = Math.max(1, Math.floor(budget / (pieceSize + 10)))
  if (take >= pieces.length) return pieces.join('\n\n').slice(0, budget)
  const out: string[] = []
  for (let i = 0; i < take; i++) out.push(pieces[Math.floor((i * pieces.length) / take)])
  return out.join('\n\n[…]\n\n').slice(0, budget)
}

/** Remove inline Markdown so AI output can be stored as plain block text. */
export function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
}

/** Parse Markdown-ish AI output back into blocks. */
export function markdownToBlocks(md: string): Block[] {
  let text = md.replace(/\r\n?/g, '\n').trim()
  // Unwrap an answer that was entirely fenced as markdown/text.
  const whole = /^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i.exec(text)
  if (whole) text = whole[1]
  const blocks: Block[] = []
  const lines = text.split('\n')
  let para: string[] = []
  const flushPara = () => {
    const t = cleanText(stripInlineMarkdown(para.join(' ')))
    if (t) blocks.push({ type: 'paragraph', text: t })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*```/.exec(line)
    if (fence) {
      flushPara()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      const t = code.join('\n').trim()
      if (t) blocks.push({ type: 'code', text: t })
      continue
    }
    const trimmed = line.trim()
    if (!trimmed) {
      flushPara()
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara()
      continue
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed)
    if (h) {
      flushPara()
      const t = cleanText(stripInlineMarkdown(h[2]))
      if (t) blocks.push({ type: 'heading', level: h[1].length, text: t })
      continue
    }
    const li = /^(?:[-*•+]|\d{1,3}[.)])\s+(.*)$/.exec(trimmed)
    if (li) {
      flushPara()
      const t = cleanText(stripInlineMarkdown(li[1]))
      if (t) blocks.push({ type: 'list-item', text: t })
      continue
    }
    const q = /^>\s?(.*)$/.exec(trimmed)
    if (q) {
      flushPara()
      const t = cleanText(stripInlineMarkdown(q[1]))
      const prev = blocks[blocks.length - 1]
      // Consecutive quote lines form one quote.
      if (t && prev?.type === 'quote' && i > 0 && /^>\s?/.test(lines[i - 1].trim())) prev.text = `${prev.text} ${t}`
      else if (t) blocks.push({ type: 'quote', text: t })
      continue
    }
    para.push(trimmed)
  }
  flushPara()
  return blocks
}

/** Chapters for a generated document: one per top-level heading. */
export function chaptersFromBlocks(blocks: Block[]): Chapter[] {
  const heads = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.type === 'heading')
  if (!heads.length) return []
  const top = Math.min(...heads.map((h) => h.b.level ?? 1))
  return heads.filter((h) => (h.b.level ?? 1) <= top + 1).map((h) => ({ title: h.b.text, block: h.i }))
}

/** Markdown -> plain text suitable for text-to-speech. Paragraphs are separated by blank lines. */
export function markdownToSpeech(md: string): string {
  const out: string[] = []
  let para: string[] = []
  // End headings, list items and paragraphs with a stop so they don't run together.
  const end = (t: string) => (t && !/[.!?:;…]["'”’)\]]*$/.test(t) ? `${t}.` : t)
  const flush = () => {
    const t = para.join(' ').trim()
    if (t) out.push(end(t))
    para = []
  }
  const lines = md
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, '\n\n')
    .split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || /^(-{3,}|\*{3,}|_{3,}|\|?[\s:|-]+\|?)$/.test(line)) {
      flush()
      continue
    }
    if (/^\|.*\|$/.test(line)) {
      // Table row: read the cells as a list.
      flush()
      const cells = line
        .split('|')
        .map((c) => stripInlineMarkdown(c).trim())
        .filter(Boolean)
      if (cells.length) out.push(end(cells.join(', ')))
      continue
    }
    const structural = /^(?:#{1,6}\s|(?:[-*•+]|\d{1,3}[.)])\s)/.test(line)
    const t = stripInlineMarkdown(
      line
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^(?:[-*•+]|\d{1,3}[.)])\s+/, ''),
    ).trim()
    if (structural) {
      flush()
      if (t) out.push(end(t))
    } else if (t) {
      // Soft-wrapped lines of one paragraph are joined back together.
      para.push(t)
    }
  }
  flush()
  return out.join('\n\n')
}
