import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { Block, Chapter, ImportedDoc } from '../../types'
import { cleanLine, linesToBlocks, orderFragments, stripHeadersFooters, type BlockPos, type Frag, type Line, type PageLayout } from './layout'
import { createOcrSession, langFromOcr, type OcrPage, type OcrSession } from './ocr'
import { abortError, finalizeDoc, isAbortError, meaningfulAuthor, throwIfAborted, yieldToMain } from './util'

// PDF via pdf.js (lazy-loaded): text layer -> layout analysis -> blocks, OCR for scanned pages,
// chapters from the outline (bookmarks) or detected headings.

type PdfJs = typeof import('pdfjs-dist')

/** Pages with fewer visible characters than this are treated as scanned images. */
const MIN_PAGE_CHARS = 25

let pdfjsPromise: Promise<PdfJs> | null = null

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })
    pdfjsPromise.catch(() => {
      pdfjsPromise = null
    })
  }
  return pdfjsPromise
}

function friendlyPdfError(err: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted || isAbortError(err)) return abortError()
  const name = (err as { name?: string })?.name
  if (name === 'PasswordException') {
    return new Error('This PDF is password-protected. Remove the password (for example by printing it to a new PDF) and try again.')
  }
  if (name === 'InvalidPDFException') return new Error("This file doesn't look like a valid PDF. It may be damaged or incomplete.")
  return new Error("This PDF couldn't be opened. It may be damaged or use features that aren't supported.")
}

/** Positioned text fragments of a page in viewport space (y down). Rotated/mirrored text is skipped. */
function pageFragments(pdfjs: PdfJs, items: Array<{ str: string; dir: string; transform: number[]; width: number } | object>, transform: number[]): { frags: Frag[]; chars: number } {
  const frags: Frag[] = []
  let chars = 0
  for (const item of items) {
    if (!('str' in item) || !item.str) continue
    const tx = pdfjs.Util.transform(transform, item.transform) as number[]
    const h = Math.hypot(tx[2], tx[3])
    if (!(h > 0)) continue
    // Watermarks and margin stamps (e.g. arXiv identifiers) are drawn rotated.
    if (Math.abs(tx[1]) > Math.abs(tx[0]) * 0.2 || tx[0] <= 0) continue
    const x0 = tx[4]
    const w = item.width > 0 ? item.width : item.str.length * h * 0.5
    frags.push({ str: item.str, x0, x1: x0 + w, y: tx[5], h, rtl: item.dir === 'rtl' })
    chars += item.str.replace(/\s/g, '').length
  }
  return { frags, chars }
}

async function pageHasImages(pdfjs: PdfJs, page: PDFPageProxy): Promise<boolean> {
  const { OPS } = pdfjs
  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat,
  ])
  try {
    const ops = await page.getOperatorList()
    return ops.fnArray.some((fn) => imageOps.has(fn))
  } catch {
    return true
  } finally {
    page.cleanup()
  }
}

/** Render a page for OCR at ~2x (bounded so very large pages don't exhaust memory). */
async function renderPage(page: PDFPageProxy, signal?: AbortSignal): Promise<{ canvas: HTMLCanvasElement; scale: number }> {
  throwIfAborted(signal)
  const base = page.getViewport({ scale: 1 })
  const longSide = Math.max(base.width, base.height)
  let scale = Math.max(2, 1800 / longSide)
  scale = Math.min(scale, 5000 / longSide, Math.sqrt(16e6 / (base.width * base.height)))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const task = page.render({ canvas, viewport })
  const onAbort = () => task.cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await task.promise
  } catch (err) {
    canvas.width = 0
    canvas.height = 0
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return { canvas, scale }
}

function ocrLines(res: OcrPage, scale: number, regions: { next: number }): Line[] {
  const base = regions.next
  let maxRegion = 0
  const lines: Line[] = []
  for (const l of res.lines) {
    const text = cleanLine(l.text)
    if (!text) continue
    maxRegion = Math.max(maxRegion, l.region)
    lines.push({ text, x0: l.x0 / scale, x1: l.x1 / scale, y: l.y / scale, h: l.h / scale, region: base + l.region, paraStart: l.paraStart, ocr: true })
  }
  regions.next = base + maxRegion + 1
  return lines
}

interface OutlineNode {
  title: string
  dest: string | unknown[] | null
  items: OutlineNode[]
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** Map outline entries to blocks: title match on the target page, else position, else first block on/after the page. */
async function outlineChapters(pdf: PDFDocumentProxy, outline: OutlineNode[] | null, blocks: Block[], pos: BlockPos[], signal?: AbortSignal): Promise<Chapter[]> {
  if (!outline?.length) return []
  const flat: Array<{ title: string; dest: OutlineNode['dest']; depth: number }> = []
  const walk = (nodes: OutlineNode[], depth: number) => {
    for (const n of nodes) {
      flat.push({ title: n.title, dest: n.dest, depth })
      if (n.items?.length) walk(n.items, depth + 1)
    }
  }
  walk(outline, 0)
  const count = (d: number) => flat.filter((e) => e.depth <= d).length
  let maxDepth = count(0) <= 1 ? 2 : 1
  while (maxDepth > 0 && count(maxDepth) > 150) maxDepth--
  const entries = flat.filter((e) => e.depth <= maxDepth).slice(0, 400)

  const byPage = new Map<number, number[]>()
  pos.forEach((p, i) => {
    const list = byPage.get(p.page)
    if (list) list.push(i)
    else byPage.set(p.page, [i])
  })
  const viewports = new Map<number, { convertToViewportPoint(x: number, y: number): number[] }>()

  const chapters: Chapter[] = []
  for (const e of entries) {
    throwIfAborted(signal)
    const title = e.title?.trim()
    if (!title || !e.dest) continue
    let pageNum: number
    let destY: number | null = null
    try {
      const explicit = typeof e.dest === 'string' ? await pdf.getDestination(e.dest) : e.dest
      if (!Array.isArray(explicit) || explicit[0] == null) continue
      const ref = explicit[0]
      const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
      pageNum = index + 1
      const mode = (explicit[1] as { name?: string } | undefined)?.name
      const top = mode === 'XYZ' ? explicit[3] : mode === 'FitH' || mode === 'FitBH' ? explicit[2] : null
      if (typeof top === 'number') {
        let vp = viewports.get(pageNum)
        if (!vp) {
          vp = (await pdf.getPage(pageNum)).getViewport({ scale: 1 })
          viewports.set(pageNum, vp)
        }
        destY = vp.convertToViewportPoint(typeof explicit[2] === 'number' && mode === 'XYZ' ? explicit[2] : 0, top)[1]
      }
    } catch {
      continue
    }

    const want = normalizeForMatch(title).slice(0, 40)
    const candidates = [...(byPage.get(pageNum) ?? []), ...(byPage.get(pageNum + 1) ?? [])]
    let block = -1
    if (want.length >= 3) {
      const matches = candidates.filter((i) => {
        const have = normalizeForMatch(blocks[i].text)
        return have.length >= 3 && (have.startsWith(want) || want.startsWith(have.slice(0, 40)))
      })
      block = matches.find((i) => blocks[i].type === 'heading') ?? matches[0] ?? -1
    }
    if (block < 0 && destY != null) block = (byPage.get(pageNum) ?? []).find((i) => pos[i].y >= destY - 2) ?? -1
    if (block < 0) block = pos.findIndex((p) => p.page >= pageNum)
    if (block >= 0) chapters.push({ title, block })
  }
  return new Set(chapters.map((c) => c.block)).size >= 2 ? chapters : []
}

export interface PdfImportOptions {
  signal?: AbortSignal
  stripHeadersFooters: boolean
  ocrLang: string
}

export async function importPdf(
  buffer: ArrayBuffer,
  fileName: string | undefined,
  report: (label: string, value?: number | null) => void,
  opts: PdfImportOptions,
): Promise<ImportedDoc> {
  const { signal } = opts
  report('Opening PDF…')
  const pdfjs = await loadPdfJs()
  throwIfAborted(signal)

  // CMaps (CJK text), standard fonts and image decoders load on demand from the CDN.
  const cdn = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/`
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: cdn + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: cdn + 'standard_fonts/',
    iccUrl: cdn + 'iccs/',
    wasmUrl: cdn + 'wasm/',
    verbosity: 0,
  })
  const onAbort = () => void task.destroy()
  signal?.addEventListener('abort', onAbort, { once: true })

  let pdf: PDFDocumentProxy
  try {
    pdf = await task.promise
  } catch (err) {
    signal?.removeEventListener('abort', onAbort)
    void task.destroy()
    throw friendlyPdfError(err, signal)
  }

  try {
    const n = pdf.numPages
    const [meta, outline] = await Promise.all([pdf.getMetadata().catch(() => null), pdf.getOutline().catch(() => null)])
    const warnings: string[] = []
    const pages: PageLayout[] = []
    const lowText: number[] = []
    const failed: number[] = []
    const regions = { next: 0 }
    let docLang: string | undefined

    for (let i = 1; i <= n; i++) {
      throwIfAborted(signal)
      report(`Reading page ${i} of ${n}`, (i - 1) / n)
      const layout: PageLayout = { page: i, width: 0, height: 0, lines: [] }
      try {
        const page = await pdf.getPage(i)
        const vp = page.getViewport({ scale: 1 })
        layout.width = vp.width
        layout.height = vp.height
        const tc = await page.getTextContent()
        docLang ??= tc.lang || undefined
        const { frags, chars } = pageFragments(pdfjs, tc.items, vp.transform)
        layout.lines = orderFragments(frags, 0, vp.width, regions)
        if (chars < MIN_PAGE_CHARS) lowText.push(i)
        page.cleanup()
      } catch (err) {
        if (signal?.aborted) throw abortError()
        if (isAbortError(err)) throw err
        failed.push(i)
      }
      pages.push(layout)
      await yieldToMain()
    }

    // OCR pages that are (almost) only an image. In a mostly-text PDF, skip pages without images
    // (blank or vector-only pages) instead of running recognition on them.
    if (lowText.length) {
      const mostlyScanned = lowText.length >= n * 0.5
      let targets = lowText
      if (!mostlyScanned) {
        targets = []
        for (const i of lowText) {
          throwIfAborted(signal)
          if (await pageHasImages(pdfjs, await pdf.getPage(i))) targets.push(i)
        }
      }
      if (targets.length) {
        let session: OcrSession | null = null
        let recognised = 0
        try {
          session = await createOcrSession(opts.ocrLang, report, signal)
          for (let k = 0; k < targets.length; k++) {
            throwIfAborted(signal)
            const i = targets[k]
            const label = `Recognising text on page ${i} of ${n}`
            report(label, k / targets.length)
            const page = await pdf.getPage(i)
            let rendered: { canvas: HTMLCanvasElement; scale: number }
            try {
              rendered = await renderPage(page, signal)
            } catch (err) {
              if (signal?.aborted || isAbortError(err)) throw abortError()
              // One page that can't be drawn shouldn't stop the others.
              page.cleanup()
              failed.push(i)
              continue
            }
            const { canvas, scale } = rendered
            try {
              const res = await session.recognize(canvas, (p) => report(label, (k + p) / targets.length))
              pages[i - 1].lines = ocrLines(res, scale, regions)
              recognised++
            } finally {
              canvas.width = 0
              canvas.height = 0
              page.cleanup()
            }
            await yieldToMain()
          }
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) throw abortError()
          const textPages = n - lowText.length
          if (textPages === 0 && recognised === 0) throw err
          warnings.push(
            recognised
              ? `Text recognition stopped early, so ${targets.length - recognised} scanned page${targets.length - recognised === 1 ? ' was' : 's were'} skipped.`
              : "Some pages are scanned images, but text recognition couldn't be loaded, so they were skipped.",
          )
        } finally {
          await session?.terminate()
        }
        if (recognised) {
          docLang ??= langFromOcr(opts.ocrLang)
          warnings.unshift(
            recognised >= n * 0.8
              ? 'This PDF is a scan, so its text was recognised automatically (OCR). Some words may be wrong.'
              : `${recognised} scanned page${recognised === 1 ? ' was' : 's were'} read with text recognition (OCR), so some words may be wrong.`,
          )
        }
      }
    }
    if (failed.length) warnings.push(`${failed.length} page${failed.length === 1 ? '' : 's'} couldn't be read and ${failed.length === 1 ? 'was' : 'were'} skipped.`)

    if (opts.stripHeadersFooters) stripHeadersFooters(pages)
    const { blocks, pos } = linesToBlocks(pages)
    const chapters = await outlineChapters(pdf, outline as OutlineNode[] | null, blocks, pos, signal).catch((err) => {
      if (isAbortError(err)) throw err
      return [] as Chapter[]
    })

    const info = (meta?.info ?? {}) as Record<string, unknown>
    const xmpTitle = meta?.metadata?.get('dc:title')
    return finalizeDoc({
      source: 'pdf',
      blocks,
      chapters,
      titles: [typeof info.Title === 'string' ? info.Title : null, typeof xmpTitle === 'string' ? xmpTitle : null],
      fileName,
      author: meaningfulAuthor(typeof info.Author === 'string' ? info.Author : null),
      lang: docLang ?? (typeof info.Language === 'string' ? info.Language : undefined),
      warnings,
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
    void task.destroy()
  }
}
