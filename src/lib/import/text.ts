import { marked } from 'marked'
import type { Block, ImportedDoc, SourceKind } from '../../types'
import { looksLikeMarkdown } from './detect'
import { BlockWriter, parseSanitized } from './html'
import { endsSentence, finalizeDoc, hasWords, joinLine, meaningfulAuthor, shortTitle } from './util'

// Plain text and Markdown.

const BULLET_RE = /^([-*+•◦▪‣●○■□–]|\d{1,3}[.)]|[a-z][.)])\s+/i
const UNORDERED_RE = /^[-*+•◦▪‣●○■□–]\s+/
const CHAPTER_RE = /^(chapter|part|book|section|prologue|epilogue|preface|introduction|foreword|afterword|appendix|contents|table of contents|act|scene)\b/i

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
}

export function normalizeNewlines(text: string): string {
  return text
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029\f\v]/g, '\n\n')
    .replace(/\t/g, '    ')
}

/** Project Gutenberg texts: keep only the book between the START/END markers, and read its header. */
function stripGutenberg(text: string): { text: string; title?: string; author?: string } {
  const start = /^\*{3}\s*START OF (THE|THIS) PROJECT GUTENBERG E-?BOOK[^\n]*$/im.exec(text)
  if (!start) return { text }
  const header = text.slice(0, start.index)
  const title = /^Title:\s*(.+)$/im.exec(header)?.[1]
  const author = /^Author:\s*(.+)$/im.exec(header)?.[1]
  let body = text.slice(start.index + start[0].length)
  const end = /^\*{3}\s*END OF (THE|THIS) PROJECT GUTENBERG E-?BOOK[^\n]*$/im.exec(body)
  if (end) body = body.slice(0, end.index)
  return { text: body, title, author }
}

function firstWordLength(line: string): number {
  const m = /^\S+/.exec(line.trim())
  return m ? m[0].length : 0
}

/** Turn one blank-line-separated chunk into blocks. `wrap` is the document's typical maximum line length. */
function chunkToBlocks(rawLines: string[], wrap: number): Block[] {
  const lines = rawLines.map((l) => l.replace(/\s+$/, ''))
  const trimmed = lines.map((l) => l.trim())
  const out: Block[] = []

  // Lists: every bullet line starts an item; other lines continue the current item.
  const bulletCount = trimmed.filter((l) => BULLET_RE.test(l)).length
  if (bulletCount >= 2 || (bulletCount === 1 && BULLET_RE.test(trimmed[0]) && UNORDERED_RE.test(trimmed[0]))) {
    for (const l of trimmed) {
      if (BULLET_RE.test(l)) out.push({ type: 'list-item', text: l.replace(UNORDERED_RE, '') })
      else if (out.length && out[out.length - 1].type === 'list-item') out[out.length - 1].text = joinLine(out[out.length - 1].text, l)
      else out.push({ type: 'paragraph', text: l })
    }
    return out
  }

  if (trimmed.length === 1) return [{ type: 'paragraph', text: trimmed[0] }]

  // A break is "intentional" when the next line's first word would have fitted on this line.
  const limit = wrap * 0.95
  const intentional: boolean[] = []
  for (let i = 0; i < trimmed.length - 1; i++) intentional.push(trimmed[i].length + 1 + firstWordLength(trimmed[i + 1]) <= limit)
  const frac = intentional.filter(Boolean).length / intentional.length

  if (frac >= 0.5) {
    // Line-structured (poetry, addresses, one-paragraph-per-line files): keep every line.
    for (const l of trimmed) out.push({ type: 'paragraph', text: l })
    return out
  }

  // Hard-wrapped prose: join lines, but start a new paragraph after a short line that ends a
  // sentence, or before an indented line that follows a finished sentence.
  // A loop, not Math.min(...spread): huge chunks exceed Safari's 65,536-argument limit.
  let baseIndent = Infinity
  for (const l of lines) baseIndent = Math.min(baseIndent, /^\s*/.exec(l)![0].length)
  let cur = trimmed[0]
  for (let i = 1; i < trimmed.length; i++) {
    const prev = trimmed[i - 1]
    const indented = /^\s*/.exec(lines[i])![0].length >= baseIndent + 2
    const brk = endsSentence(prev) && (intentional[i - 1] || indented)
    if (brk) {
      out.push({ type: 'paragraph', text: cur })
      cur = trimmed[i]
    } else {
      cur = joinLine(cur, trimmed[i])
    }
  }
  out.push({ type: 'paragraph', text: cur })
  return out
}

/** Promote obvious headings in plain text: a leading title line, "Chapter 3", SHORT ALL-CAPS LINES. */
function promoteHeadings(blocks: Block[], singleLine: boolean[]): void {
  blocks.forEach((b, i) => {
    if (b.type !== 'paragraph' || !singleLine[i]) return
    const t = b.text.trim()
    if (t.length > 80 || (/[.,;:!?]["'”’)]*$/.test(t) && !CHAPTER_RE.test(t))) return
    const letters = t.replace(/[^\p{L}]/gu, '')
    const allCaps = letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()
    if (CHAPTER_RE.test(t) && t.length <= 60) {
      b.type = 'heading'
      b.level = 2
    } else if (allCaps && t.length <= 60) {
      b.type = 'heading'
      b.level = 3
    } else if (i === 0 && blocks.length > 2 && t.length <= 80 && /\p{L}/u.test(t)) {
      b.type = 'heading'
      b.level = 1
    }
  })
}

export function plainTextToBlocks(input: string): Block[] {
  const text = normalizeNewlines(input)
  const chunks = text.split(/\n[ \u00a0]*\n+/)
  const lens = chunks
    .flatMap((c) => c.split('\n'))
    .map((l) => l.trim().length)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)
  const wrap = Math.max(30, percentile(lens, 0.95))
  const blocks: Block[] = []
  const singleLine: boolean[] = []
  for (const chunk of chunks) {
    const rawLines = chunk.split('\n').filter((l) => l.trim())
    if (!rawLines.length) continue
    const made = chunkToBlocks(rawLines, wrap)
    for (const b of made) {
      blocks.push(b)
      singleLine.push(rawLines.length === 1)
    }
  }
  promoteHeadings(blocks, singleLine)
  return blocks
}

/** YAML front matter: returns the body and a few well-known fields. */
function stripFrontMatter(md: string): { body: string; title?: string; author?: string } {
  const m = /^---\n([\s\S]*?)\n(---|\.\.\.)\n/.exec(md)
  if (!m) return { body: md }
  const field = (name: string) => {
    const v = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(m[1])?.[1]?.trim()
    return v ? v.replace(/^["']|["']$/g, '') : undefined
  }
  return { body: md.slice(m[0].length), title: field('title'), author: field('author') }
}

export function markdownToBlocks(md: string): { blocks: Block[]; title?: string; author?: string } {
  const { body, title, author } = stripFrontMatter(normalizeNewlines(md))
  const html = marked.parse(body, { async: false, gfm: true })
  const doc = parseSanitized(html)
  const w = new BlockWriter('book')
  if (doc.body) w.write(doc.body)
  return { blocks: w.blocks, title, author }
}

/** First line of pasted text, shortened, as a title of last resort. */
function firstLineTitle(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').trim())
    .find((l) => hasWords(l))
  return line ? shortTitle(line, 80) : ''
}

export interface TextImportOptions {
  title?: string
  fileName?: string
  source?: SourceKind
  /** Force a format instead of auto-detecting. */
  format?: 'text' | 'markdown'
}

export function importTextString(input: string, opts: TextImportOptions = {}): ImportedDoc {
  const guten = stripGutenberg(normalizeNewlines(input))
  const text = guten.text
  const isMarkdown = opts.format === 'markdown' || (opts.format !== 'text' && looksLikeMarkdown(text))
  const fallbackTitle = opts.fileName ? undefined : firstLineTitle(text)
  if (isMarkdown) {
    const md = markdownToBlocks(text)
    return finalizeDoc({
      source: opts.source ?? 'markdown',
      blocks: md.blocks,
      titles: [opts.title, md.title, guten.title],
      fallbackTitle,
      fileName: opts.fileName,
      author: meaningfulAuthor(md.author ?? guten.author),
    })
  }
  return finalizeDoc({
    source: opts.source ?? 'text',
    blocks: plainTextToBlocks(text),
    titles: [opts.title, guten.title],
    fallbackTitle,
    fileName: opts.fileName,
    author: meaningfulAuthor(guten.author),
  })
}
