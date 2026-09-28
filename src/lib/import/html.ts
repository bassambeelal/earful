import { Readability } from '@mozilla/readability'
import DOMPurify from 'dompurify'
import type { Block, BlockType, Chapter, ImportedDoc, SourceKind } from '../../types'
import { looksLikeFullPage } from './detect'
import { chaptersFromHeadings, finalizeDoc, hasWords, meaningfulAuthor, tidy, titleFromFileName } from './util'

// DOM -> Block[] conversion shared by the HTML, EPUB, DOCX and Markdown importers.

/**
 * 'page': web content — navigation, asides, forms and page-level header/footer are dropped.
 * 'book': EPUB/DOCX/Markdown — only navigation, footnote asides and page-break markers are dropped.
 */
export type HtmlMode = 'page' | 'book'

interface Ctx {
  type: BlockType
  level?: number
  inArticle: boolean
  /** Counter for the nearest enclosing <ol>. */
  ol?: { n: number; style: string }
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const CDATA_NODE = 4

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio',
  'img', 'picture', 'source', 'track', 'map', 'area', 'button', 'input', 'select', 'option', 'optgroup',
  'textarea', 'datalist', 'meter', 'progress', 'head', 'title', 'meta', 'link', 'base', 'rt', 'rp', 'nav',
])

const PAGE_SKIP_TAGS = new Set(['aside', 'form', 'dialog', 'menu'])
const PAGE_SKIP_ROLES = /\b(navigation|banner|contentinfo|complementary|search|menu|menubar|toolbar|dialog|alert)\b/

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'body', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'html', 'legend', 'main', 'menu', 'ol', 'section',
  'summary', 'ul', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'frameset', 'noframes',
])

/** Elements whose presence inside a table cell means the table is used for layout, not data. */
const LAYOUT_CELL_CONTENT = 'p, div, h1, h2, h3, h4, h5, h6, ul, ol, blockquote, pre, table, article, section'

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
}

function toRoman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ]
  let out = ''
  for (const [v, s] of table) {
    while (n >= v) {
      out += s
      n -= v
    }
  }
  return out
}

function toLetters(n: number): string {
  let s = ''
  while (n > 0) {
    n--
    s = String.fromCharCode(97 + (n % 26)) + s
    n = Math.floor(n / 26)
  }
  return s
}

function listMarker(n: number, style: string): string {
  switch (style) {
    case 'a': return toLetters(n)
    case 'A': return toLetters(n).toUpperCase()
    case 'i': return toRoman(n)
    case 'I': return toRoman(n).toUpperCase()
    default: return String(n)
  }
}

function semanticTypes(el: Element): string {
  const epub = el.getAttribute('epub:type') || el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || ''
  return (epub + ' ' + (el.getAttribute('role') || '')).toLowerCase()
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
  const style = el.getAttribute('style')
  return !!style && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)
}

function prevSignificantSibling(node: Node): Node | null {
  let p = node.previousSibling
  while (p && ((p.nodeType === TEXT_NODE && !/\S/.test(p.nodeValue || '')) || p.nodeType === 8)) p = p.previousSibling
  return p
}

function tagOf(el: Element): string {
  return el.localName.toLowerCase()
}

/**
 * Accumulates blocks from one or more DOM roots (EPUB spine items are written one after another)
 * and records the block index of every element id so links/TOC entries can be resolved.
 */
export class BlockWriter {
  readonly blocks: Block[] = []
  readonly ids = new Map<string, number>()
  private readonly mode: HtmlMode
  private buf = ''
  private bufCtx: Ctx | null = null
  private prefix = ''
  private idPrefix = ''

  constructor(mode: HtmlMode) {
    this.mode = mode
  }

  /** Walk `root`. Element ids are recorded as `${idPrefix}${id}`. */
  write(root: Node, opts: { idPrefix?: string; inArticle?: boolean } = {}): void {
    this.idPrefix = opts.idPrefix ?? ''
    this.visit(root, { type: 'paragraph', inArticle: !!opts.inArticle })
    this.flush()
  }

  private flush(): void {
    const ctx = this.bufCtx
    let text = tidy(this.buf)
    this.buf = ''
    this.bufCtx = null
    if (!text || !ctx) return
    if (!hasWords(text)) {
      // Keep punctuation-only fragments out of the document, but don't lose a pending list number.
      return
    }
    if (this.prefix) {
      if (!/^(\d{1,4}|[a-z]{1,3}|[ivxlcdm]{1,6})[.)]\s/i.test(text)) text = this.prefix + text
      this.prefix = ''
    }
    let type = ctx.type
    if (type === 'heading' && text.length > 200) type = 'paragraph'
    const block: Block = { type, text }
    if (type === 'heading') block.level = ctx.level ?? 2
    this.blocks.push(block)
  }

  private append(text: string, ctx: Ctx): void {
    if (!text) return
    if (!this.bufCtx) this.bufCtx = ctx
    this.buf += text
  }

  private recordId(el: Element): void {
    const id = el.getAttribute('id') || (tagOf(el) === 'a' ? el.getAttribute('name') : null)
    if (!id) return
    const key = this.idPrefix + id
    if (!this.ids.has(key)) this.ids.set(key, this.blocks.length)
  }

  private shouldSkip(el: Element, tag: string, ctx: Ctx): boolean {
    if (SKIP_TAGS.has(tag)) return true
    if (isHidden(el)) return true
    const types = semanticTypes(el)
    if (types.trim()) {
      if (/\b(doc-)?(pagebreak|noteref|backlink)\b/.test(types)) return true
      if (/\b(doc-)?(toc|landmarks|page-list|loi|lot)\b/.test(types)) return true
      if (/\b(doc-)?(footnote|endnote|rearnote|note)\b/.test(types) && (tag === 'aside' || /\bdoc-(footnote|endnote)\b/.test(types))) return true
    }
    if (tag === 'a') {
      const t = (el.textContent || '').trim()
      if (t && /^[↑↩⤴^\s︎️]+$/.test(t)) return true
    }
    if (this.mode === 'page') {
      if (PAGE_SKIP_TAGS.has(tag)) return true
      if ((tag === 'header' || tag === 'footer') && !ctx.inArticle) return true
      const role = el.getAttribute('role')
      if (role && PAGE_SKIP_ROLES.test(role.toLowerCase())) return true
    }
    return false
  }

  private visitChildren(el: Node, ctx: Ctx): void {
    for (let c = el.firstChild; c; c = c.nextSibling) this.visit(c, ctx)
  }

  private visit(node: Node, ctx: Ctx): void {
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) {
      this.append(node.nodeValue || '', ctx)
      return
    }
    if (node.nodeType !== ELEMENT_NODE && node.nodeType !== 9 && node.nodeType !== 11) return
    if (node.nodeType !== ELEMENT_NODE) {
      this.visitChildren(node, ctx)
      return
    }
    const el = node as Element
    const tag = tagOf(el)
    if (this.shouldSkip(el, tag, ctx)) return
    this.recordId(el)

    switch (tag) {
      case 'br': {
        const prev = prevSignificantSibling(el)
        if (prev && prev.nodeType === ELEMENT_NODE && tagOf(prev as Element) === 'br') this.flush()
        else this.append(' ', ctx)
        return
      }
      case 'hr':
        this.flush()
        return
      case 'math':
        this.append(' ' + (el.getAttribute('alttext') || el.textContent || '') + ' ', ctx)
        return
      case 'sup': {
        const t = (el.textContent || '').trim()
        if (/^\d{1,3}$/.test(t)) {
          this.append([...t].map((d) => SUPERSCRIPT_DIGITS[d]).join(''), ctx)
          return
        }
        this.visitChildren(el, ctx)
        return
      }
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        this.flush()
        this.visitChildren(el, { ...ctx, type: 'heading', level: Number(tag[1]) })
        this.flush()
        return
      case 'p': {
        this.flush()
        const type: BlockType = ctx.type === 'quote' || ctx.type === 'list-item' ? ctx.type : ctx.type === 'heading' ? 'heading' : 'paragraph'
        this.visitChildren(el, { ...ctx, type })
        this.flush()
        return
      }
      case 'li': {
        this.flush()
        const counter = ctx.ol
        if (counter && el.parentElement && tagOf(el.parentElement) === 'ol') {
          const explicit = parseInt(el.getAttribute('value') || '', 10)
          const n = Number.isFinite(explicit) ? explicit : counter.n
          counter.n = n + 1
          if (counter.style !== 'none') this.prefix = listMarker(n, counter.style) + '. '
        }
        this.visitChildren(el, { ...ctx, type: 'list-item', ol: undefined })
        this.flush()
        this.prefix = ''
        return
      }
      case 'ol': {
        this.flush()
        const start = parseInt(el.getAttribute('start') || '', 10)
        const style = /list-style(-type)?\s*:\s*none/i.test(el.getAttribute('style') || '') ? 'none' : el.getAttribute('type') || '1'
        this.visitChildren(el, { ...ctx, ol: { n: Number.isFinite(start) ? start : 1, style } })
        this.flush()
        return
      }
      case 'ul':
        this.flush()
        this.visitChildren(el, { ...ctx, ol: undefined })
        this.flush()
        return
      case 'blockquote':
        this.flush()
        this.visitChildren(el, { ...ctx, type: 'quote' })
        this.flush()
        return
      case 'pre':
        this.flush()
        this.visitChildren(el, { ...ctx, type: 'code' })
        this.flush()
        return
      case 'table':
        this.flush()
        if (el.querySelector(LAYOUT_CELL_CONTENT)) this.visitChildren(el, ctx)
        else this.writeTable(el, ctx)
        this.flush()
        return
      case 'article':
      case 'main':
        this.flush()
        this.visitChildren(el, { ...ctx, inArticle: true })
        this.flush()
        return
      default:
        if (BLOCK_TAGS.has(tag)) {
          this.flush()
          this.visitChildren(el, ctx)
          this.flush()
        } else {
          this.visitChildren(el, ctx)
        }
    }
  }

  /** Data tables: one paragraph per row, cells joined with ", ". */
  private writeTable(table: Element, ctx: Ctx): void {
    const rowCtx: Ctx = { ...ctx, type: ctx.type === 'quote' ? 'quote' : 'paragraph' }
    for (const caption of Array.from(table.children).filter((c) => tagOf(c) === 'caption')) {
      this.append(this.inlineText(caption, ctx), rowCtx)
      this.flush()
    }
    const rows = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table)
    for (const tr of rows) {
      this.recordId(tr)
      const cells = Array.from(tr.children)
        .filter((c) => {
          const t = tagOf(c)
          return (t === 'td' || t === 'th') && !this.shouldSkip(c, t, ctx)
        })
        .map((c) => tidy(this.inlineText(c, ctx)))
        .filter(hasWords)
      if (cells.length) {
        this.append(cells.join(', '), rowCtx)
        this.flush()
      }
    }
  }

  /** Plain text of an element with the same skip rules, used for table cells. */
  private inlineText(el: Element, ctx: Ctx): string {
    let out = ''
    const walk = (n: Node) => {
      if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) {
        out += n.nodeValue || ''
        return
      }
      if (n.nodeType !== ELEMENT_NODE) return
      const e = n as Element
      const t = tagOf(e)
      if (this.shouldSkip(e, t, ctx)) return
      if (t === 'br') {
        out += ' '
        return
      }
      if (t === 'sup' && /^\s*\d{1,3}\s*$/.test(e.textContent || '')) {
        out += [...(e.textContent || '').trim()].map((d) => SUPERSCRIPT_DIGITS[d]).join('')
        return
      }
      const block = BLOCK_TAGS.has(t) || t === 'p' || /^h[1-6]$/.test(t) || t === 'li'
      if (block) out += ' '
      for (let c = e.firstChild; c; c = c.nextSibling) walk(c)
      if (block) out += ' '
    }
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c)
    return out
  }
}

/** Convert a DOM subtree to blocks; headings become chapters. */
export function htmlToBlocks(root: Node, mode: HtmlMode = 'page'): { blocks: Block[]; chapters: Chapter[] } {
  const w = new BlockWriter(mode)
  w.write(root)
  return { blocks: w.blocks, chapters: chaptersFromHeadings(w.blocks) }
}

// ---------------------------------------------------------------------------
// Sanitising + article extraction
// ---------------------------------------------------------------------------

/** Sanitise untrusted HTML with DOMPurify and parse it into an inert Document. */
export function parseSanitized(html: string): Document {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
    ADD_ATTR: ['epub:type'],
  })
  return new DOMParser().parseFromString(clean, 'text/html')
}

interface PageMeta {
  title: string
  ogTitle: string
  author?: string
  lang?: string
}

/** Metadata that DOMPurify would strip (<title>, <meta>) read from an inert parse of the raw HTML. */
function readPageMeta(raw: Document): PageMeta {
  const meta = (sel: string) => raw.querySelector(sel)?.getAttribute('content')?.trim() || ''
  const author =
    meta('meta[name="author"]') ||
    meta('meta[property="article:author"]:not([content^="http"])') ||
    meta('meta[name="dc.creator" i]') ||
    raw.querySelector('[rel="author"]')?.textContent?.trim() ||
    ''
  return {
    title: raw.title?.trim() || '',
    ogTitle: meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]'),
    author: meaningfulAuthor(author),
    lang: raw.documentElement?.getAttribute('lang') || meta('meta[http-equiv="content-language" i]') || undefined,
  }
}

export function titleFromUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    const seg = u.pathname.split('/').filter(Boolean).pop()
    if (seg) {
      let s = seg
      try {
        s = decodeURIComponent(seg)
      } catch {
        /* keep raw */
      }
      const t = titleFromFileName(s)
      if (t && /\p{L}{3,}/u.test(t)) return t
    }
    return u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export interface HtmlImportOptions {
  title?: string
  url?: string
  fileName?: string
  source?: SourceKind
}

/** Full HTML import: sanitise, extract the main article when it's a whole page, convert to blocks. */
export function importHtmlString(html: string, opts: HtmlImportOptions = {}): ImportedDoc {
  const raw = new DOMParser().parseFromString(html, 'text/html')
  const meta = readPageMeta(raw)
  const doc = parseSanitized(html)
  const body = doc.body
  const bodyText = (body?.textContent || '').replace(/\s+/g, ' ').trim()

  let root: Node | null = null
  let articleTitle = ''
  let byline: string | undefined
  let lang: string | undefined = meta.lang
  if (body && looksLikeFullPage(doc)) {
    try {
      const clone = doc.cloneNode(true) as Document
      const article = new Readability<Node>(clone, { serializer: (n) => n, charThreshold: 200 }).parse()
      const len = (article?.textContent || '').replace(/\s+/g, ' ').trim().length
      if (article?.content && (len >= 500 || len >= bodyText.length * 0.4)) {
        root = article.content
        articleTitle = article.title || ''
        byline = meaningfulAuthor(article.byline)
        lang = article.lang || lang
      }
    } catch {
      /* Readability failed: convert the whole body instead. */
    }
  }

  let blocks: Block[]
  if (root) {
    const w = new BlockWriter('page')
    w.write(root, { inArticle: true })
    blocks = w.blocks
  } else {
    blocks = body ? htmlToBlocks(body, 'page').blocks : []
  }

  return finalizeDoc({
    source: opts.source ?? (opts.url ? 'html' : 'paste'),
    blocks,
    titles: [opts.title, articleTitle, meta.ogTitle, meta.title],
    fallbackTitle: titleFromUrl(opts.url),
    fileName: opts.fileName,
    author: byline ?? meta.author,
    lang,
  })
}
