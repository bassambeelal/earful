// File-type detection and text decoding.

export type FileKind = 'pdf' | 'epub' | 'docx' | 'text' | 'markdown' | 'html' | 'image'

const EXTENSIONS: Record<string, FileKind> = {
  pdf: 'pdf',
  epub: 'epub',
  docx: 'docx',
  txt: 'text',
  text: 'text',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  jfif: 'image',
  webp: 'image',
  bmp: 'image',
  gif: 'image',
  tif: 'image',
  tiff: 'image',
}

const MIME_TYPES: Record<string, FileKind> = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  'image/gif': 'image',
  'image/tiff': 'image',
}

export const ACCEPT = [
  ...Object.keys(EXTENSIONS).map((e) => '.' + e),
  ...Object.keys(MIME_TYPES),
].join(',')

export const SUPPORTED_LABEL = 'PDF, EPUB, Word (.docx), text (.txt), Markdown (.md), web pages (.html) and images (PNG, JPG, WebP, GIF, BMP, TIFF)'

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export function kindFromMime(mime: string | null | undefined): FileKind | null {
  if (!mime) return null
  const base = mime.split(';')[0].trim().toLowerCase()
  if (MIME_TYPES[base]) return MIME_TYPES[base]
  if (base.startsWith('image/')) return base === 'image/svg+xml' ? null : 'image'
  if (base.startsWith('text/')) return 'text'
  return null
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false
  return true
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = ''
  for (let i = start; i < Math.min(end, bytes.length); i++) s += String.fromCharCode(bytes[i])
  return s
}

/** True for legacy OLE containers: old .doc files and password-protected Office files. */
export function isOleContainer(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
}

/** Sniff the first bytes of a file. Returns null when it doesn't recognise the signature. */
export function sniffKind(head: Uint8Array): FileKind | null {
  if (ascii(head, 0, 1024).includes('%PDF-')) return 'pdf'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return 'image'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image'
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'image'
  if (startsWith(head, [0x42, 0x4d]) && head.length > 26) return 'image'
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return 'image'
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return 'image'
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const zipHead = ascii(head, 0, 4096)
    if (zipHead.includes('mimetypeapplication/epub+zip') || zipHead.includes('META-INF/container.xml')) return 'epub'
    if (zipHead.includes('word/')) return 'docx'
    return null
  }
  const text = decodeText(head.subarray(0, 2048)).trimStart().slice(0, 1024).toLowerCase()
  if (/^(<!doctype html|<html[\s>]|<\?xml[^>]*>\s*<html)/.test(text)) return 'html'
  return null
}

/** Decide the importer for a file from its extension, MIME type and magic bytes (in that order of trust for text types). */
export function detectKind(file: File, head: Uint8Array): FileKind | null {
  const sniffed = sniffKind(head)
  // Binary signatures beat a misleading name (e.g. a PDF saved as ".txt").
  if (sniffed && sniffed !== 'html') return sniffed
  const byExt = EXTENSIONS[extensionOf(file.name)]
  if (byExt) return byExt
  const byMime = kindFromMime(file.type)
  if (byMime) return byMime
  if (sniffed) return sniffed
  // Unknown extension but it decodes as clean text: treat as text.
  if (head.length && looksLikeText(head)) return 'text'
  return null
}

function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096)
  let bad = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 0) return false
    if (b < 9 || (b > 13 && b < 32)) bad++
  }
  return bad / Math.max(1, n) < 0.02
}

// ---------------------------------------------------------------------------
// Text decoding
// ---------------------------------------------------------------------------

function tryDecode(bytes: Uint8Array, label: string, fatal: boolean): string | null {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/** Guess UTF-16 without a BOM: lots of zero bytes on one side of each pair. */
function guessUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length - (bytes.length % 2), 2000)
  if (n < 8) return null
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++
    if (bytes[i + 1] === 0) oddZero++
  }
  const pairs = n / 2
  if (oddZero / pairs > 0.4 && evenZero / pairs < 0.05) return 'utf-16le'
  if (evenZero / pairs > 0.4 && oddZero / pairs < 0.05) return 'utf-16be'
  return null
}

/**
 * Decode text bytes: honour BOMs (UTF-8, UTF-16 LE/BE), then a declared charset,
 * then strict UTF-8, falling back to Windows-1252 for legacy files.
 */
export function decodeText(bytes: Uint8Array, declaredCharset?: string | null): string {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return tryDecode(bytes.subarray(3), 'utf-8', false) ?? ''
  if (startsWith(bytes, [0xff, 0xfe])) return tryDecode(bytes.subarray(2), 'utf-16le', false) ?? ''
  if (startsWith(bytes, [0xfe, 0xff])) return tryDecode(bytes.subarray(2), 'utf-16be', false) ?? ''
  const utf16 = guessUtf16(bytes)
  if (utf16) return tryDecode(bytes, utf16, false) ?? ''
  if (declaredCharset && !/^utf-?8$/i.test(declaredCharset)) {
    const declared = tryDecode(bytes, declaredCharset, false)
    if (declared != null) return declared
  }
  return tryDecode(bytes, 'utf-8', true) ?? tryDecode(bytes, 'windows-1252', false) ?? tryDecode(bytes, 'utf-8', false) ?? ''
}

/** Charset from a Content-Type header value. */
export function charsetFromContentType(ct: string | null | undefined): string | null {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(ct || '')
  return m ? m[1] : null
}

/** Charset declared in an HTML document's <meta> tags (checked in the first 4 KB). */
export function charsetFromHtml(bytes: Uint8Array): string | null {
  const head = ascii(bytes, 0, 4096)
  const m = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)
  return m ? m[1] : null
}

/** Decode an HTML file, respecting <meta charset> when the bytes aren't valid UTF-8. */
export function decodeHtml(bytes: Uint8Array, headerCharset?: string | null): string {
  return decodeText(bytes, headerCharset || charsetFromHtml(bytes))
}

// ---------------------------------------------------------------------------
// Content heuristics
// ---------------------------------------------------------------------------

/** Does pasted/loaded text look like Markdown rather than plain prose? */
export function looksLikeMarkdown(text: string): boolean {
  const sample = text.length > 20000 ? text.slice(0, 20000) : text
  const lines = sample.split('\n')
  let headings = 0
  let lists = 0
  let quotes = 0
  let fences = 0
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) headings++
    else if (/^\s{0,3}([-*+]|\d{1,3}[.)])\s+\S/.test(line)) lists++
    else if (/^>\s?\S/.test(line)) quotes++
    else if (/^(```|~~~)/.test(line)) fences++
  }
  const bold = (sample.match(/(\*\*|__)[^\s*_][^*_\n]*?\1/g) || []).length
  const links = (sample.match(/\[[^\]\n]+\]\((https?:\/\/|\/|#|\.)[^)\s]*\)/g) || []).length
  const setext = (sample.match(/\n[^\n]+\n(={3,}|-{3,})\s*(\n|$)/g) || []).length
  let score = 0
  score += Math.min(headings, 3) * 2
  score += fences >= 2 ? 3 : 0
  score += Math.min(bold, 3)
  score += Math.min(links, 3)
  score += setext ? 2 : 0
  score += lists >= 2 ? 1 : 0
  score += quotes >= 1 ? 1 : 0
  return score >= 3 || (headings >= 1 && score >= 2)
}

/** Does this HTML look like a whole web page (with navigation etc.) rather than a snippet? */
export function looksLikeFullPage(doc: Document): boolean {
  const body = doc.body
  if (!body) return false
  if (body.querySelector('article, main, [role="main"]')) return true
  const chrome = body.querySelectorAll('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]').length
  if (chrome >= 2) return true
  const links = body.querySelectorAll('a[href]').length
  if (links < 15) return false
  let linkText = 0
  body.querySelectorAll('a[href]').forEach((a) => {
    linkText += (a.textContent || '').length
  })
  const total = (body.textContent || '').length
  return total > 0 && linkText / total > 0.25
}
