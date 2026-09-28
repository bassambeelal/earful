import type { DocMeta, SourceKind } from '../types'
import { estimateSeconds, formatDuration } from './text'

// Small formatting helpers for the UI.

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ')

const SOURCE_LABELS: Record<SourceKind, string> = {
  pdf: 'PDF',
  epub: 'EPUB',
  docx: 'Word',
  text: 'Text',
  markdown: 'Markdown',
  html: 'Web page',
  image: 'Photo',
  paste: 'Pasted',
  sample: 'Guide',
  ai: 'AI',
}

export const sourceLabel = (s: SourceKind) => SOURCE_LABELS[s] ?? 'Document'

/** 0..1 reading progress. */
export function progressOf(meta: Pick<DocMeta, 'position' | 'totalSentences'>): number {
  if (!meta.totalSentences || meta.totalSentences <= 1) return meta.position > 0 ? 1 : 0
  return Math.max(0, Math.min(1, meta.position / (meta.totalSentences - 1)))
}

export function isFinished(meta: DocMeta): boolean {
  return meta.totalSentences > 0 && meta.position >= meta.totalSentences - 1 && meta.position > 0
}

/** "12 min left", "Finished" or the full listening time for unstarted docs. */
export function timeLeftLabel(meta: DocMeta, rate: number): string {
  if (isFinished(meta)) return 'Finished'
  const p = progressOf(meta)
  const secs = estimateSeconds(meta.wordCount * (1 - p), rate)
  if (p === 0) return formatDuration(secs)
  return `${formatDuration(secs)} left`
}

export function formatWords(n: number): string {
  if (n < 1000) return `${n} words`
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k words`
  return `${Math.round(n / 1000)}k words`
}

export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}

export function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 MB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** mm:ss or h:mm:ss countdown. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** A file name that is safe on every OS. */
export function safeFileName(name: string, fallback = 'Earful'): string {
  const cleaned = name
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim()
  return cleaned || fallback
}

const displayNames = new Map<string, Intl.DisplayNames | null>()

/** "en-US" -> "English (United States)". */
export function languageName(tag: string | undefined): string {
  if (!tag) return 'Other'
  const ui = navigator.language || 'en'
  let dn = displayNames.get(ui)
  if (dn === undefined) {
    try {
      dn = new Intl.DisplayNames([ui, 'en'], { type: 'language' })
    } catch {
      dn = null
    }
    displayNames.set(ui, dn)
  }
  try {
    return dn?.of(tag) ?? tag
  } catch {
    return tag
  }
}

/** Case- and accent-insensitive search key. */
export function searchKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
}

export function errorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  return fallback
}

export function isAbort(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError'
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function isTouchDevice(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false
}
