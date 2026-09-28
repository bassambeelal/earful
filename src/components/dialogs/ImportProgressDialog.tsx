import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { Button, Dialog, Progress } from '../ui'
import { cancelImport, useImportState } from '../../lib/ui-import'
import './dialogs.css'

/**
 * Shown while files are being imported. Clicking outside does nothing (an accidental click
 * shouldn't throw away a long OCR run); Cancel, the close button and Escape stop the import.
 */
export function ImportProgressDialog() {
  const fileName = useImportState((s) => s.fileName)
  const index = useImportState((s) => s.index)
  const count = useImportState((s) => s.count)
  const progress = useImportState((s) => s.progress)
  const active = useImportState((s) => s.active)
  const [cancelling, setCancelling] = useState(false)
  const scrimPress = useRef(false)

  // The shared Dialog closes on a press on its backdrop. Note where each press starts
  // (capture phase runs before React's handler) so that one can be ignored below.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      scrimPress.current = e.target instanceof Element && e.target.classList.contains('ui-dialog-scrim')
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [])

  const cancel = () => {
    if (!active) return
    setCancelling(true)
    cancelImport()
  }

  const onClose = () => {
    if (scrimPress.current) {
      scrimPress.current = false
      return
    }
    cancel()
  }

  const label = cancelling ? 'Stopping…' : progress?.label || 'Opening…'
  const value = cancelling ? null : (progress?.value ?? null)
  const pct = value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100)

  return (
    <Dialog
      open
      onClose={onClose}
      title={count > 1 ? 'Importing documents' : 'Importing your document'}
      footer={
        <Button onClick={cancel} disabled={cancelling} data-autofocus>
          {cancelling ? 'Stopping…' : 'Cancel'}
        </Button>
      }
    >
      <div className="dlg-stack dlg-stack--tight">
        {fileName && (
          <p className="dlg-import__file" title={fileName}>
            <FileText aria-hidden />
            <span>{fileName}</span>
          </p>
        )}
        {count > 1 && (
          <p className="dlg-muted">
            File {index} of {count}
          </p>
        )}
        <div className="dlg-progress">
          <div className="dlg-progress__row" aria-live="polite">
            <span>{label}</span>
            {pct !== null && <strong>{pct}%</strong>}
          </div>
          <Progress value={value} label="Import progress" />
        </div>
        <p className="dlg-muted">Everything happens on your device. Large or scanned files can take a minute.</p>
      </div>
    </Dialog>
  )
}
