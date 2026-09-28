import type { Block, BlockType } from '../../types'
import { endsSentence, fixLigatures, joinLine } from './util'

// Page layout analysis shared by the PDF importer and OCR: positioned text fragments -> ordered
// lines (with multi-column detection) -> header/footer removal -> paragraphs and headings.
// Coordinates are in page units with y growing downwards; `y` is a text baseline.

export interface Frag {
  str: string
  x0: number
  x1: number
  y: number
  /** Font size. */
  h: number
  rtl?: boolean
}

export interface Line {
  text: string
  x0: number
  x1: number
  y: number
  /** Font size (PDF text) or row height (OCR). */
  h: number
  /** Lines in the same column/text region share an id. */
  region: number
  /** OCR only: the recogniser started a new paragraph here. */
  paraStart?: boolean
  ocr?: boolean
}

export interface PageLayout {
  /** 1-based page number. */
  page: number
  width: number
  height: number
  lines: Line[]
}

export interface BlockPos {
  page: number
  y: number
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
}

/** Bullet glyphs, including the private-use code points symbol fonts (Wingdings/Symbol) map bullets to. */
const BULLET_RE = /^[•◦▪▫‣⁃●○■□►▶➢✓✔]\s*|^[-–*]\s+/
const NUMBERED_RE = /^(\(?\d{1,3}[.)]|\(?[a-z]\)|\(?[ivx]{1,4}\))\s+\S/i

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function weightedMedian(pairs: Array<[number, number]>): number {
  const s = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0])
  const total = s.reduce((acc, [, w]) => acc + w, 0)
  let run = 0
  for (const [v, w] of s) {
    run += w
    if (run >= total / 2) return v
  }
  return 0
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]
}

// ---------------------------------------------------------------------------
// Fragments -> rows -> lines (reading order)
// ---------------------------------------------------------------------------

interface Row {
  frags: Frag[]
  top: number
  bottom: number
  h: number
}

/**
 * Drop caps: a single oversized initial letter that spans two or more lines. Glue it onto the
 * start of the first line beside it, so it doesn't swallow neighbouring lines into one row.
 */
function attachDropCaps(frags: Frag[]): Frag[] {
  const body = weightedMedian(frags.map((f) => [f.h, f.str.trim().length]))
  if (!(body > 0)) return frags
  let out = frags
  for (const cap of frags) {
    if (cap.h < 1.8 * body || !/^\p{L}$/u.test(cap.str.trim())) continue
    let best = -1
    for (let i = 0; i < out.length; i++) {
      const g = out[i]
      if (g === cap || g.h > 1.3 * body || !/\p{L}/u.test(g.str)) continue
      if (g.x0 < cap.x1 - 0.5 * body || g.x0 > cap.x1 + 2 * body) continue
      // Its baseline must sit inside the cap's height, above the cap's own baseline.
      if (g.y < cap.y - cap.h || g.y > cap.y - 0.5 * body) continue
      const b = out[best]
      if (best < 0 || g.y < b.y - 0.3 * body || (Math.abs(g.y - b.y) <= 0.3 * body && g.x0 < b.x0)) best = i
    }
    if (best < 0) continue
    const g = out[best]
    out = out.filter((f) => f !== cap)
    out[out.indexOf(g)] = { ...g, str: cap.str.trim() + g.str, x0: Math.min(cap.x0, g.x0) }
  }
  return out
}

/** Group fragments into visual rows: fragments whose vertical extents overlap by more than half. */
function groupRows(input: Frag[]): Row[] {
  const sorted = [...attachDropCaps(input)].sort((a, b) => a.y - b.y || a.x0 - b.x0)
  const rows: Row[] = []
  for (const f of sorted) {
    const top = f.y - 0.8 * f.h
    const bottom = f.y + 0.2 * f.h
    let target: Row | null = null
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 4); i--) {
      const r = rows[i]
      const overlap = Math.min(bottom, r.bottom) - Math.max(top, r.top)
      if (overlap > 0.5 * Math.min(bottom - top, r.bottom - r.top)) {
        target = r
        break
      }
    }
    if (target) {
      target.frags.push(f)
      // A much taller fragment (big symbol, stray initial) must not stretch the row, or the row
      // would go on to swallow the next line of normal text.
      if (f.h > target.h && f.h <= 1.8 * target.h) {
        target.h = f.h
        target.top = top
        target.bottom = bottom
      }
    } else {
      rows.push({ frags: [f], top, bottom, h: f.h })
    }
  }
  for (const r of rows) r.frags.sort((a, b) => a.x0 - b.x0)
  return rows.sort((a, b) => a.bottom - b.bottom)
}

/** Baseline of a row's dominant fragment. */
function rowY(r: Row): number {
  return r.bottom - 0.2 * r.h
}

/** Horizontal extents of a row, merging word gaps (anything narrower than one font size). */
function rowIntervals(row: Row): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const f of row.frags) {
    const last = out[out.length - 1]
    if (last && f.x0 - last[1] < row.h) last[1] = Math.max(last[1], f.x1)
    else out.push([f.x0, f.x1])
  }
  return out
}

function crosses(iv: Array<[number, number]>, x: number): boolean {
  for (const [a, b] of iv) if (a < x && b > x) return true
  return false
}

/**
 * Find a vertical gutter between columns in [x0, x1]: a band in the middle half that most rows
 * leave empty, with substantial text on both sides. Full-width rows (titles, abstracts) may cross it.
 */
function findGutter(rows: Row[], x0: number, x1: number): number | null {
  if (rows.length < 6) return null
  const width = x1 - x0
  const hMed = median(rows.map((r) => r.h))
  if (hMed <= 0 || width < hMed * 15) return null
  const ivs = rows.map(rowIntervals)
  const allowed = Math.max(1, Math.floor(rows.length * 0.4))
  const step = Math.max(0.5, hMed / 4)
  const lo = x0 + 0.25 * width
  const hi = x1 - 0.25 * width
  let best: [number, number] | null = null
  let runStart = -1
  for (let x = lo; x <= hi; x += step) {
    let cross = 0
    for (const iv of ivs) if (crosses(iv, x)) cross++
    const ok = cross <= allowed
    if (ok && runStart < 0) runStart = x
    const last = x + step > hi
    if (runStart >= 0 && (!ok || last)) {
      const end = ok ? x : x - step
      if (!best || end - runStart > best[1] - best[0]) best = [runStart, end]
      runStart = -1
    }
  }
  if (!best || best[1] - best[0] < hMed * 0.5) return null
  const g = (best[0] + best[1]) / 2

  let left = 0
  let right = 0
  let leftRows = 0
  let rightRows = 0
  rows.forEach((r, i) => {
    if (crosses(ivs[i], g)) return
    let l = 0
    let rr = 0
    for (const f of r.frags) {
      if ((f.x0 + f.x1) / 2 < g) l += f.str.length
      else rr += f.str.length
    }
    left += l
    right += rr
    if (l) leftRows++
    if (rr) rightRows++
  })
  const total = left + right
  if (!total || left < total * 0.2 || right < total * 0.2 || leftRows < 3 || rightRows < 3) return null
  return g
}

function toSuperscript(digits: string): string {
  return [...digits].map((d) => SUPERSCRIPT[d] ?? d).join('')
}

/** Tidy a reconstructed line: ligatures, letter-spaced words, spaces before punctuation, TOC dot leaders. */
export function cleanLine(raw: string): string {
  let t = fixLigatures(raw).replace(/\s/g, ' ').trim()
  // "H E L L O  W O R L D" (tracked-out headings). Runs of 2+ spaces are word breaks, so this runs
  // before whitespace is collapsed. (No lookbehind: Safari only supports it from 16.4.)
  t = t.replace(/(^| )((?:\p{L} ){3,}\p{L})(?= |$)/gu, (_m, pre: string, run: string) => pre + run.replace(/ /g, ''))
  t = t.replace(/ {2,}/g, ' ')
  t = t.replace(/([\p{L}\p{N}]) ([,.;:!?%)\]])(?= |$)/gu, '$1$2')
  t = t.replace(/([([]) (?=\S)/g, '$1')
  t = t.replace(/\s*(?:\.\s*){4,}\d{0,4}$/, '')
  return t.trim()
}

function rowToLine(row: Row, region: number): Line {
  const rtl = row.frags.filter((f) => f.rtl).length > row.frags.length / 2
  const frags = rtl ? [...row.frags].sort((a, b) => b.x1 - a.x1) : row.frags
  const lineH = weightedMedian(frags.map((f) => [f.h, Math.max(1, f.str.trim().length)])) || row.h
  const main = frags.reduce((a, b) => (b.str.length > a.str.length ? b : a), frags[0])
  let text = ''
  let prev: Frag | null = null
  let edge = 0
  let x0 = Infinity
  let x1 = -Infinity
  for (const f of frags) {
    // Fake bold: the same text overprinted with a tiny offset.
    if (prev && f.str === prev.str && Math.abs(f.x0 - prev.x0) < 0.3 * lineH && Math.abs(f.y - prev.y) < 0.3 * lineH) continue
    let s = f.str
    const trimmed = s.trim()
    if (/^\d{1,3}$/.test(trimmed) && f.h < 0.85 * lineH && f.y < main.y - 0.15 * lineH) s = toSuperscript(trimmed)
    if (prev) {
      const gap = rtl ? edge - f.x1 : f.x0 - edge
      // A wide gap gets two spaces so cleanLine can tell word breaks in letter-spaced headings.
      if (gap > 0.15 * lineH && !/\s$/.test(text) && !/^\s/.test(s)) text += gap > 0.6 * lineH ? '  ' : ' '
      edge = rtl ? Math.min(edge, f.x0) : Math.max(edge, f.x1)
    } else {
      edge = rtl ? f.x0 : f.x1
    }
    text += s
    prev = f
    x0 = Math.min(x0, f.x0)
    x1 = Math.max(x1, f.x1)
  }
  return { text: cleanLine(text), x0, x1, y: main.y, h: lineH, region }
}

/**
 * Order the fragments of one page (or region of it) into lines. Detects up to two nested column
 * splits; full-width rows split the columns into bands that are read top to bottom.
 */
export function orderFragments(frags: Frag[], x0: number, x1: number, regions: { next: number }, depth = 0): Line[] {
  if (!frags.length) return []
  const rows = groupRows(frags)
  const gutter = depth < 2 ? findGutter(rows, x0, x1) : null
  if (gutter == null) {
    const region = regions.next++
    return rows.map((r) => rowToLine(r, region)).filter((l) => l.text)
  }
  const spans: Row[] = []
  const left: Frag[] = []
  const right: Frag[] = []
  for (const r of rows) {
    if (crosses(rowIntervals(r), gutter)) spans.push(r)
    else for (const f of r.frags) ((f.x0 + f.x1) / 2 < gutter ? left : right).push(f)
  }
  const out: Line[] = []
  let bandTop = -Infinity
  for (let k = 0; k <= spans.length; k++) {
    const bandBottom = k < spans.length ? rowY(spans[k]) : Infinity
    const inBand = (f: Frag) => f.y > bandTop && f.y <= bandBottom
    out.push(...orderFragments(left.filter(inBand), x0, gutter, regions, depth + 1))
    out.push(...orderFragments(right.filter(inBand), gutter, x1, regions, depth + 1))
    if (k < spans.length) {
      const line = rowToLine(spans[k], regions.next++)
      if (line.text) out.push(line)
      bandTop = rowY(spans[k])
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Running headers, footers and page numbers
// ---------------------------------------------------------------------------

const PAGE_NUMBER_RES = [
  /^(page|p\.?|pg\.?)?\s*[-–—([]?\s*\d{1,4}\s*[-–—)\]]?$/i,
  /^(page\s*)?\d{1,4}\s*(of|\/)\s*\d{1,4}$/i,
  /^[-–—]?\s*[ivxlcdm]{1,7}\s*[-–—]?$/i,
]

function zoneOf(l: Line, p: PageLayout): 'top' | 'bottom' | null {
  if (l.y - l.h <= 0.09 * p.height) return 'top'
  if (l.y >= 0.91 * p.height) return 'bottom'
  return null
}

function headerKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\b[ivxlcdm]{1,7}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Remove lone page numbers in the top/bottom ~9% of each page, and lines there whose
 * digit-normalised text repeats on at least 40% of pages (min 3) or densely within a run of pages
 * (per-chapter running heads).
 */
export function stripHeadersFooters(pages: PageLayout[]): void {
  const occurrences = new Map<string, number[]>()
  pages.forEach((p, pi) => {
    const seen = new Set<string>()
    for (const l of p.lines) {
      if (!zoneOf(l, p)) continue
      const k = headerKey(l.text)
      if (!/\p{L}/u.test(k.replace(/#/g, '')) || seen.has(k)) continue
      seen.add(k)
      const list = occurrences.get(k)
      if (list) list.push(pi)
      else occurrences.set(k, [pi])
    }
  })
  const repeated = new Set<string>()
  const minPages = Math.max(3, Math.ceil(pages.length * 0.4))
  for (const [k, idx] of occurrences) {
    if (idx.length < 3) continue
    const span = idx[idx.length - 1] - idx[0] + 1
    if (idx.length >= minPages || idx.length / span >= 0.4) repeated.add(k)
  }
  for (const p of pages) {
    p.lines = p.lines.filter((l) => {
      if (!zoneOf(l, p)) return true
      const t = l.text.trim()
      if (PAGE_NUMBER_RES.some((re) => re.test(t))) return false
      return !repeated.has(headerKey(t))
    })
  }
}

// ---------------------------------------------------------------------------
// Lines -> blocks
// ---------------------------------------------------------------------------

interface Draft {
  type: BlockType
  level?: number
  text: string
  h: number
  page: number
  y: number
  last: Line
}

interface Stats {
  body: number
  gap: number
}

function statsFor(lines: Line[]): Stats {
  const body = weightedMedian(lines.map((l) => [l.h, l.text.length])) || 10
  return { body, gap: 1.2 }
}

function lineGapRatio(pages: PageLayout[], ocr: boolean, body: number): number {
  const ratios: number[] = []
  for (const p of pages) {
    for (let i = 1; i < p.lines.length; i++) {
      const a = p.lines[i - 1]
      const b = p.lines[i]
      if (!!a.ocr !== ocr || !!b.ocr !== ocr || a.region !== b.region) continue
      if (Math.abs(a.h - body) > 0.1 * body || Math.abs(b.h - body) > 0.1 * body) continue
      const d = (b.y - a.y) / body
      if (d > 0.5 && d < 3) ratios.push(d)
    }
  }
  return median(ratios) || 1.2
}

function regionBounds(pages: PageLayout[]): Map<string, { left: number; right: number }> {
  const groups = new Map<string, Line[]>()
  for (const p of pages) {
    for (const l of p.lines) {
      const k = `${p.page}:${l.region}`
      const g = groups.get(k)
      if (g) g.push(l)
      else groups.set(k, [l])
    }
  }
  const out = new Map<string, { left: number; right: number }>()
  for (const [k, ls] of groups) out.set(k, { left: percentile(ls.map((l) => l.x0), 0.1), right: percentile(ls.map((l) => l.x1), 0.9) })
  return out
}

function headingLevel(ratio: number): number {
  return ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3
}

/**
 * Build paragraphs, headings and list items from ordered page lines. Paragraph breaks come from
 * vertical gaps, indentation, short sentence-final lines, font size changes and (for OCR) the
 * recogniser's own paragraphs. Paragraphs continue across columns and pages when mid-sentence.
 */
export function linesToBlocks(pages: PageLayout[]): { blocks: Block[]; pos: BlockPos[] } {
  const all = pages.flatMap((p) => p.lines)
  const textStats = statsFor(all.filter((l) => !l.ocr))
  const ocrStats = statsFor(all.filter((l) => l.ocr))
  textStats.gap = lineGapRatio(pages, false, textStats.body)
  ocrStats.gap = lineGapRatio(pages, true, ocrStats.body)
  const bounds = regionBounds(pages)

  const out: Draft[] = []
  let cur: Draft | null = null
  let dropCap = ''

  /** Where a paragraph that ran off the previous page continues (skipping smaller footnote blocks). */
  const crossPageTarget = (l: Line, text: string): Draft | null => {
    for (let i = out.length - 1; i >= Math.max(0, out.length - 4); i--) {
      const d = out[i]
      if (d.h < l.h * 0.85 && d.type !== 'heading') continue
      if (d.type === 'heading' || Math.abs(d.h - l.h) > 0.2 * l.h || endsSentence(d.text)) return null
      return /^\p{Ll}/u.test(text) || d.text.length >= 40 ? d : null
    }
    return null
  }

  for (const page of pages) {
    let firstOnPage = true
    for (const l of page.lines) {
      let text = l.text
      if (!text) continue
      const stats = l.ocr ? ocrStats : textStats
      const ratio = l.h / stats.body
      const heading = ratio >= (l.ocr ? 1.3 : 1.15) && text.length <= 150 && /\p{L}/u.test(text)
      if (!heading && !/\p{L}/u.test(text)) continue
      if (ratio >= 1.5 && /^\p{Lu}$/u.test(text)) {
        dropCap = text
        continue
      }
      const bullet = heading ? null : BULLET_RE.exec(text)
      if (bullet) text = text.slice(bullet[0].length)
      const numbered = !heading && NUMBERED_RE.test(text)
      if (dropCap) {
        text = /^\p{Ll}/u.test(text) ? dropCap + text : dropCap + ' ' + text
        dropCap = ''
      }

      let target: Draft | null = null
      if (cur) {
        if (firstOnPage) {
          target = heading || bullet ? null : crossPageTarget(l, text)
        } else if (heading) {
          const p = cur.last
          if (cur.type === 'heading' && Math.abs(l.h - cur.h) <= 0.1 * cur.h && l.region === p.region && l.y > p.y && l.y - p.y <= 2.2 * l.h) target = cur
        } else if (cur.type !== 'heading' && !bullet) {
          const p: Line = cur.last
          const sizeChange = Math.abs(l.h - p.h) > 0.2 * Math.max(l.h, p.h)
          if (sizeChange) target = null
          // A new OCR block (e.g. the next column) that picks up mid-sentence continues the paragraph.
          else if (l.ocr && p.ocr && l.region !== p.region) target = !endsSentence(p.text) && /^\p{Ll}/u.test(text) ? cur : null
          else if (l.ocr && p.ocr) target = l.paraStart || (numbered && /[.!?:]\W*$/.test(p.text)) ? null : cur
          else if (l.region !== p.region || l.y < p.y - 0.5 * p.h) target = endsSentence(p.text) ? null : cur
          else {
            const b = bounds.get(`${page.page}:${l.region}`) ?? { left: l.x0, right: l.x1 }
            const gap = l.y - p.y
            const indent = l.x0 - b.left
            const shortPrev = b.right - p.x1 > Math.max(0.12 * (b.right - b.left), 2 * p.h)
            const ended = endsSentence(p.text)
            if (gap > stats.gap * Math.min(l.h, p.h) * 1.4) target = null
            else if (numbered && (ended || /:\s*$/.test(p.text))) target = null
            else if (ended && (shortPrev || (indent > 0.8 * l.h && indent < 8 * l.h))) target = null
            else target = cur
          }
        }
      }

      if (target) {
        target.text = joinLine(target.text, text)
        target.last = l
        cur = target
      } else {
        const type: BlockType = heading ? 'heading' : bullet || numbered ? 'list-item' : 'paragraph'
        cur = { type, text, h: l.h, page: page.page, y: l.y, last: l }
        if (heading) cur.level = headingLevel(ratio)
        out.push(cur)
      }
      firstOnPage = false
    }
  }

  const blocks: Block[] = []
  const pos: BlockPos[] = []
  for (const d of out) {
    const type: BlockType = d.type === 'heading' && d.text.length > 200 ? 'paragraph' : d.type
    const b: Block = { type, text: d.text, page: d.page }
    if (type === 'heading') b.level = d.level
    blocks.push(b)
    pos.push({ page: d.page, y: d.y })
  }
  return { blocks, pos }
}
