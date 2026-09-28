import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Copy, Play, Sparkles } from 'lucide-react'
import { toast } from '../ui'
import { isTouchDevice } from '../../lib/ui-format'

interface SelInfo {
  text: string
  rect: DOMRect
  /** Sentence index where the selection starts and char offset inside it. */
  sentence: number | null
  offset: number | undefined
}

/** Sentence span containing `node`, or the first one after it. */
function sentenceAt(article: HTMLElement, node: Node, offset: number): { index: number | null; offset: number | undefined } {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const span = el?.closest<HTMLElement>('span[data-s]')
  if (span && article.contains(span)) {
    try {
      const r = document.createRange()
      r.setStart(span, 0)
      r.setEnd(node, offset)
      return { index: Number(span.dataset.s), offset: r.toString().length }
    } catch {
      return { index: Number(span.dataset.s), offset: undefined }
    }
  }
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => ((n as HTMLElement).dataset?.s !== undefined ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  })
  walker.currentNode = node
  const next = walker.nextNode() as HTMLElement | null
  return { index: next ? Number(next.dataset.s) : null, offset: undefined }
}

/** Small floating toolbar for a text selection in the document: play from here, explain, copy. */
export function SelectionToolbar({
  articleRef,
  onPlayFrom,
  onExplain,
}: {
  articleRef: RefObject<HTMLElement | null>
  onPlayFrom: (sentence: number, offset: number | undefined) => void
  onExplain: (text: string) => void
}) {
  const [sel, setSel] = useState<SelInfo | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let frame = 0
    const read = () => {
      frame = 0
      const article = articleRef.current
      const s = window.getSelection()
      if (!article || !s || s.isCollapsed || s.rangeCount === 0) {
        setSel(null)
        return
      }
      const range = s.getRangeAt(0)
      if (!article.contains(range.commonAncestorContainer)) {
        setSel(null)
        return
      }
      const text = s.toString().trim()
      if (!text) {
        setSel(null)
        return
      }
      const start = sentenceAt(article, range.startContainer, range.startOffset)
      setSel({ text, rect: range.getBoundingClientRect(), sentence: start.index, offset: start.offset })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && window.getSelection()?.toString()) window.getSelection()?.removeAllRanges()
    }
    document.addEventListener('selectionchange', schedule)
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    document.addEventListener('keydown', onKey)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', schedule)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('keydown', onKey)
    }
  }, [articleRef])

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!sel || !bar) {
      setPos(null)
      return
    }
    const w = bar.offsetWidth
    const h = bar.offsetHeight
    const topLimit = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 56) + 8
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, sel.rect.left + sel.rect.width / 2 - w / 2))
    // On touch screens the system menu sits above the selection, so go below.
    let top = isTouchDevice() ? sel.rect.bottom + 12 : sel.rect.top - h - 10
    if (top < topLimit) top = sel.rect.bottom + 10
    top = Math.min(top, window.innerHeight - h - 8)
    setPos({ left, top })
  }, [sel])

  if (!sel) return null

  const clear = () => window.getSelection()?.removeAllRanges()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sel.text)
      toast('Copied')
    } catch {
      toast.error('Copying is blocked in this browser. Use your keyboard or the system menu instead.')
    }
    clear()
  }

  return (
    <div
      ref={barRef}
      className="sel-toolbar"
      role="toolbar"
      aria-label="Selected text"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      // Keep the selection while pressing the buttons.
      onPointerDown={(e) => e.preventDefault()}
    >
      {sel.sentence !== null && (
        <button
          type="button"
          onClick={() => {
            onPlayFrom(sel.sentence!, sel.offset)
            clear()
          }}
        >
          <Play aria-hidden />
          Play from here
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onExplain(sel.text)
          clear()
        }}
      >
        <Sparkles aria-hidden />
        Explain
      </button>
      <button type="button" onClick={() => void copy()}>
        <Copy aria-hidden />
        Copy
      </button>
    </div>
  )
}
