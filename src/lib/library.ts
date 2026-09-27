import { create } from 'zustand'
import type { DocContent, DocMeta, ImportedDoc } from '../types'
import * as db from './db'
import { countWords, segmentBlocks, uid, type Sentence } from './text'

// Library + currently open document. Sentences are derived once per open.

export interface OpenDoc {
  meta: DocMeta
  content: DocContent
  sentences: Sentence[]
  /** Block index -> first sentence index in that block (or -1 if the block has no sentences). */
  blockFirstSentence: number[]
  /** Sentence index where each chapter starts (sorted). */
  chapterStarts: number[]
}

interface LibraryState {
  docs: DocMeta[]
  loaded: boolean
  open: OpenDoc | null
  openError: string | null
  refresh(): Promise<void>
  /** Save an imported document. Returns the new id. */
  add(imported: ImportedDoc): Promise<string>
  remove(id: string): Promise<void>
  rename(id: string, title: string): Promise<void>
  /** Load a doc's content + sentences into `open`. */
  openDoc(id: string): Promise<OpenDoc | null>
  closeDoc(): void
  /** Persist reading position (throttled internally). */
  savePosition(id: string, sentence: number): void
}

function hueFor(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

export function buildOpenDoc(meta: DocMeta, content: DocContent): OpenDoc {
  const sentences = segmentBlocks(content.blocks, meta.lang?.split('-')[0] || 'en')
  const blockFirstSentence = new Array<number>(content.blocks.length).fill(-1)
  for (const s of sentences) if (blockFirstSentence[s.block] === -1) blockFirstSentence[s.block] = s.index
  const chapterStarts: number[] = []
  for (const ch of content.chapters) {
    // First sentence at or after the chapter's block.
    for (let b = ch.block; b < blockFirstSentence.length; b++) {
      if (blockFirstSentence[b] >= 0) {
        chapterStarts.push(blockFirstSentence[b])
        break
      }
    }
  }
  chapterStarts.sort((a, b) => a - b)
  return { meta, content, sentences, blockFirstSentence, chapterStarts: [...new Set(chapterStarts)] }
}

const pendingPositions = new Map<string, number>()
let positionTimer: ReturnType<typeof setTimeout> | null = null

async function flushPositions() {
  positionTimer = null
  const entries = [...pendingPositions.entries()]
  pendingPositions.clear()
  for (const [id, position] of entries) {
    const updated = await db.updateMeta(id, { position, lastOpenedAt: Date.now() })
    if (updated) {
      useLibrary.setState((s) => ({
        docs: s.docs.map((d) => (d.id === id ? updated : d)),
        open: s.open && s.open.meta.id === id ? { ...s.open, meta: updated } : s.open,
      }))
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (pendingPositions.size) void flushPositions()
  })
}

export const useLibrary = create<LibraryState>()((set, get) => ({
  docs: [],
  loaded: false,
  open: null,
  openError: null,

  async refresh() {
    const docs = await db.listDocs()
    set({ docs, loaded: true })
  },

  async add(imported) {
    const id = uid()
    const now = Date.now()
    const blocks = imported.blocks.filter((b) => b.text && b.text.trim())
    if (!blocks.length) throw new Error('No readable text was found in this document.')
    const chapters = imported.chapters.filter((c) => c.block >= 0 && c.block < blocks.length)
    const content: DocContent = { id, blocks, chapters }
    const sentences = segmentBlocks(blocks, imported.lang?.split('-')[0] || 'en')
    const allText = blocks.map((b) => b.text).join(' ')
    const meta: DocMeta = {
      id,
      title: imported.title?.trim() || 'Untitled',
      author: imported.author,
      source: imported.source,
      fileName: imported.fileName,
      lang: imported.lang,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      position: 0,
      totalSentences: sentences.length,
      wordCount: countWords(allText),
      charCount: allText.length,
      tags: [],
      hue: hueFor(id + imported.title),
    }
    await db.saveDoc(meta, content)
    set((s) => ({ docs: [meta, ...s.docs] }))
    return id
  },

  async remove(id) {
    pendingPositions.delete(id)
    await db.deleteDoc(id)
    set((s) => ({ docs: s.docs.filter((d) => d.id !== id), open: s.open?.meta.id === id ? null : s.open }))
  },

  async rename(id, title) {
    const updated = await db.updateMeta(id, { title: title.trim() || 'Untitled', updatedAt: Date.now() })
    if (!updated) return
    set((s) => ({
      docs: s.docs.map((d) => (d.id === id ? updated : d)),
      open: s.open?.meta.id === id ? { ...s.open, meta: updated } : s.open,
    }))
  },

  async openDoc(id) {
    const cur = get().open
    if (cur?.meta.id === id) return cur
    set({ openError: null })
    const [meta, content] = await Promise.all([db.getDoc(id), db.getContent(id)])
    if (!meta || !content) {
      set({ open: null, openError: 'This document is no longer in your library.' })
      return null
    }
    const touched = { ...meta, lastOpenedAt: Date.now() }
    db.updateMeta(id, { lastOpenedAt: touched.lastOpenedAt }).catch(() => {})
    const open = buildOpenDoc(touched, content)
    set((s) => ({ open, docs: s.docs.map((d) => (d.id === id ? touched : d)) }))
    return open
  },

  closeDoc() {
    set({ open: null })
  },

  savePosition(id, sentence) {
    pendingPositions.set(id, sentence)
    // Reflect immediately in memory so progress bars update.
    set((s) => ({
      open: s.open && s.open.meta.id === id ? { ...s.open, meta: { ...s.open.meta, position: sentence } } : s.open,
    }))
    if (!positionTimer) positionTimer = setTimeout(flushPositions, 1500)
  },
}))
