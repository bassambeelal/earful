// Core document model shared by every module.
// A document is a flat list of blocks (headings, paragraphs, ...). Sentences are
// derived at runtime from blocks by `segmentBlocks` in lib/text.ts and are never stored.

export type SourceKind =
  | 'pdf'
  | 'epub'
  | 'docx'
  | 'text'
  | 'markdown'
  | 'html'
  | 'image'
  | 'paste'
  | 'sample'
  | 'ai'

export type BlockType = 'heading' | 'paragraph' | 'quote' | 'list-item' | 'code'

export interface Block {
  type: BlockType
  /** Plain display text. No markup. Single spaces, no leading/trailing whitespace. */
  text: string
  /** Heading level 1-6 (headings only). */
  level?: number
  /** 1-based source page (PDF/images) when known. */
  page?: number
}

export interface Chapter {
  title: string
  /** Index into DocContent.blocks where this chapter starts. */
  block: number
}

/** What an importer returns. The library turns it into DocMeta + DocContent. */
export interface ImportedDoc {
  title: string
  author?: string
  source: SourceKind
  fileName?: string
  /** BCP-47 language tag if detected/declared (e.g. "en", "fr"). */
  lang?: string
  blocks: Block[]
  chapters: Chapter[]
  /** Non-fatal notes to show the user (e.g. "3 pages were scanned with OCR"). */
  warnings?: string[]
}

export interface DocMeta {
  id: string
  title: string
  author?: string
  source: SourceKind
  fileName?: string
  lang?: string
  createdAt: number
  updatedAt: number
  lastOpenedAt?: number
  /** Current reading position (global sentence index). */
  position: number
  totalSentences: number
  wordCount: number
  charCount: number
  tags: string[]
  /** 0-359, used for the generated cover color. */
  hue: number
}

export interface DocContent {
  id: string
  blocks: Block[]
  chapters: Chapter[]
}
