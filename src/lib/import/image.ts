import type Tesseract from 'tesseract.js'
import type { ImportedDoc } from '../../types'
import { cleanLine, linesToBlocks, type Line } from './layout'
import { createOcrSession, langFromOcr } from './ocr'
import { plainTextToBlocks } from './text'
import { finalizeDoc, hasWords, shortTitle, throwIfAborted } from './util'

// Photos and screenshots of text: on-device OCR with tesseract, then the same paragraph/heading
// analysis the PDF importer uses.

/** Recognition works best with text a few dozen pixels tall; bigger images only cost memory and time. */
const MAX_SIDE = 4000
const MAX_PIXELS = 16e6
/** Small screenshots are upscaled: tesseract misreads text that is only a few pixels tall. */
const MIN_SIDE = 1200

interface PreparedImage {
  image: Tesseract.ImageLike
  width: number
  height: number
  release: () => void
}

/**
 * Decode with the browser and redraw onto a canvas. This applies the photo's EXIF rotation (phone
 * cameras store portrait shots sideways), handles formats tesseract can't decode itself (GIF, AVIF,
 * HEIC on Safari) and keeps the size sensible. Returns null if the browser can't decode the file.
 */
async function prepareImage(file: Blob): Promise<PreparedImage | null> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    const { width, height } = bmp
    if (!width || !height) return null
    const long = Math.max(width, height)
    let scale = Math.min(1, MAX_SIDE / long, Math.sqrt(MAX_PIXELS / (width * height)))
    if (long < MIN_SIDE) scale = Math.min(2, MIN_SIDE / long)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // Transparent screenshots (dark text on nothing) would otherwise turn black-on-black.
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    return {
      image: canvas,
      width: canvas.width,
      height: canvas.height,
      release: () => {
        canvas.width = 0
        canvas.height = 0
      },
    }
  } finally {
    bmp.close()
  }
}

/** Camera and screenshot names ("IMG_1234.jpg", "Screenshot 2024-05-01 at 10.12.33.png", "image.jpg"). */
function isGenericImageName(name: string): boolean {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_\-.]+/g, ' ')
  const rest = base.replace(/\b(img|image|photo|picture|pic|dsc[a-z]?|pxl|mvimg|scan|scanned|screenshot|screen|shot|capture|camera|whatsapp|signal|at|am|pm)\b/gi, '')
  return !/\p{L}/u.test(rest)
}

/** TIFF is the one format most browsers can't show but tesseract can read directly. */
function isTiff(file: File): boolean {
  return /^image\/tiff?$/i.test(file.type) || /\.tiff?$/i.test(file.name)
}

export async function importImage(
  file: File,
  report: (label: string, value?: number | null) => void,
  opts: { ocrLang: string; signal?: AbortSignal },
): Promise<ImportedDoc> {
  const { signal } = opts
  let prepared = await prepareImage(file)
  if (!prepared && isTiff(file)) prepared = { image: file, width: 0, height: 0, release: () => undefined }
  if (!prepared) throw new Error("This image couldn't be opened in this browser. Try saving it as a PNG or JPG and import that.")

  try {
    throwIfAborted(signal)
    const session = await createOcrSession(opts.ocrLang, report, signal)
    try {
      const label = 'Recognising text in the image'
      report(label, 0)
      const res = await session.recognize(prepared.image, (p) => report(label, p))
      const lines: Line[] = []
      let right = 0
      let bottom = 0
      for (const l of res.lines) {
        const text = cleanLine(l.text)
        if (!text) continue
        lines.push({ text, x0: l.x0, x1: l.x1, y: l.y, h: l.h, region: l.region, paraStart: l.paraStart, ocr: true })
        right = Math.max(right, l.x1)
        bottom = Math.max(bottom, l.y + l.h)
      }
      const width = prepared.width || right
      const height = prepared.height || bottom
      const blocks = lines.length ? linesToBlocks([{ page: 1, width, height, lines }]).blocks : plainTextToBlocks(res.text)
      return finalizeDoc({
        source: 'image',
        blocks,
        // For "IMG_1234.jpg" the opening words of the text make a better title than the file name.
        fallbackTitle: !file.name || isGenericImageName(file.name) ? shortTitle(blocks.find((b) => hasWords(b.text))?.text ?? '', 60) : undefined,
        fileName: file.name || undefined,
        lang: langFromOcr(opts.ocrLang),
        warnings: ['This text was recognised from an image (OCR), so some words may be wrong.'],
      })
    } finally {
      await session.terminate()
    }
  } finally {
    prepared.release()
  }
}
