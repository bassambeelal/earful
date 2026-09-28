import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Download, Trash2, Upload } from 'lucide-react'
import { Button, Callout, toast } from '../ui'
import { SetGroup } from './parts'
import { audioCacheSize, clearAll, clearAudioCache, exportLibrary, importLibrary } from '../../lib/db'
import { useLibrary } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { useSettings } from '../../lib/settings'
import { deleteKokoroCache } from '../../lib/tts/kokoro'
import { errorMessage, formatBytes } from '../../lib/ui-format'

const pad = (n: number) => String(n).padStart(2, '0')

/** Local date as YYYY-MM-DD. */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function removeEarfulKeys(storage: Storage) {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k?.startsWith('earful:')) keys.push(k)
  }
  keys.forEach((k) => storage.removeItem(k))
}

export function DataTab() {
  const docCount = useLibrary((s) => s.docs.length)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cacheSize, setCacheSize] = useState<number | null>(null)
  const [clearing, setClearing] = useState(false)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [wiping, setWiping] = useState(false)
  const cancelWipeRef = useRef<HTMLButtonElement>(null)

  const refreshSizes = useCallback(() => {
    audioCacheSize()
      .then(setCacheSize)
      .catch(() => setCacheSize(null))
    navigator.storage
      ?.estimate?.()
      .then((e) => setStorage(e.usage !== undefined && e.quota ? { usage: e.usage, quota: e.quota } : null))
      .catch(() => setStorage(null))
  }, [])

  useEffect(() => {
    refreshSizes()
  }, [refreshSizes])

  useEffect(() => {
    if (confirmWipe) cancelWipeRef.current?.focus()
  }, [confirmWipe])

  const saveBackup = async () => {
    setExporting(true)
    try {
      const backup = await exportLibrary()
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' })
      const { downloadBlob } = await import('../../lib/export/audio')
      downloadBlob(blob, `earful-library-${today()}.json`)
      const n = backup.docs.length
      toast(n ? `Saved a backup of ${n} document${n === 1 ? '' : 's'}.` : 'Your library is empty, but the backup file was saved.')
    } catch (e) {
      toast.error(errorMessage(e, 'The backup could not be created. Please try again.'))
    } finally {
      setExporting(false)
    }
  }

  const restore = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImporting(true)
    try {
      let data: unknown
      try {
        data = JSON.parse(await file.text())
      } catch {
        throw new Error('This file isn’t an Earful library backup. Choose the .json file you saved from Earful.')
      }
      const n = await importLibrary(data)
      await useLibrary.getState().refresh()
      toast(n ? `Restored ${n} document${n === 1 ? '' : 's'} from the backup.` : 'That backup has no documents in it.')
    } catch (err) {
      toast.error(errorMessage(err, 'The backup could not be restored.'))
    } finally {
      setImporting(false)
      refreshSizes()
    }
  }

  const clearCache = async () => {
    setClearing(true)
    try {
      await clearAudioCache()
      toast('Saved audio cleared.')
    } catch (e) {
      toast.error(errorMessage(e, 'The saved audio could not be cleared.'))
    } finally {
      setClearing(false)
      refreshSizes()
    }
  }

  const wipe = async () => {
    setWiping(true)
    try {
      try {
        usePlayer.getState().unload()
      } catch {
        /* nothing was playing */
      }
      useLibrary.getState().closeDoc()
      await clearAll()
      await deleteKokoroCache().catch(() => {
        /* best effort: the browser may block it */
      })
      useSettings.getState().reset()
      try {
        removeEarfulKeys(localStorage)
        removeEarfulKeys(sessionStorage)
      } catch {
        /* storage may be blocked */
      }
      // Start over on the library page with a fresh app.
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`)
      window.location.reload()
    } catch (e) {
      toast.error(errorMessage(e, 'Not everything could be deleted. Please try again.'))
      setWiping(false)
    }
  }

  return (
    <>
      <SetGroup
        id="settings-backup"
        title="Back up your library"
        description="Everything you add is stored only in this browser. Save a backup file to keep your documents safe or to move them to another device."
      >
        <div className="set-actions">
          <Button size="sm" icon={<Download />} loading={exporting} onClick={() => void saveBackup()}>
            Save a backup
          </Button>
          <Button size="sm" icon={<Upload />} loading={importing} onClick={() => fileRef.current?.click()}>
            Restore from a backup
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            aria-hidden
            tabIndex={-1}
            onChange={(e) => void restore(e)}
          />
        </div>
        <p className="set-muted">
          {docCount === 1 ? '1 document' : `${docCount} documents`} in your library. The backup includes your documents and reading positions, but not
          settings or API keys. Restoring adds the backup’s documents; if one is already here, the backup’s copy replaces it.
        </p>
      </SetGroup>

      <SetGroup
        id="settings-storage"
        title="Storage"
        description="Audio from premium voices is saved on this device so replaying a sentence never costs twice. Older audio is removed automatically when it passes 300 MB."
      >
        <dl className="set-kv">
          <div>
            <dt>Saved audio</dt>
            <dd>{cacheSize === null ? '…' : cacheSize > 0 ? formatBytes(cacheSize) : 'None'}</dd>
          </div>
          {storage && (
            <div>
              <dt>Total used by Earful</dt>
              <dd>
                {formatBytes(storage.usage)} <span className="set-muted">of {formatBytes(storage.quota)} available</span>
              </dd>
            </div>
          )}
        </dl>
        <div className="set-actions">
          <Button size="sm" icon={<Trash2 />} loading={clearing} disabled={!cacheSize} onClick={() => void clearCache()}>
            Clear saved audio
          </Button>
        </div>
      </SetGroup>

      <SetGroup id="settings-delete" title="Start over" description="Remove everything Earful has stored on this device.">
        {!confirmWipe ? (
          <div className="set-actions">
            <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setConfirmWipe(true)}>
              Delete everything…
            </Button>
          </div>
        ) : (
          <Callout tone="danger">
            <p className="set-callout-text">
              <strong>Delete everything on this device?</strong> Your {docCount === 1 ? 'document' : `${docCount} documents`}, reading positions, settings,
              API keys, saved audio and downloaded voices will be removed. This can’t be undone, so save a backup first if you might want your documents
              again.
            </p>
            <div className="set-actions" style={{ marginTop: 'var(--space-3)' }}>
              <Button size="sm" variant="danger" loading={wiping} onClick={() => void wipe()}>
                Yes, delete everything
              </Button>
              <Button size="sm" ref={cancelWipeRef} disabled={wiping} onClick={() => setConfirmWipe(false)}>
                Keep my data
              </Button>
            </div>
          </Callout>
        )}
      </SetGroup>
    </>
  )
}
