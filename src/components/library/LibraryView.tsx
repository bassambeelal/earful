import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { Camera, ClipboardPaste, FileUp, MonitorDown, Plus, Search, Settings, Sparkles, X } from 'lucide-react'
import { Button, IconButton, Kbd, MenuItem, MenuSeparator, Popover, Spinner } from '../ui'
import { Logo } from '../Logo'
import { MiniPlayer } from '../player/MiniPlayer'
import { ContinueCard } from './ContinueCard'
import { DocCard } from './DocCard'
import { EmptyState } from './EmptyState'
import { useImportPickers } from './useImportPickers'
import { useLibrary } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { useSettings } from '../../lib/settings'
import { promptInstall, useInstall } from '../../lib/install'
import { openSample } from '../../lib/ui-import'
import { useUi } from '../../lib/ui-store'
import { cx, isFinished, isTouchDevice, searchKey } from '../../lib/ui-format'
import type { DocMeta } from '../../types'
import './library.css'

const recency = (d: DocMeta) => d.lastOpenedAt ?? d.createdAt

export function LibraryView() {
  const docs = useLibrary((s) => s.docs)
  const loaded = useLibrary((s) => s.loaded)
  const rate = useSettings((s) => s.rate)
  const hasMini = usePlayer((s) => s.docId !== null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const { pickFiles, snapPhoto, inputs } = useImportPickers()

  const sorted = useMemo(() => [...docs].sort((a, b) => recency(b) - recency(a)), [docs])
  const filtered = useMemo(() => {
    const q = searchKey(deferredQuery.trim())
    if (!q) return sorted
    return sorted.filter((d) => searchKey(`${d.title} ${d.author ?? ''}`).includes(q))
  }, [sorted, deferredQuery])
  const continueDoc = useMemo(() => sorted.find((d) => d.position > 0 && !isFinished(d)), [sorted])

  return (
    <div className={cx('library', hasMini && 'library--with-mini')}>
      {inputs}
      <LibraryHeader query={query} setQuery={setQuery} pickFiles={pickFiles} snapPhoto={snapPhoto} />
      <main className="library__main" id="main">
        {!loaded ? (
          <div className="library__loading">
            <Spinner label="Loading your library" />
          </div>
        ) : docs.length === 0 ? (
          <EmptyState pickFiles={pickFiles} snapPhoto={snapPhoto} />
        ) : (
          <>
            {continueDoc && !deferredQuery && <ContinueCard meta={continueDoc} rate={rate} />}
            <section className="shelf" aria-labelledby="shelf-title">
              <div className="shelf__head">
                <h2 id="shelf-title" className="shelf__title">
                  {deferredQuery ? 'Search results' : 'Your library'}
                </h2>
                <span className="shelf__count">
                  {filtered.length} {filtered.length === 1 ? 'document' : 'documents'}
                </span>
              </div>
              {filtered.length === 0 ? (
                <div className="shelf__none">
                  <p>No documents match “{deferredQuery.trim()}”.</p>
                  <Button size="sm" onClick={() => setQuery('')}>
                    Clear search
                  </Button>
                </div>
              ) : (
                <div className="shelf__grid">
                  {!deferredQuery && (
                    <button type="button" className="add-tile" onClick={pickFiles}>
                      <span className="add-tile__icon" aria-hidden>
                        <Plus />
                      </span>
                      <span className="add-tile__label">Add a document</span>
                      <span className="add-tile__hint">or drop files anywhere</span>
                    </button>
                  )}
                  {filtered.map((d) => (
                    <DocCard key={d.id} meta={d} rate={rate} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>
      {hasMini && <MiniPlayer />}
    </div>
  )
}

function LibraryHeader({
  query,
  setQuery,
  pickFiles,
  snapPhoto,
}: {
  query: string
  setQuery: (q: string) => void
  pickFiles: () => void
  snapPhoto: () => void
}) {
  const importRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  const canInstall = useInstall((s) => !!s.event && !s.installed)
  const touch = isTouchDevice()
  const ui = useUi.getState

  const act = (fn: () => void) => () => {
    setMenu(false)
    fn()
  }

  return (
    <header className="lib-header">
      <div className="lib-header__brand">
        <Logo size={32} />
        <span className="wordmark">Earful</span>
      </div>

      <div className="lib-search" role="search">
        <Search className="lib-search__icon" aria-hidden />
        <input
          id="library-search"
          type="search"
          className="lib-search__input"
          placeholder="Search your library"
          aria-label="Search your library"
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.stopPropagation()
              setQuery('')
            }
          }}
        />
        {query ? (
          <IconButton size="sm" label="Clear search" className="lib-search__clear" onClick={() => setQuery('')}>
            <X />
          </IconButton>
        ) : (
          <span className="lib-search__kbd" aria-hidden>
            <Kbd>/</Kbd>
          </span>
        )}
      </div>

      <div className="lib-header__actions">
        {canInstall && (
          <Button variant="ghost" className="lib-header__install" icon={<MonitorDown />} onClick={() => void promptInstall()} title="Install Earful as an app">
            <span className="hide-sm">Install</span>
          </Button>
        )}
        <Button ref={importRef} variant="primary" icon={<Plus />} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          Import
        </Button>
        <Popover open={menu} onClose={() => setMenu(false)} anchor={importRef} placement="bottom" align="end" label="Import">
          <MenuItem icon={<FileUp />} onClick={act(pickFiles)}>
            Import files…
          </MenuItem>
          <MenuItem icon={<ClipboardPaste />} onClick={act(() => ui().setPaste(true))}>
            Paste text or a link
          </MenuItem>
          {touch && (
            <MenuItem icon={<Camera />} onClick={act(snapPhoto)}>
              Snap a photo
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Sparkles />} onClick={act(() => void openSample())}>
            Open the welcome guide
          </MenuItem>
        </Popover>
        <IconButton label="Settings" onClick={() => ui().openSettings()}>
          <Settings />
        </IconButton>
      </div>
    </header>
  )
}
