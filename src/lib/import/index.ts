// CONTRACT STUB — replaced by the import module implementation.
import type { ImportedDoc } from '../../types'

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
export declare const ACCEPTED_FILE_TYPES: string

/** Import any supported file (PDF, EPUB, DOCX, TXT, MD, HTML, images). Throws Error with a friendly message on failure. */
export declare function importFile(file: File, opts?: ImportOptions): Promise<ImportedDoc>

/** Import pasted plain text or Markdown. Title is derived from first line if not given. */
export declare function importText(text: string, title?: string): ImportedDoc

/** Import pasted/clipboard HTML (sanitised, main article extracted with Readability). */
export declare function importHtml(html: string, opts?: { title?: string; url?: string }): ImportedDoc

/** Try to fetch and import a web page. Most sites block this (CORS); throws a friendly Error suggesting paste instead. */
export declare function importUrl(url: string, opts?: ImportOptions): Promise<ImportedDoc>
