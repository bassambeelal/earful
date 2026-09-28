import { useState, type FormEvent } from 'react'
import { Button, Dialog, Field, Input, toast } from '../ui'
import { getContent, getDoc, saveDoc } from '../../lib/db'
import { useLibrary } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { currentRoute, replaceRoute } from '../../lib/router'
import { useUi } from '../../lib/ui-store'
import { errorMessage } from '../../lib/ui-format'
import './dialogs.css'

export function RenameDialog({ docId }: { docId: string }) {
  const meta = useLibrary((s) => s.docs.find((d) => d.id === docId) ?? (s.open?.meta.id === docId ? s.open.meta : undefined))
  const [title, setTitle] = useState(meta?.title ?? '')
  const [busy, setBusy] = useState(false)
  const close = () => useUi.getState().setRenameDoc(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next = title.trim()
    if (!next || next === meta?.title) {
      close()
      return
    }
    setBusy(true)
    try {
      await useLibrary.getState().rename(docId, next)
      close()
    } catch (err) {
      toast.error(errorMessage(err, 'The document could not be renamed.'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title="Rename document"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" form="rename-form" loading={busy} disabled={!title.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form id="rename-form" onSubmit={submit}>
        <Field label="Title" htmlFor="rename-title">
          <Input id="rename-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} data-autofocus onFocus={(e) => e.target.select()} />
        </Field>
      </form>
    </Dialog>
  )
}

export function DeleteDialog({ docId }: { docId: string }) {
  const meta = useLibrary((s) => s.docs.find((d) => d.id === docId) ?? (s.open?.meta.id === docId ? s.open.meta : undefined))
  const [busy, setBusy] = useState(false)
  const close = () => useUi.getState().setDeleteDoc(null)

  const confirm = async () => {
    setBusy(true)
    try {
      // Keep a copy in memory for "Undo".
      const [savedMeta, savedContent] = await Promise.all([getDoc(docId), getContent(docId)])
      if (usePlayer.getState().docId === docId) usePlayer.getState().unload()
      const route = currentRoute()
      if (route.name === 'read' && route.id === docId) replaceRoute('#/')
      await useLibrary.getState().remove(docId)
      close()
      const title = savedMeta?.title ?? meta?.title ?? 'Document'
      toast(`Deleted “${title}”.`, {
        duration: 8000,
        action:
          savedMeta && savedContent
            ? {
                label: 'Undo',
                onClick: () => {
                  saveDoc(savedMeta, savedContent)
                    .then(() => useLibrary.getState().refresh())
                    .then(() => toast('Restored.'))
                    .catch(() => toast.error('The document could not be restored.'))
                },
              }
            : undefined,
      })
    } catch (err) {
      toast.error(errorMessage(err, 'The document could not be deleted.'))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={close}
      title="Delete this document?"
      footer={
        <>
          <Button onClick={close} data-autofocus>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} loading={busy}>
            Delete
          </Button>
        </>
      }
    >
      <p className="dlg-text">
        <strong>{meta?.title ?? 'This document'}</strong> and your place in it will be removed from this device. Saved audio for it may stay in the audio cache until it is cleared.
      </p>
    </Dialog>
  )
}
