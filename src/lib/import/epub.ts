import type JSZip from 'jszip'
import type { Chapter, ImportedDoc } from '../../types'
import { decodeText } from './detect'
import { BlockWriter } from './html'
import { chaptersFromHeadings, finalizeDoc, interopDefault, meaningfulAuthor, throwIfAborted, tidy, yieldToMain } from './util'

// EPUB 2/3 via JSZip (lazy-loaded): container.xml -> OPF -> spine XHTML -> blocks; chapters from nav/NCX.

const OPS_NS = 'http://www.idpf.org/2007/ops'
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'])
const HTML_TYPES = new Set(['application/xhtml+xml', 'text/html', 'application/html'])

interface ManifestItem {
  id: string
  path: string
  mediaType: string
  properties: string
}

interface TocEntry {
  title: string
  path: string
  frag: string
  depth: number
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i + 1) : ''
}

/** Resolve `href` relative to the file at `basePath` inside the zip. External links resolve to ''. */
function resolveHref(basePath: string, href: string): { path: string; frag: string } {
  const hash = href.indexOf('#')
  const rawPath = hash >= 0 ? href.slice(0, hash) : href
  const frag = hash >= 0 ? safeDecode(href.slice(hash + 1)) : ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath)) return { path: '', frag: '' }
  if (!rawPath) return { path: basePath, frag }
  const rel = safeDecode(rawPath)
  const joined = rel.startsWith('/') ? rel.slice(1) : dirname(basePath) + rel
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return { path: out.join('/'), frag }
}

function hasParserError(doc: Document): boolean {
  return doc.getElementsByTagName('parsererror').length > 0 || doc.getElementsByTagNameNS('*', 'parsererror').length > 0
}

function parseXml(text: string): Document | null {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml')
  return hasParserError(doc) ? null : doc
}

/** XHTML first (keeps namespaces/epub:type); lenient HTML parsing when the XML is malformed (e.g. &nbsp;). */
function parseXhtml(text: string): Document {
  const clean = text.replace(/^﻿/, '')
  const doc = new DOMParser().parseFromString(clean, 'application/xhtml+xml')
  if (!hasParserError(doc)) return doc
  return new DOMParser().parseFromString(clean, 'text/html')
}

function byTag(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name))
}

function childElements(el: Element, name: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName.toLowerCase() === name)
}

class ZipReader {
  private readonly zip: JSZip
  private readonly lower = new Map<string, string>()

  constructor(zip: JSZip) {
    this.zip = zip
    zip.forEach((relPath) => this.lower.set(relPath.toLowerCase(), relPath))
  }

  entry(path: string): JSZip.JSZipObject | null {
    if (!path) return null
    const caseFolded = this.lower.get(path.toLowerCase())
    return this.zip.file(path) || (caseFolded ? this.zip.file(caseFolded) : null) || this.zip.file(encodeURI(path)) || null
  }

  async text(path: string): Promise<string | null> {
    const e = this.entry(path)
    if (!e) return null
    return decodeText(await e.async('uint8array'))
  }
}

async function assertNotDrm(zip: ZipReader): Promise<void> {
  const xml = await zip.text('META-INF/encryption.xml')
  if (!xml) return
  const doc = parseXml(xml)
  if (!doc) return
  for (const data of byTag(doc, 'EncryptedData')) {
    const algo = byTag(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm') || ''
    if (!FONT_OBFUSCATION.has(algo)) {
      throw new Error("This book is protected with DRM, so it can't be read. Try a DRM-free copy of the EPUB.")
    }
  }
}

function tocFromNav(nav: Document, navPath: string): TocEntry[] {
  const navs = Array.from(nav.getElementsByTagNameNS('*', 'nav'))
  const typeOf = (el: Element) => ((el.getAttribute('epub:type') || el.getAttributeNS(OPS_NS, 'type') || '') + ' ' + (el.getAttribute('role') || '')).toLowerCase()
  const toc = navs.find((n) => /\b(doc-)?toc\b/.test(typeOf(n))) ?? navs[0]
  if (!toc) return []
  const out: TocEntry[] = []
  const walkList = (ol: Element, depth: number) => {
    for (const li of childElements(ol, 'li')) {
      const label = Array.from(li.children).find((c) => /^(a|span)$/i.test(c.localName))
      const href = label?.localName.toLowerCase() === 'a' ? label.getAttribute('href') : null
      const title = tidy(label?.textContent || '')
      if (href && title) {
        const { path, frag } = resolveHref(navPath, href)
        if (path) out.push({ title, path, frag, depth })
      }
      for (const sub of childElements(li, 'ol')) walkList(sub, depth + 1)
    }
  }
  for (const ol of childElements(toc, 'ol')) walkList(ol, 0)
  return out
}

function tocFromNcx(ncx: Document, ncxPath: string): TocEntry[] {
  const navMap = byTag(ncx, 'navMap')[0]
  if (!navMap) return []
  const out: TocEntry[] = []
  const walk = (parent: Element, depth: number) => {
    for (const point of childElements(parent, 'navpoint')) {
      const label = byTag(point, 'navLabel')[0]
      const title = tidy(label ? byTag(label, 'text')[0]?.textContent || label.textContent || '' : '')
      const src = byTag(point, 'content')[0]?.getAttribute('src')
      if (src && title) {
        const { path, frag } = resolveHref(ncxPath, src)
        if (path) out.push({ title, path, frag, depth })
      }
      walk(point, depth + 1)
    }
  }
  walk(navMap, 0)
  return out
}

/** Keep the top TOC levels: two by default, three when the first level is a single wrapper entry. */
function pruneToc(entries: TocEntry[]): TocEntry[] {
  const count = (d: number) => entries.filter((e) => e.depth <= d).length
  let maxDepth = count(0) <= 1 ? 2 : 1
  while (maxDepth > 0 && count(maxDepth) > 150) maxDepth--
  return entries.filter((e) => e.depth <= maxDepth)
}

export async function importEpub(
  buffer: ArrayBuffer,
  fileName: string | undefined,
  report: (label: string, value?: number | null) => void,
  signal?: AbortSignal,
): Promise<ImportedDoc> {
  report('Opening book…')
  const JSZipCtor = interopDefault(await import('jszip'))
  let zip: ZipReader
  try {
    zip = new ZipReader(await JSZipCtor.loadAsync(buffer))
  } catch {
    throw new Error("This EPUB couldn't be opened. The file may be damaged or incomplete.")
  }
  throwIfAborted(signal)
  await assertNotDrm(zip)

  const containerXml = await zip.text('META-INF/container.xml')
  const container = containerXml ? parseXml(containerXml) : null
  const rootfiles = container ? byTag(container, 'rootfile') : []
  const opfPath =
    (rootfiles.find((r) => (r.getAttribute('media-type') || '') === 'application/oebps-package+xml') ?? rootfiles[0])?.getAttribute('full-path') ||
    ''
  const opfText = opfPath ? await zip.text(safeDecode(opfPath)) : null
  const opf = opfText ? parseXml(opfText) : null
  if (!opf) throw new Error("This EPUB is missing its table of contents file (OPF), so it can't be read.")
  const opfFile = safeDecode(opfPath)

  // Metadata
  const title = byTag(opf, 'title')[0]?.textContent || ''
  const creators = byTag(opf, 'creator')
    .map((c) => tidy(c.textContent || ''))
    .filter(Boolean)
  const author = meaningfulAuthor(creators.slice(0, 3).join(', '))
  const lang = byTag(opf, 'language')[0]?.textContent?.trim()

  // Manifest + spine
  const manifest = new Map<string, ManifestItem>()
  for (const item of byTag(opf, 'item')) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (!id || !href) continue
    manifest.set(id, {
      id,
      path: resolveHref(opfFile, href).path,
      mediaType: (item.getAttribute('media-type') || '').toLowerCase(),
      properties: item.getAttribute('properties') || '',
    })
  }
  const spineEl = byTag(opf, 'spine')[0]
  const spine: ManifestItem[] = []
  for (const ref of spineEl ? byTag(spineEl, 'itemref') : []) {
    if (ref.getAttribute('linear') === 'no') continue
    const item = manifest.get(ref.getAttribute('idref') || '')
    if (item && (HTML_TYPES.has(item.mediaType) || /\.x?html?$/i.test(item.path))) spine.push(item)
  }
  if (!spine.length) throw new Error("This EPUB doesn't list any readable chapters.")

  // Table of contents (EPUB 3 nav, else EPUB 2 NCX). Failures here are not fatal.
  let toc: TocEntry[] = []
  try {
    const navItem = [...manifest.values()].find((m) => /\bnav\b/.test(m.properties))
    const navText = navItem ? await zip.text(navItem.path) : null
    if (navText && navItem) toc = tocFromNav(parseXhtml(navText), navItem.path)
    if (!toc.length) {
      const ncxItem = manifest.get(spineEl?.getAttribute('toc') || '') ?? [...manifest.values()].find((m) => m.mediaType === 'application/x-dtbncx+xml')
      const ncxText = ncxItem ? await zip.text(ncxItem.path) : null
      const ncx = ncxText ? parseXml(ncxText) : null
      if (ncx && ncxItem) toc = tocFromNcx(ncx, ncxItem.path)
    }
  } catch {
    toc = []
  }

  // Spine content
  const w = new BlockWriter('book')
  const itemStart = new Map<string, number>()
  const headingChapters: Chapter[] = []
  for (let i = 0; i < spine.length; i++) {
    throwIfAborted(signal)
    report(`Reading chapter ${i + 1} of ${spine.length}`, i / spine.length)
    const item = spine[i]
    const text = await zip.text(item.path)
    if (text == null) continue
    const doc = parseXhtml(text)
    const body = doc.body ?? doc.getElementsByTagNameNS('*', 'body')[0] ?? doc.documentElement
    const start = w.blocks.length
    if (!itemStart.has(item.path)) itemStart.set(item.path, start)
    if (body) w.write(body, { idPrefix: item.path + '#' })
    for (let b = start; b < w.blocks.length; b++) {
      if (w.blocks[b].type === 'heading') {
        headingChapters.push({ title: w.blocks[b].text, block: b })
        break
      }
    }
    await yieldToMain()
  }

  let chapters: Chapter[] = []
  for (const e of pruneToc(toc)) {
    const start = itemStart.get(e.path)
    if (start == null) continue
    const block = (e.frag ? w.ids.get(`${e.path}#${e.frag}`) : undefined) ?? start
    chapters.push({ title: e.title, block })
  }
  if (new Set(chapters.map((c) => c.block)).size <= 1) {
    chapters = headingChapters.length > 1 ? headingChapters : chaptersFromHeadings(w.blocks)
  }

  return finalizeDoc({ source: 'epub', blocks: w.blocks, chapters, titles: [title], fileName, author, lang })
}
