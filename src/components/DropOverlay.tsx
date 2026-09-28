import { useEffect, useState } from 'react'
import { FileUp } from 'lucide-react'
import { importFiles } from '../lib/ui-import'
import { modalOpen } from '../lib/ui-store'

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/** Window-wide drop target: drop files anywhere to import them. */
export function DropOverlay() {
  const [active, setActive] = useState(false)

  useEffect(() => {
    let depth = 0
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      if (!modalOpen()) setActive(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Always prevent the browser from navigating to the dropped file.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = modalOpen() ? 'none' : 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setActive(false)
      if (modalOpen()) return
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length) void importFiles(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (!active) return null
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-overlay__card">
        <FileUp />
        <p className="drop-overlay__title">Drop to import</p>
        <p className="drop-overlay__hint">PDF, EPUB, Word, text, Markdown, web pages and photos</p>
      </div>
    </div>
  )
}
