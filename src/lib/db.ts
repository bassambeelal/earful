import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DocContent, DocMeta } from '../types'

// Everything the user owns lives in this browser's IndexedDB. Nothing is uploaded.

export interface CachedAudio {
  key: string
  blob: Blob
  /** Optional exact word timings (seconds, spoken-text char offsets). */
  words?: Array<{ start: number; end: number; charStart: number; charEnd: number }>
  duration?: number
  size: number
  createdAt: number
  usedAt: number
}

interface EarfulDB extends DBSchema {
  docs: { key: string; value: DocMeta; indexes: { byOpened: number; byCreated: number } }
  content: { key: string; value: DocContent }
  audio: { key: string; value: CachedAudio; indexes: { byUsed: number } }
}

let dbPromise: Promise<IDBPDatabase<EarfulDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<EarfulDB>('earful', 1, {
      upgrade(d) {
        const docs = d.createObjectStore('docs', { keyPath: 'id' })
        docs.createIndex('byOpened', 'lastOpenedAt')
        docs.createIndex('byCreated', 'createdAt')
        d.createObjectStore('content', { keyPath: 'id' })
        const audio = d.createObjectStore('audio', { keyPath: 'key' })
        audio.createIndex('byUsed', 'usedAt')
      },
    })
    // Ask the browser not to evict our data (best effort).
    navigator.storage?.persist?.().catch(() => {})
  }
  return dbPromise
}

export async function listDocs(): Promise<DocMeta[]> {
  const all = await (await db()).getAll('docs')
  return all.sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
}

export async function getDoc(id: string): Promise<DocMeta | undefined> {
  return (await db()).get('docs', id)
}

export async function getContent(id: string): Promise<DocContent | undefined> {
  return (await db()).get('content', id)
}

export async function saveDoc(meta: DocMeta, content: DocContent): Promise<void> {
  const tx = (await db()).transaction(['docs', 'content'], 'readwrite')
  await Promise.all([tx.objectStore('docs').put(meta), tx.objectStore('content').put(content), tx.done])
}

export async function updateMeta(id: string, patch: Partial<DocMeta>): Promise<DocMeta | undefined> {
  const d = await db()
  const tx = d.transaction('docs', 'readwrite')
  const cur = await tx.store.get(id)
  if (!cur) {
    await tx.done
    return undefined
  }
  const next = { ...cur, ...patch, id }
  await tx.store.put(next)
  await tx.done
  return next
}

export async function deleteDoc(id: string): Promise<void> {
  const tx = (await db()).transaction(['docs', 'content'], 'readwrite')
  await Promise.all([tx.objectStore('docs').delete(id), tx.objectStore('content').delete(id), tx.done])
}

// ---------------------------------------------------------------------------
// Library backup
// ---------------------------------------------------------------------------

export interface LibraryBackup {
  app: 'earful'
  version: 1
  exportedAt: number
  docs: Array<{ meta: DocMeta; content: DocContent }>
}

export async function exportLibrary(): Promise<LibraryBackup> {
  const d = await db()
  const metas = await d.getAll('docs')
  const docs = []
  for (const meta of metas) {
    const content = await d.get('content', meta.id)
    if (content) docs.push({ meta, content })
  }
  return { app: 'earful', version: 1, exportedAt: Date.now(), docs }
}

/** Imports a backup. Existing docs with the same id are overwritten. Returns number imported. */
export async function importLibrary(data: unknown): Promise<number> {
  const b = data as LibraryBackup
  if (!b || b.app !== 'earful' || !Array.isArray(b.docs)) throw new Error('This file is not an Earful library backup.')
  let n = 0
  for (const item of b.docs) {
    if (!item?.meta?.id || !Array.isArray(item?.content?.blocks)) continue
    await saveDoc({ ...item.meta, tags: item.meta.tags ?? [] }, { ...item.content, id: item.meta.id, chapters: item.content.chapters ?? [] })
    n++
  }
  return n
}

export async function clearAll(): Promise<void> {
  const d = await db()
  const tx = d.transaction(['docs', 'content', 'audio'], 'readwrite')
  await Promise.all([tx.objectStore('docs').clear(), tx.objectStore('content').clear(), tx.objectStore('audio').clear(), tx.done])
}

// ---------------------------------------------------------------------------
// TTS audio cache — so a paid (BYOK) voice never costs twice for the same sentence.
// ---------------------------------------------------------------------------

const AUDIO_CACHE_LIMIT = 300 * 1024 * 1024 // bytes

export async function getCachedAudio(key: string): Promise<CachedAudio | undefined> {
  const d = await db()
  const hit = await d.get('audio', key)
  if (hit) {
    hit.usedAt = Date.now()
    d.put('audio', hit).catch(() => {})
  }
  return hit
}

export async function putCachedAudio(entry: Omit<CachedAudio, 'size' | 'createdAt' | 'usedAt'>): Promise<void> {
  const d = await db()
  const now = Date.now()
  await d.put('audio', { ...entry, size: entry.blob.size, createdAt: now, usedAt: now })
  pruneAudioCache().catch(() => {})
}

let pruning = false
async function pruneAudioCache() {
  if (pruning) return
  pruning = true
  try {
    const d = await db()
    const all = await d.getAllFromIndex('audio', 'byUsed')
    let total = all.reduce((s, a) => s + a.size, 0)
    for (const a of all) {
      if (total <= AUDIO_CACHE_LIMIT) break
      await d.delete('audio', a.key)
      total -= a.size
    }
  } finally {
    pruning = false
  }
}

export async function audioCacheSize(): Promise<number> {
  const all = await (await db()).getAll('audio')
  return all.reduce((s, a) => s + a.size, 0)
}

export async function clearAudioCache(): Promise<void> {
  await (await db()).clear('audio')
}

/** SHA-256 hex of a string — used to build audio cache keys. */
export async function hashKey(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}
