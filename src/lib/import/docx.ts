import type { ImportedDoc } from '../../types'
import { isOleContainer } from './detect'
import { BlockWriter, parseSanitized } from './html'
import { finalizeDoc, interopDefault, meaningfulAuthor, throwIfAborted } from './util'

// Word .docx via mammoth (lazy-loaded).

const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => p:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  // Table-of-contents entries ("Introduction ........ 3") are noise when listening.
  "p[style-name^='TOC'] => !",
]

interface CoreProps {
  title?: string
  creator?: string
  language?: string
}

async function readCoreProps(buffer: ArrayBuffer): Promise<CoreProps> {
  const JSZip = interopDefault(await import('jszip'))
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('docProps/core.xml')?.async('string')
  if (!xml) return {}
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const get = (name: string) => doc.getElementsByTagNameNS('*', name)[0]?.textContent?.trim() || undefined
  return { title: get('title'), creator: get('creator'), language: get('language') }
}

export async function importDocx(
  buffer: ArrayBuffer,
  fileName: string | undefined,
  report: (label: string, value?: number | null) => void,
  signal?: AbortSignal,
): Promise<ImportedDoc> {
  if (isOleContainer(new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength)))) {
    throw new Error(
      'This Word file is password-protected or uses the old .doc format. Open it in Word or Google Docs, save it as a .docx without a password, and try again.',
    )
  }
  report('Reading document…')
  const mammoth = interopDefault(await import('mammoth'))
  throwIfAborted(signal)
  let html: string
  try {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      {
        styleMap: STYLE_MAP,
        ignoreEmptyParagraphs: true,
        // Skip image decoding entirely: pictures aren't read aloud.
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
      },
    )
    html = result.value
  } catch {
    throw new Error("This Word document couldn't be opened. It may be damaged, or it may not be a real .docx file.")
  }
  throwIfAborted(signal)
  const props = await readCoreProps(buffer).catch((): CoreProps => ({}))
  throwIfAborted(signal)

  const doc = parseSanitized(html)
  const w = new BlockWriter('book')
  if (doc.body) w.write(doc.body)
  return finalizeDoc({
    source: 'docx',
    blocks: w.blocks,
    titles: [props.title],
    fileName,
    author: meaningfulAuthor(props.creator),
    lang: props.language,
  })
}
