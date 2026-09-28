import { useUi } from '../lib/ui-store'
import { useImportState } from '../lib/ui-import'
import { DeleteDialog, RenameDialog } from './dialogs/DocDialogs'
import { ExportDialog } from './dialogs/ExportDialog'
import { ImportProgressDialog } from './dialogs/ImportProgressDialog'
import { PasteDialog } from './dialogs/PasteDialog'
import { ShortcutsDialog } from './dialogs/ShortcutsDialog'
import { SettingsDialog } from './settings/SettingsDialog'
import { VoicePicker } from './voices/VoicePicker'

/** App-level dialogs. Each mounts only while open so it starts fresh every time. */
export function GlobalDialogs() {
  const settings = useUi((s) => s.settings.open)
  const paste = useUi((s) => s.paste)
  const shortcuts = useUi((s) => s.shortcuts)
  const voicePicker = useUi((s) => s.voicePicker)
  const exportDocId = useUi((s) => s.exportDocId)
  const renameDocId = useUi((s) => s.renameDocId)
  const deleteDocId = useUi((s) => s.deleteDocId)
  const importing = useImportState((s) => s.active)

  return (
    <>
      {settings && <SettingsDialog />}
      {voicePicker && <VoicePicker />}
      {paste && <PasteDialog />}
      {shortcuts && <ShortcutsDialog />}
      {exportDocId && <ExportDialog key={exportDocId} docId={exportDocId} />}
      {renameDocId && <RenameDialog key={renameDocId} docId={renameDocId} />}
      {deleteDocId && <DeleteDialog key={deleteDocId} docId={deleteDocId} />}
      {importing && <ImportProgressDialog />}
    </>
  )
}
