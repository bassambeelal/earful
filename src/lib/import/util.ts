import type { Block, Chapter, ImportedDoc, SourceKind } from '../../types'
import { cleanText } from '../text'
import type { ImportOptions, ImportProgress } from './index'

// Shared helpers for every importer.

export function abortError(): DOMException {
  return new DOMException('The import was cancelled.', 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** Resolve/reject with `promise`, but reject with an AbortError as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** CommonJS packages arrive either as the module itself or under `default`, depending on the bundler. */
export function interopDefault<T>(mod: T): T {
  const d = (mod as { default?: T }).default
  return d ?? mod
}

/** Give the browser a chance to paint and handle input during long imports. */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (sched?.yield) return sched.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Wraps onProgress: drops no-op repeats so tight loops (OCR logger) don't flood the UI. */
export function progressReporter(opts?: ImportOptions): (label: string, value?: number | null) => void {
  const cb = opts?.onProgress
  let lastLabel = ''
  let lastValue: number | null = -1
  return (label, value = null) => {
    if (!cb) return
    const v = value == null ? null : Math.max(0, Math.min(1, value))
    if (label === lastLabel && (v === lastValue || (v != null && lastValue != null && Math.abs(v - lastValue) < 0.01 && v < 1))) return
    lastLabel = label
    lastValue = v
    const p: ImportProgress = { label, value: v }
    cb(p)
  }
}

const LIGATURES: Record<string, string> = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
}

export function fixLigatures(s: string): string {
  return s.replace(/[\ufb00-\ufb06]/g, (c) => LIGATURES[c] ?? c)
}

/** cleanText + ligature repair. Every block text goes through this. */
export function tidy(s: string): string {
  return cleanText(fixLigatures(s))
}

export function hasWords(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s)
}

// ---------------------------------------------------------------------------
// Line joining (plain text, PDF, OCR)
// ---------------------------------------------------------------------------

/** Prefixes whose hyphen is part of the word even at a line break ("self-\naware"). */
const KEEP_HYPHEN_PREFIXES = new Set(['self', 'well', 'non', 'ex', 'anti', 'quasi', 'pseudo', 'vice', 'all', 'half', 'cross'])

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * Join two consecutive lines of the same paragraph, repairing hard-wrap hyphenation:
 * "exam-" + "ple" -> "example", "Jean-" + "Paul" -> "Jean-Paul", CJK lines join without a space.
 */
export function joinLine(prev: string, next: string): string {
  const a = prev.replace(/\s+$/, '')
  const b = next.replace(/^\s+/, '')
  if (!a) return b
  if (!b) return a
  const hy = /(\p{L}+)[-\u2010\u2011\u00ad]$/u.exec(a)
  if (hy) {
    const stem = a.slice(0, -1)
    if (/^\p{Ll}/u.test(b) && !KEEP_HYPHEN_PREFIXES.has(hy[1].toLowerCase())) return stem + b
    return a.endsWith('\u00ad') ? stem + b : stem + '-' + b
  }
  if (CJK_RE.test(a[a.length - 1]) && CJK_RE.test(b[0])) return a + b
  return a + ' ' + b
}

/** Ends like the end of a sentence (allowing closing quotes/brackets). */
export function endsSentence(s: string): boolean {
  return /[.!?…。！？:;]["'”’»)\]]*\s*$/.test(s)
}

// ---------------------------------------------------------------------------
// Titles, languages, chapters
// ---------------------------------------------------------------------------

/** "the_great-gatsby (1).pdf" -> "the great gatsby (1)" */
export function titleFromFileName(name: string | undefined): string {
  if (!name) return ''
  let base = name.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,6}$/i, '')
  // Hyphens separate words only in names without real spaces ("my-notes", "the_great-gatsby").
  if (!/\s/.test(base.replace(/\s*\(\d+\)$/, '')) && /-/.test(base)) base = base.replace(/-+/g, ' ')
  base = base.replace(/_+/g, ' ')
  return cleanText(base)
}

const JUNK_TITLES = /^(untitled|title|document|doc|new document|microsoft word|powerpoint presentation|slide \d+|presentation|book|ebook|unknown|none|null|\(anonymous\)|anonymous|default|index|home|page)$/i

/** Metadata titles are often garbage ("Microsoft Word - draft7.docx", "untitled"). */
export function meaningfulTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  let t = cleanText(String(raw))
  t = t.replace(/^microsoft (word|powerpoint|excel) - /i, '')
  t = t.replace(/\.(docx?|pdf|txt|rtf|odt|pages|tex|dvi|indd|qxd|pptx?|html?|epub)$/i, '').trim()
  if (t.length < 2 || t.length > 300) return ''
  if (!/\p{L}/u.test(t)) return ''
  if (JUNK_TITLES.test(t)) return ''
  // Looks like a file or tool artefact: "doc12345", "C:\\foo", "12345678_final"
  if (/^[\w-]*\d{4,}[\w-]*$/.test(t) && !/\s/.test(t)) return ''
  if (/[\\/]/.test(t) && !/\s/.test(t)) return ''
  return t
}

export function meaningfulAuthor(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const a = cleanText(String(raw))
  if (a.length < 2 || a.length > 200 || !/\p{L}/u.test(a)) return undefined
  if (/^(administrator|admin|user|owner|author|unknown|default|windows user|microsoft office user|anonymous)$/i.test(a)) return undefined
  return a
}

/** Normalise "en_US", "EN-us", "eng" -> BCP-47 ("en-US", "en"). Returns undefined if invalid. */
export function normalizeLang(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  let tag = String(raw).trim().replace(/_/g, '-')
  if (!tag) return undefined
  const iso3 = ISO3_TO_1[tag.toLowerCase()]
  if (iso3) tag = iso3
  try {
    const [canon] = Intl.getCanonicalLocales(tag)
    return canon || undefined
  } catch {
    return undefined
  }
}

/** Tesseract / ISO 639-2 codes -> ISO 639-1 for the ones people actually use. */
export const ISO3_TO_1: Record<string, string> = {
  eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', dut: 'nl',
  rus: 'ru', ukr: 'uk', pol: 'pl', ces: 'cs', cze: 'cs', slk: 'sk', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  tur: 'tr', ell: 'el', gre: 'el', ara: 'ar', heb: 'he', hin: 'hi', ben: 'bn', urd: 'ur', fas: 'fa', per: 'fa',
  jpn: 'ja', kor: 'ko', chi_sim: 'zh-Hans', chi_tra: 'zh-Hant', vie: 'vi', tha: 'th', ind: 'id', msa: 'ms',
  hun: 'hu', ron: 'ro', rum: 'ro', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', lit: 'lt', lav: 'lv', est: 'et',
  cat: 'ca', eus: 'eu', glg: 'gl', afr: 'af', swa: 'sw', tam: 'ta', tel: 'te', mar: 'mr', guj: 'gu', kan: 'kn',
  mal: 'ml', pan: 'pa', fil: 'fil', tgl: 'tl',
}

/**
 * Chapters from heading blocks: the top two heading levels present, or only the top level
 * when that would produce an unwieldy list.
 */
export function chaptersFromHeadings(blocks: Block[]): Chapter[] {
  const headings: Array<{ i: number; level: number }> = []
  blocks.forEach((b, i) => {
    if (b.type === 'heading' && hasWords(b.text)) headings.push({ i, level: b.level ?? 1 })
  })
  if (!headings.length) return []
  const levels = [...new Set(headings.map((h) => h.level))].sort((a, b) => a - b)
  let maxLevel = levels[1] ?? levels[0]
  if (headings.filter((h) => h.level <= maxLevel).length > 200) maxLevel = levels[0]
  return headings
    .filter((h) => h.level <= maxLevel)
    .map((h) => ({ title: shortTitle(blocks[h.i].text), block: h.i }))
}

export function shortTitle(s: string, max = 120): string {
  const t = tidy(s)
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…'
}

// ---------------------------------------------------------------------------
// Final assembly
// ---------------------------------------------------------------------------

export interface DraftDoc {
  source: SourceKind
  blocks: Block[]
  chapters?: Chapter[]
  /** Title candidates in priority order (metadata first). File name is the last resort. */
  titles?: Array<string | null | undefined>
  /** Used after the first heading but before the file name (e.g. a title derived from a URL). */
  fallbackTitle?: string
  fileName?: string
  author?: string
  lang?: string
  warnings?: string[]
}

export const NO_TEXT_MESSAGE =
  "No readable text was found in this file. If it's a scan or a photo, make sure the text is sharp and well lit, then try again."

/**
 * Clean blocks, drop empty ones (remapping chapter indices), pick a title, and validate.
 * Throws the friendly "no readable text" error when nothing is left.
 */
export function finalizeDoc(d: DraftDoc): ImportedDoc {
  const blocks: Block[] = []
  const remap = new Array<number>(d.blocks.length)
  for (let i = 0; i < d.blocks.length; i++) {
    remap[i] = blocks.length
    const src = d.blocks[i]
    const text = tidy(src.text)
    if (!text || !hasWords(text)) continue
    const b: Block = { type: src.type, text }
    if (src.type === 'heading') b.level = Math.max(1, Math.min(6, Math.round(src.level ?? 1)))
    if (src.page != null) b.page = src.page
    blocks.push(b)
  }
  if (!blocks.length) throw new Error(NO_TEXT_MESSAGE)

  let chapters: Chapter[] = []
  const seen = new Set<number>()
  for (const ch of d.chapters ?? []) {
    if (ch.block == null || ch.block < 0 || ch.block >= remap.length) continue
    const block = remap[ch.block]
    const title = shortTitle(ch.title || '')
    if (block >= blocks.length || !title || seen.has(block)) continue
    seen.add(block)
    chapters.push({ title, block })
  }
  chapters.sort((a, b) => a.block - b.block)
  if (!chapters.length) chapters = chaptersFromHeadings(blocks)

  let firstHeading = ''
  let bestLevel = 99
  for (const b of blocks.slice(0, 40)) {
    if (b.type === 'heading' && (b.level ?? 1) < bestLevel && b.text.length <= 200) {
      bestLevel = b.level ?? 1
      firstHeading = b.text
    }
  }
  const title =
    (d.titles ?? []).map(meaningfulTitle).find(Boolean) ||
    meaningfulTitle(firstHeading) ||
    meaningfulTitle(d.fallbackTitle) ||
    titleFromFileName(d.fileName) ||
    shortTitle(blocks[0].text, 80) ||
    'Untitled document'

  const doc: ImportedDoc = { title: shortTitle(title, 200), source: d.source, blocks, chapters }
  if (d.author) doc.author = d.author
  if (d.fileName) doc.fileName = d.fileName
  const lang = normalizeLang(d.lang)
  if (lang) doc.lang = lang
  const warnings = [...new Set((d.warnings ?? []).filter(Boolean))]
  if (warnings.length) doc.warnings = warnings
  return doc
}
