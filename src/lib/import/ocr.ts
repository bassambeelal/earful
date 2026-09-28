import type Tesseract from 'tesseract.js'
import { ISO3_TO_1, interopDefault, isAbortError, raceAbort, throwIfAborted } from './util'

// Tesseract.js OCR (lazy-loaded). One worker per import; its core, worker script and language
// data load from jsdelivr (allowed by the CSP) and the language data is cached in IndexedDB.

/** One recognised text line in image pixel coordinates. `y` is the baseline. */
export interface OcrLine {
  text: string
  x0: number
  x1: number
  y: number
  h: number
  /** First line of a paragraph as segmented by tesseract. */
  paraStart: boolean
  /** Tesseract block index (a column or text region). */
  region: number
}

export interface OcrPage {
  lines: OcrLine[]
  /** Raw recognised text, used when no layout data is available. */
  text: string
}

export interface OcrSession {
  recognize(image: Tesseract.ImageLike, onProgress?: (fraction: number) => void): Promise<OcrPage>
  terminate(): Promise<void>
}

const ONE_TO_ISO3: Record<string, string> = Object.fromEntries(
  Object.entries(ISO3_TO_1)
    .filter(([three]) => !['fre', 'ger', 'dut', 'cze', 'gre', 'per', 'rum'].includes(three))
    .map(([three, one]) => [one.toLowerCase(), three]),
)

/** Accepts tesseract codes ("eng", "eng+fra", "chi_sim") or ISO 639-1 ("en", "fr"). Defaults to English. */
export function normalizeOcrLang(lang: string | undefined): string {
  const parts = (lang || 'eng')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const lower = p.toLowerCase()
      if (ONE_TO_ISO3[lower]) return ONE_TO_ISO3[lower]
      const base = lower.split('-')[0]
      if (ONE_TO_ISO3[base]) return ONE_TO_ISO3[base]
      return /^[a-z]{3}(_[a-z]+)?$/.test(lower) ? lower : ''
    })
    .filter(Boolean)
  return parts.length ? [...new Set(parts)].join('+') : 'eng'
}

/** Document language implied by the OCR language (first one). */
export function langFromOcr(lang: string): string | undefined {
  return ISO3_TO_1[normalizeOcrLang(lang).split('+')[0]]
}

interface TessBbox {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface TessLine {
  text?: string
  confidence?: number
  bbox?: TessBbox
  baseline?: TessBbox
  rowAttributes?: { rowHeight?: number }
}

interface TessBlock {
  paragraphs?: Array<{ lines?: TessLine[] }>
}

/** Drop OCR noise from pictures, rules and page edges ("| ~ _ =", stray single letters). */
function usableLine(text: string, confidence: number): boolean {
  const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length
  if (alnum < 2 && !/^\p{Lu}$/u.test(text)) return false
  if (alnum / text.replace(/\s/g, '').length < 0.5) return false
  if (confidence < 40 && text.length < 20) return false
  return confidence >= 20
}

function toLines(blocks: TessBlock[] | null | undefined): OcrLine[] {
  const out: OcrLine[] = []
  ;(blocks ?? []).forEach((block, region) => {
    for (const para of block.paragraphs ?? []) {
      let first = true
      for (const line of para.lines ?? []) {
        const text = (line.text || '').replace(/\s+/g, ' ').trim()
        const b = line.bbox
        if (!text || !b || !usableLine(text, line.confidence ?? 100)) continue
        const boxH = Math.max(1, b.y1 - b.y0)
        const rowH = line.rowAttributes?.rowHeight
        const y = line.baseline ? (line.baseline.y0 + line.baseline.y1) / 2 : b.y1
        out.push({ text, x0: b.x0, x1: b.x1, y, h: rowH && rowH > 0 ? rowH : boxH, paraStart: first, region })
        first = false
      }
    }
  })
  return out
}

function friendlyOcrError(err: unknown, phase: 'start' | 'recognize'): Error {
  const msg = String((err as { message?: string })?.message ?? err ?? '')
  if (/traineddata|fetch|network|importScripts|load/i.test(msg)) {
    return new Error("Couldn't download the text recognition data. Check your internet connection and try again (it's only needed the first time).")
  }
  if (phase === 'start') return new Error("Text recognition couldn't start in this browser. Please try again, or try another browser.")
  return new Error('Text recognition failed. If this is a photo or a scan, try a sharper, well-lit copy.')
}

/**
 * Run `start` while recording every Web Worker it constructs. tesseract.js keeps its worker private
 * until loading has finished, so without this a failed or cancelled start could not be shut down.
 * `start` must create its worker synchronously (tesseract's createWorker does, before its first await).
 */
function captureWorkers<R>(start: () => R): { result: R; spawned: Worker[] } {
  const spawned: Worker[] = []
  const Native = globalThis.Worker
  if (typeof Native !== 'function') return { result: start(), spawned }
  globalThis.Worker = class extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      spawned.push(this)
    }
  }
  try {
    return { result: start(), spawned }
  } finally {
    globalThis.Worker = Native
  }
}

/**
 * Start a tesseract worker. `report` receives loading progress; recognise progress is per call.
 * Always call terminate() when done (use try/finally).
 */
export async function createOcrSession(
  lang: string,
  report: (label: string, value?: number | null) => void,
  signal?: AbortSignal,
): Promise<OcrSession> {
  throwIfAborted(signal)
  report('Loading text recognition…')
  const T = interopDefault(await import('tesseract.js'))
  throwIfAborted(signal)
  let onRecognize: ((p: number) => void) | null = null
  const logger = (m: Tesseract.LoggerMessage) => {
    if (m.status === 'recognizing text') onRecognize?.(m.progress)
    else if (m.status === 'loading language traineddata') report('Downloading text recognition data…', m.progress)
    else if (!onRecognize) report('Loading text recognition…')
  }

  // tesseract.js only rejects createWorker() when its core fails to load. When the language data
  // can't be downloaded or initialised it calls errorHandler and the promise never settles, so
  // errorHandler has to fail the start itself.
  let failStart: ((reason: unknown) => void) | null = null
  const startFailed = new Promise<never>((_, reject) => {
    failStart = reject
  })
  startFailed.catch(() => undefined)
  const errorHandler = (err: unknown) => failStart?.(err)

  const { result: pending, spawned } = captureWorkers(() =>
    T.createWorker(normalizeOcrLang(lang), T.OEM.LSTM_ONLY, { logger, errorHandler }),
  )
  let worker: Tesseract.Worker
  try {
    worker = await raceAbort(Promise.race([pending, startFailed]), signal)
    // The default (one uniform block) reads straight across columns; full page layout analysis
    // gives one tesseract block per column/region, which the layout code relies on.
    await raceAbort(worker.setParameters({ tessedit_pageseg_mode: T.PSM.AUTO }), signal)
  } catch (err) {
    // Shut the worker down now (stops any download), and again if it finishes loading later.
    for (const w of spawned) w.terminate()
    pending.then((w) => w.terminate()).catch(() => undefined)
    if (isAbortError(err)) throw err
    throw friendlyOcrError(err, 'start')
  } finally {
    failStart = null
  }

  let terminated = false
  return {
    async recognize(image, onProgress) {
      throwIfAborted(signal)
      onRecognize = onProgress ?? (() => undefined)
      try {
        const { data } = await raceAbort(worker.recognize(image, { rotateAuto: true }, { text: true, blocks: true }), signal)
        const page = data as unknown as { blocks?: TessBlock[] | null; text?: string | null }
        return { lines: toLines(page.blocks), text: page.text || '' }
      } catch (err) {
        if (isAbortError(err)) throw err
        throw friendlyOcrError(err, 'recognize')
      } finally {
        onRecognize = null
      }
    },
    async terminate() {
      if (terminated) return
      terminated = true
      await worker.terminate().catch(() => undefined)
    },
  }
}
