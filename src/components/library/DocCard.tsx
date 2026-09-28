import { memo, useRef, useState } from 'react'
import { BookOpen, Download, Ellipsis, Pencil, Trash2 } from 'lucide-react'
import type { DocMeta } from '../../types'
import { IconButton, MenuItem, MenuSeparator, Popover } from '../ui'
import { Cover } from './Cover'
import { usePlayer } from '../../lib/player'
import { openReader } from '../../lib/router'
import { useUi } from '../../lib/ui-store'
import { formatWords, sourceLabel, timeLeftLabel } from '../../lib/ui-format'

export const DocCard = memo(function DocCard({ meta, rate }: { meta: DocMeta; rate: number }) {
  const menuRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const playing = usePlayer((s) => s.docId === meta.id && s.status === 'playing')
  const ui = useUi.getState

  const act = (fn: () => void) => () => {
    setMenu(false)
    fn()
  }

  return (
    <article className="doc-card">
      <button type="button" className="doc-card__open" onClick={() => openReader(meta.id)} aria-label={`Open ${meta.title}`}>
        <div className="doc-card__cover">
          <Cover meta={meta} />
          {playing && (
            <span className="eq" aria-label="Playing">
              <span />
              <span />
              <span />
            </span>
          )}
        </div>
        <div className="doc-card__body">
          <h3 className="doc-card__title">{meta.title}</h3>
          {meta.author && <p className="doc-card__author">{meta.author}</p>}
          <p className="doc-card__meta">
            <span className="doc-card__source">{sourceLabel(meta.source)}</span>
            <span aria-hidden>·</span>
            <span>{formatWords(meta.wordCount)}</span>
            <span aria-hidden>·</span>
            <span>{timeLeftLabel(meta, rate)}</span>
          </p>
        </div>
      </button>
      <IconButton ref={menuRef} className="doc-card__menu" size="sm" label={`Options for ${meta.title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
        <Ellipsis />
      </IconButton>
      <Popover open={menu} onClose={() => setMenu(false)} anchor={menuRef} placement="bottom" align="end" label="Document options">
        <MenuItem icon={<BookOpen />} onClick={act(() => openReader(meta.id))}>
          Open
        </MenuItem>
        <MenuItem icon={<Pencil />} onClick={act(() => ui().setRenameDoc(meta.id))}>
          Rename
        </MenuItem>
        <MenuItem icon={<Download />} onClick={act(() => ui().setExportDoc(meta.id))}>
          Export audio
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} danger onClick={act(() => ui().setDeleteDoc(meta.id))}>
          Delete
        </MenuItem>
      </Popover>
    </article>
  )
})
