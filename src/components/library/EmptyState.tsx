import { Camera, ClipboardPaste, FileUp, Sparkles } from 'lucide-react'
import { Button } from '../ui'
import { openSample } from '../../lib/ui-import'
import { useUi } from '../../lib/ui-store'
import { isTouchDevice } from '../../lib/ui-format'

/** First screen when the library is empty: a big, friendly drop zone. */
export function EmptyState({ pickFiles, snapPhoto }: { pickFiles: () => void; snapPhoto: () => void }) {
  const touch = isTouchDevice()
  return (
    <section className="empty">
      <button type="button" className="empty__zone" onClick={pickFiles}>
        <span className="empty__art" aria-hidden>
          <FileUp />
        </span>
        <span className="empty__title">Drop a PDF, EPUB, Word file, text or a photo</span>
        <span className="empty__hint">Earful reads it aloud with natural voices. Everything stays on your device.</span>
      </button>
      <div className="empty__actions">
        <Button variant="primary" size="lg" icon={<FileUp />} onClick={pickFiles}>
          Import file
        </Button>
        <Button size="lg" icon={<ClipboardPaste />} onClick={() => useUi.getState().setPaste(true)}>
          Paste text
        </Button>
        {touch && (
          <Button size="lg" icon={<Camera />} onClick={snapPhoto}>
            Snap a photo
          </Button>
        )}
        <Button size="lg" variant="ghost" icon={<Sparkles />} onClick={() => void openSample()}>
          Open sample
        </Button>
      </div>
    </section>
  )
}
