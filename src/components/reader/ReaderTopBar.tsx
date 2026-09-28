import { useCallback, useRef, useState } from 'react'
import { ALargeSmall, ArrowLeft, Download, Ellipsis, Keyboard, Pencil, Sparkles, TableOfContents, Trash2 } from 'lucide-react'
import type { OpenDoc } from '../../lib/library'
import type { DocContent } from '../../types'
import { IconButton, MenuItem, MenuSeparator, Popover } from '../ui'
import { DisplayControls } from '../DisplayControls'
import { usePlayer } from '../../lib/player'
import { goLibrary } from '../../lib/router'
import { useUi } from '../../lib/ui-store'
import { cx } from '../../lib/ui-format'

export interface TocEntry {
  title: string
  /** First sentence of the entry. */
  start: number
  level: number
}

/** Chapters from the importer, or headings when there are none. */
export function buildToc(content: DocContent, blockFirstSentence: number[]): TocEntry[] {
  const src = content.chapters.length
    ? content.chapters.map((c) => ({ title: c.title, block: c.block, level: 1 }))
    : content.blocks.flatMap((b, i) => (b.type === 'heading' && (b.level ?? 1) <= 3 ? [{ title: b.text, block: i, level: b.level ?? 1 }] : []))
  const minLevel = Math.min(...src.map((s) => s.level), 6)
  const out: TocEntry[] = []
  for (const e of src) {
    let start = -1
    for (let b = e.block; b < blockFirstSentence.length; b++) {
      if (blockFirstSentence[b] >= 0) {
        start = blockFirstSentence[b]
        break
      }
    }
    if (start >= 0) out.push({ title: e.title || 'Untitled section', start, level: e.level - minLevel + 1 })
  }
  return out
}

function currentEntry(toc: TocEntry[], sentence: number): number {
  let idx = -1
  for (let i = 0; i < toc.length; i++) {
    if (toc[i].start <= sentence) idx = i
    else break
  }
  return idx
}

export function ReaderTopBar({ doc, toc, onJump }: { doc: OpenDoc; toc: TocEntry[]; onJump: (sentence: number) => void }) {
  const aiOpen = useUi((s) => s.ai.open)
  const ui = useUi.getState
  const id = doc.meta.id

  return (
    <header className="reader-top">
      <IconButton label="Back to library" onClick={goLibrary}>
        <ArrowLeft />
      </IconButton>
      <button type="button" className="reader-top__title" onClick={() => ui().setRenameDoc(id)} title="Rename">
        <span>{doc.meta.title}</span>
      </button>
      <div className="reader-top__actions">
        {toc.length > 0 && <TocButton toc={toc} onJump={onJump} />}
        <IconButton label="AI tools" pressed={aiOpen} onClick={() => ui().toggleAi()}>
          <Sparkles />
        </IconButton>
        <DisplayButton />
        <MoreButton docId={id} />
      </div>
    </header>
  )
}

function TocButton({ toc, onJump }: { toc: TocEntry[]; onJump: (sentence: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = usePlayer((s) => currentEntry(toc, s.sentence))
  // Bring the current chapter into view when the list opens.
  const centerCurrent = useCallback((el: HTMLDivElement | null) => {
    const cur = el?.querySelector<HTMLElement>('[aria-current="true"]')
    const scroller = el?.parentElement
    if (cur && scroller) scroller.scrollTop = Math.max(0, cur.offsetTop - scroller.clientHeight / 2)
  }, [])

  return (
    <>
      <IconButton ref={ref} label="Contents" aria-haspopup="dialog" aria-expanded={open} pressed={open} onClick={() => setOpen((o) => !o)}>
        <TableOfContents />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom" align="end" label="Contents">
        <div className="toc" ref={centerCurrent}>
          <p className="pop-title">Contents</p>
          {toc.map((e, i) => (
            <button
              key={`${e.start}-${i}`}
              type="button"
              className={cx('ui-menu-item toc__item', `toc__item--l${Math.min(3, e.level)}`)}
              aria-current={i === current ? 'true' : undefined}
              onClick={() => {
                setOpen(false)
                onJump(e.start)
              }}
            >
              <span className="toc__title">{e.title}</span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

function DisplayButton() {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton ref={ref} label="Text and display" aria-haspopup="dialog" aria-expanded={open} pressed={open} onClick={() => setOpen((o) => !o)}>
        <ALargeSmall />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom" align="end" label="Text and display">
        <div className="display-pop">
          <DisplayControls compact />
        </div>
      </Popover>
    </>
  )
}

function MoreButton({ docId }: { docId: string }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const ui = useUi.getState
  const act = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  return (
    <>
      <IconButton ref={ref} label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Ellipsis />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom" align="end" label="More options">
        <MenuItem icon={<Download />} onClick={act(() => ui().setExportDoc(docId))}>
          Export audio
        </MenuItem>
        <MenuItem icon={<Pencil />} onClick={act(() => ui().setRenameDoc(docId))}>
          Rename
        </MenuItem>
        <MenuItem icon={<Keyboard />} onClick={act(() => ui().setShortcuts(true))}>
          Keyboard shortcuts
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} danger onClick={act(() => ui().setDeleteDoc(docId))}>
          Delete
        </MenuItem>
      </Popover>
    </>
  )
}
