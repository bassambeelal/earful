// Document import: files, pasted text/HTML and (where the site allows it) web links.
// Heavy libraries (pdf.js, tesseract, mammoth, JSZip) load only when needed. The HTML/Markdown
// helpers (DOMPurify, Readability, marked) are bundled with this module because importText and
// importHtml are synchronous.
import type { ImportedDoc } from '../../types'
import {
  ACCEPT,
  SUPPORTED_LABEL,
  charsetFromContentType,
  decodeHtml,
  decodeText,
  detectKind,
  isOleContainer,
  kindFromMime,
} from './detect'
import { importHtmlString, titleFromUrl } from './html'
import { importTextString } from './text'
import { abortError, isAbortError, progressReporter, raceAbort, throwIfAborted } from './util'

export interface ImportProgress {
  /** Human label: "Reading page 3 of 40", "Recognising text (OCR) 2/5" */
  label: string
  /** 0..1 or null if indeterminate */
  value: number | null
}

export interface ImportOptions {
  onProgress?: (p: ImportProgress) => void
  signal?: AbortSignal
  /** Remove running headers/footers/page numbers detected across PDF pages (default true). */
  stripHeadersFooters?: boolean
  /** OCR language(s) for tesseract, e.g. "eng" or "eng+fra" (default "eng"). */
  ocrLang?: string
}

/** The value for <input type="file" accept="...">. */
export const ACCEPTED_FILE_TYPES: string = ACCEPT

export { SUPPORTED_LABEL }

const UNSUPPORTED = `Earful can't read this kind of file. Supported: ${SUPPORTED_LABEL}.`
const OLD_OFFICE =
  "This is an older Microsoft Office file (such as .doc), which Earful can't read. Open it in Word or Google Docs, save it as .docx or PDF, and import that."
const RTF = "Earful can't read Rich Text (.rtf) files. Open it in a word processor, save it as .docx, PDF or plain text, and import that."

async function readHead(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 4096).arrayBuffer())
}

/** Import any supported file (PDF, EPUB, DOCX, TXT, MD, HTML, images). Throws Error with a friendly message on failure. */
export async function importFile(file: File, opts: ImportOptions = {}): Promise<ImportedDoc> {
  const { signal } = opts
  const report = progressReporter(opts)
  const ocrLang = opts.ocrLang || 'eng'
  throwIfAborted(signal)
  if (!file.size) throw new Error('This file is empty.')
  report('Reading file…')

  const head = await readHead(file)
  const kind = detectKind(file, head)
  if (kind !== 'docx' && isOleContainer(head)) throw new Error(OLD_OFFICE)
  if (/^\s*\{\\rtf/.test(String.fromCharCode(...head.subarray(0, 16)))) throw new Error(RTF)
  if (!kind) throw new Error(UNSUPPORTED)
  const fileName = file.name || undefined

  try {
    switch (kind) {
      case 'pdf': {
        const { importPdf } = await import('./pdf')
        return await importPdf(await file.arrayBuffer(), fileName, report, { signal, stripHeadersFooters: opts.stripHeadersFooters ?? true, ocrLang })
      }
      case 'epub': {
        const { importEpub } = await import('./epub')
        return await raceAbort(importEpub(await file.arrayBuffer(), fileName, report, signal), signal)
      }
      case 'docx': {
        const { importDocx } = await import('./docx')
        return await raceAbort(importDocx(await file.arrayBuffer(), fileName, report, signal), signal)
      }
      case 'image': {
        const { importImage } = await import('./image')
        return await importImage(file, report, { ocrLang, signal })
      }
      case 'html': {
        const html = decodeHtml(new Uint8Array(await file.arrayBuffer()))
        throwIfAborted(signal)
        return importHtmlString(html, { fileName, source: 'html' })
      }
      case 'markdown':
      case 'text': {
        const text = decodeText(new Uint8Array(await file.arrayBuffer()))
        throwIfAborted(signal)
        return importTextString(text, { fileName, format: kind === 'markdown' ? 'markdown' : undefined })
      }
    }
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw abortError()
    throw err instanceof Error ? err : new Error('This file could not be imported.')
  }
}

/** Import pasted plain text or Markdown. Title is derived from first line if not given. */
export function importText(text: string, title?: string): ImportedDoc {
  if (!text.trim()) throw new Error('There is no text to import. Paste some text first.')
  return importTextString(text, { title: title?.trim() || undefined, source: 'paste' })
}

/** Import pasted/clipboard HTML (sanitised, main article extracted with Readability). */
export function importHtml(html: string, opts: { title?: string; url?: string } = {}): ImportedDoc {
  if (!html.trim()) throw new Error('There is no text to import. Paste some text first.')
  return importHtmlString(html, { title: opts.title?.trim() || undefined, url: opts.url, source: opts.url ? 'html' : 'paste' })
}

const CORS_MESSAGE =
  "This site doesn't allow apps to fetch it directly. Open the page, select the text, copy it, and use Paste instead."

/** Try to fetch and import a web page. Most sites block this (CORS); throws a friendly Error suggesting paste instead. */
export async function importUrl(url: string, opts: ImportOptions = {}): Promise<ImportedDoc> {
  const { signal } = opts
  const report = progressReporter(opts)
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    throw new Error('That doesn’t look like a web address. It should start with https://')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only http and https links can be imported.')

  report('Fetching the page…')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let res: Response
  try {
    res = await fetch(parsed.href, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' })
  } catch {
    if (signal?.aborted) throw abortError()
    throw new Error(CORS_MESSAGE)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  if (!res.ok) throw new Error(`The page couldn't be loaded (error ${res.status}). Try copying the text and using Paste instead.`)

  const contentType = res.headers.get('content-type')
  const bytes = new Uint8Array(await res.arrayBuffer())
  throwIfAborted(signal)
  const fileName = decodeURIComponent(parsed.pathname.split('/').pop() || '') || undefined
  const kind = kindFromMime(contentType) ?? detectKind(new File([], fileName || 'page.html'), bytes.subarray(0, 4096))

  if (kind === 'html' || !kind) {
    return importHtmlString(decodeHtml(bytes, charsetFromContentType(contentType)), { url: parsed.href, source: 'html' })
  }
  if (kind === 'text' || kind === 'markdown') {
    const doc = importTextString(decodeText(bytes, charsetFromContentType(contentType)), { fileName, format: kind === 'markdown' ? 'markdown' : undefined })
    return doc.title === 'Untitled document' ? { ...doc, title: titleFromUrl(parsed.href) || doc.title } : doc
  }
  const type = contentType?.split(';')[0] || ''
  return importFile(new File([bytes], fileName || 'download', { type }), opts)
}
