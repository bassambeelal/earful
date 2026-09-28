import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { LocateFixed } from 'lucide-react'
import type { ImportedDoc } from '../../types'
import { AiPanel } from '../ai/AiPanel'
import { Spinner, toast } from '../ui'
import { fontFamilyOf } from '../DisplayControls'
import { PlayerBar } from '../player/PlayerBar'
import { ReaderContent, type ContentApi } from './ReaderContent'
import { ReaderTopBar, buildToc } from './ReaderTopBar'
import { SelectionToolbar } from './SelectionToolbar'
import { useSentenceTracking } from './useSentenceTracking'
import { useLibrary, type OpenDoc } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { useSettings } from '../../lib/settings'
import { estimateSeconds, formatDuration, wordAt } from '../../lib/text'
import { openReader, replaceRoute } from '../../lib/router'
import { addDoc } from '../../lib/ui-import'
import { useUi } from '../../lib/ui-store'
import { cx, errorMessage, formatWords, sourceLabel } from '../../lib/ui-format'
import './reader.css'

/** Loads the document (and into the player), then shows the reader. */
export function ReaderView({ id }: { id: string }) {
  const open = useLibrary((s) => (s.open?.meta.id === id ? s.open : null))

  useEffect(() => {
    let cancelled = false
    useLibrary
      .getState()
      .openDoc(id)
      .then((doc) => {
        if (cancelled) return
        if (!doc) {
          toast.error(useLibrary.getState().openError ?? 'That document is no longer in your library.')
          replaceRoute('#/')
          return
        }
        const player = usePlayer.getState()
        if (player.docId !== id) {
          const startAt = Math.max(0, Math.min(doc.meta.position, doc.sentences.length - 1))
          player.load(id, doc.sentences, { startAt, title: doc.meta.title, blockCount: doc.content.blocks.length, chapterStarts: doc.chapterStarts })
        }
        const ui = useUi.getState()
        if (ui.autoplayDocId === id) {
          ui.setAutoplay(null)
          usePlayer.getState().play()
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        toast.error(errorMessage(e, 'This document could not be opened.'))
        replaceRoute('#/')
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (!open) {
    return (
      <div className="reader reader--loading">
        <Spinner label="Opening document" />
      </div>
    )
  }
  return <ReaderLoaded doc={open} />
}

function ReaderLoaded({ doc }: { doc: OpenDoc }) {
  const display = useSettings((s) => s.display)
  const rate = useSettings((s) => s.rate)
  const ai = useUi((s) => s.ai)
  const articleRef = useRef<HTMLElement>(null)
  const apiRef = useRef<ContentApi>(null)
  const [offscreen, setOffscreen] = useState(false)
  const { meta, content, sentences, blockFirstSentence } = doc
  const docId = meta.id

  const tracker = useSentenceTracking({ docId, sentences, articleRef, apiRef, onOffscreenChange: setOffscreen })
  const toc = useMemo(() => buildToc(content, blockFirstSentence), [content, blockFirstSentence])

  // Start block for the first paint: where the reader left off (captured once).
  const [startBlock] = useState(() => sentences[Math.min(meta.position, sentences.length - 1)]?.block ?? 0)

  const onSentenceClick = useCallback(
    (index: number, offset: number | undefined) => {
      const s = sentences[index]
      if (!s) return
      const w = offset !== undefined ? wordAt(s, offset) : null
      tracker.current?.resume()
      usePlayer.getState().seek(index, { wordOffset: w?.start })
    },
    [sentences, tracker],
  )

  const onJump = useCallback(
    (index: number) => {
      tracker.current?.jumpTo(index)
      usePlayer.getState().seek(index)
    },
    [tracker],
  )

  const onPlayFrom = useCallback(
    (index: number, offset: number | undefined) => {
      const s = sentences[index]
      const w = s && offset !== undefined ? wordAt(s, offset) : null
      tracker.current?.jumpTo(index)
      usePlayer.getState().seek(index, { wordOffset: w?.start, play: true })
    },
    [sentences, tracker],
  )

  const subtitle = [meta.author, sourceLabel(meta.source), formatWords(meta.wordCount), formatDuration(estimateSeconds(meta.wordCount, rate))]
    .filter(Boolean)
    .join(' · ')

  const style = {
    '--reader-font': fontFamilyOf(display.font),
    '--reader-size': `${display.fontSize}px`,
    '--reader-lh': display.lineHeight,
    '--reader-width': `${display.width}ch`,
  } as CSSProperties

  return (
    <div
      className={cx('reader', display.focusMode && 'reader--focus', display.highlightSentence && 'reader--hl-sentence', ai.open && 'reader--ai')}
      style={style}
    >
      <ReaderTopBar doc={doc} toc={toc} onJump={onJump} />
      <div className="reader__body">
        <main className="reader__main" id="main">
          <ReaderContent
            content={content}
            sentences={sentences}
            blockFirstSentence={blockFirstSentence}
            startBlock={startBlock}
            title={meta.title}
            subtitle={subtitle}
            lang={meta.lang}
            apiRef={apiRef}
            articleRef={articleRef}
            onSentenceClick={onSentenceClick}
          />
        </main>
        {ai.open && <AiAside key={ai.nonce} doc={doc} />}
      </div>
      {offscreen && (
        <button type="button" className="jump-pill" onClick={() => tracker.current?.scrollToActive()}>
          <LocateFixed aria-hidden />
          Jump to current
        </button>
      )}
      <SelectionToolbar articleRef={articleRef} onPlayFrom={onPlayFrom} onExplain={(text) => useUi.getState().openAi('explain', text)} />
      <PlayerBar />
    </div>
  )
}

/** AI study tools beside the text (a sheet on small screens). */
function AiAside({ doc }: { doc: OpenDoc }) {
  const ai = useUi((s) => s.ai)
  const sentence = usePlayer((s) => (s.docId === doc.meta.id ? s.sentence : doc.meta.position))

  const onCreateDoc = useCallback(async (d: ImportedDoc) => {
    try {
      const id = await addDoc(d)
      toast(`“${d.title}” was added to your library.`)
      openReader(id)
    } catch (e) {
      toast.error(errorMessage(e, 'The new document could not be saved.'))
    }
  }, [])

  return (
    <aside className="reader__ai" aria-label="AI tools">
      <AiPanel
        doc={doc}
        initialTool={ai.tool}
        selection={ai.selection}
        currentSentence={sentence}
        onClose={() => useUi.getState().closeAi()}
        onCreateDoc={(d) => void onCreateDoc(d)}
        onOpenSettings={() => useUi.getState().openSettings('ai')}
      />
    </aside>
  )
}
