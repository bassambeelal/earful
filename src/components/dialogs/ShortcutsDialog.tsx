import { Fragment } from 'react'
import { Button, Dialog, Kbd } from '../ui'
import { SHORTCUTS } from '../../lib/shortcuts'
import { useUi } from '../../lib/ui-store'
import './dialogs.css'

/** "Shift + ←" -> <Kbd>Shift</Kbd> + <Kbd>←</Kbd> */
function KeyCombo({ combo }: { combo: string }) {
  const parts = combo.split(' + ')
  return (
    <span>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="dlg-keys__plus" aria-hidden>
              +
            </span>
          )}
          <Kbd>{p}</Kbd>
        </Fragment>
      ))}
    </span>
  )
}

/** Keyboard shortcut reference, built from the same list the key handler uses. */
export function ShortcutsDialog() {
  const close = () => useUi.getState().setShortcuts(false)

  return (
    <Dialog
      open
      onClose={close}
      title="Keyboard shortcuts"
      footer={
        <Button variant="primary" onClick={close} data-autofocus>
          Done
        </Button>
      }
    >
      <table className="dlg-keys">
        <thead>
          <tr>
            <th scope="col">Keys</th>
            <th scope="col">What it does</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.label}>
              <td>
                {s.keys.map((k, i) => (
                  <Fragment key={k}>
                    {i > 0 && <span className="dlg-keys__or">or</span>}
                    <KeyCombo combo={k} />
                  </Fragment>
                ))}
              </td>
              <th scope="row">{s.label}</th>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dlg-muted" style={{ marginTop: 'var(--space-4)' }}>
        Shortcuts work whenever you are not typing in a text box and no window like this one is open.
      </p>
    </Dialog>
  )
}
