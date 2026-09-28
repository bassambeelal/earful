import { create } from 'zustand'
import type { ImportedDoc } from '../types'
import { importFile, importText, importUrl, type ImportProgress } from './import'
import { useLibrary } from './library'
import { getSettings, useSettings } from './settings'
import { openReader, replaceRoute } from './router'
import { sampleDoc } from './sample'
import { errorMessage, isAbort } from './ui-format'
import { dismissToast, toast } from '../components/ui'

// Import flows shared by the library, the paste dialog, drag-and-drop and the share target.

interface ImportState {
  active: boolean
  fileName: string
  /** 1-based index of the file being imported, and how many there are. */
  index: number
  count: number
  progress: ImportProgress | null
  controller: AbortController | null
}

export const useImportState = create<ImportState>(() => ({
  active: false,
  fileName: '',
  index: 0,
  count: 0,
  progress: null,
  controller: null,
}))

export function cancelImport() {
  useImportState.getState().controller?.abort()
}

function showWarnings(doc: ImportedDoc) {
  for (const w of (doc.warnings ?? []).slice(0, 2)) toast(w, { duration: 6000 })
}

/** Save an imported doc; optionally open it in the reader. Returns the new id. */
export async function addDoc(doc: ImportedDoc, opts: { open?: boolean } = {}): Promise<string> {
  const id = await useLibrary.getState().add(doc)
  showWarnings(doc)
  if (opts.open) openReader(id)
  return id
}

/** Import files one after another. A single file opens straight away; several stay in the library. */
export async function importFiles(files: File[]): Promise<void> {
  if (!files.length) return
  if (useImportState.getState().active) {
    toast('Please wait for the current import to finish.')
    return
  }
  const controller = new AbortController()
  const added: string[] = []
  useImportState.setState({ active: true, controller, count: files.length, index: 0, fileName: '', progress: null })
  try {
    for (let i = 0; i < files.length; i++) {
      if (controller.signal.aborted) break
      const file = files[i]
      useImportState.setState({ index: i + 1, fileName: file.name, progress: { label: 'Opening…', value: null } })
      try {
        const doc = await importFile(file, {
          signal: controller.signal,
          onProgress: (progress) => useImportState.setState({ progress }),
        })
        if (controller.signal.aborted) break
        added.push(await addDoc(doc))
      } catch (e) {
        if (isAbort(e) || controller.signal.aborted) break
        toast.error(files.length > 1 ? `${file.name}: ${errorMessage(e)}` : errorMessage(e))
      }
    }
  } finally {
    useImportState.setState({ active: false, controller: null, progress: null })
  }
  if (controller.signal.aborted) {
    toast(added.length ? `Import stopped. ${added.length} added.` : 'Import cancelled.')
    return
  }
  if (files.length === 1 && added.length === 1) openReader(added[0])
  else if (added.length > 1) toast(`Added ${added.length} documents to your library.`)
}

/** Add the welcome guide (or open the existing copy). */
export async function openSample(): Promise<void> {
  const existing = useLibrary.getState().docs.find((d) => d.source === 'sample')
  if (existing) {
    openReader(existing.id)
    return
  }
  try {
    await addDoc(sampleDoc(), { open: true })
  } catch (e) {
    toast.error(errorMessage(e))
  }
}

let startupRan = false

/** First-run setup + PWA share target. Safe to call more than once. */
export async function runStartup(): Promise<void> {
  if (startupRan) return
  startupRan = true
  try {
    await useLibrary.getState().refresh()
  } catch {
    toast.error('Your library could not be opened. Private browsing can block storage — try a normal window.')
    return
  }
  if (!getSettings().onboarded) {
    try {
      if (!useLibrary.getState().docs.some((d) => d.source === 'sample')) await useLibrary.getState().add(sampleDoc())
    } catch {
      /* not fatal: the empty state offers the guide */
    }
    useSettings.getState().set({ onboarded: true })
  }
  await handleShareTarget()
}

/** The installed app can receive shared text/links (manifest share_target, GET ?title&text&url). */
async function handleShareTarget(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const title = params.get('title')?.trim() || ''
  const text = params.get('text')?.trim() || ''
  let url = params.get('url')?.trim() || ''
  if (!title && !text && !url) return

  // Strip the query so a reload doesn't import again.
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.hash || '#/'}`)

  // Some apps put the link inside `text`.
  if (!url && /^https?:\/\/\S+$/.test(text)) url = text
  const body = text && text !== url ? text : ''

  try {
    let doc: ImportedDoc
    if (body) {
      doc = importText(url ? `${body}\n\n${url}` : body, title || undefined)
    } else if (url) {
      const loading = toast('Fetching the shared page…', { duration: 0 })
      try {
        doc = await importUrl(url)
        if (title && !doc.title) doc.title = title
      } catch {
        doc = importText(
          [
            title || 'Shared link',
            url,
            'This website does not allow Earful to fetch the page directly.',
            'To listen to it, open the link, select the article text, copy it, then choose Import and Paste text in Earful.',
          ].join('\n\n'),
          title || 'Shared link',
        )
      } finally {
        dismissToast(loading)
      }
    } else {
      doc = importText(title, title)
    }
    const id = await addDoc(doc)
    replaceRoute(`#/read/${encodeURIComponent(id)}`)
  } catch (e) {
    toast.error(errorMessage(e, 'The shared content could not be imported.'))
  }
}
