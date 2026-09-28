import { useEffect, useRef, type RefObject } from 'react'
import type { ContentApi } from './ReaderContent'
import type { Sentence, WordSpan } from '../../lib/text'
import { usePlayer } from '../../lib/player'
import { getSettings, useSettings } from '../../lib/settings'
import { isTypingTarget } from '../../lib/shortcuts'
import { prefersReducedMotion } from '../../lib/ui-format'

// Follows the player: marks the active sentence span, paints the current word and keeps the
// sentence in view. All imperative, so the document itself never re-renders during playback.

export interface Tracker {
  /** Scroll the active sentence into view and resume following. */
  scrollToActive(): void
  /** Call before an explicit jump (table of contents): scrolls there even if follow-along is off. */
  jumpTo(index: number): void
  /** Resume following right away (e.g. after the user clicks a sentence). */
  resume(): void
}

const WORD_HIGHLIGHT = 'earful-word'
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'])
/** How long auto-scroll stays out of the way after the user scrolls. */
const SUSPEND_MS = 4000

const cssPx = (name: string, fallback: number) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || fallback

export function useSentenceTracking({
  docId,
  sentences,
  articleRef,
  apiRef,
  onOffscreenChange,
}: {
  docId: string
  sentences: Sentence[]
  articleRef: RefObject<HTMLElement | null>
  apiRef: RefObject<ContentApi | null>
  onOffscreenChange: (offscreen: boolean) => void
}): RefObject<Tracker | null> {
  const trackerRef = useRef<Tracker | null>(null)
  const offscreenRef = useRef(onOffscreenChange)
  offscreenRef.current = onOffscreenChange

  useEffect(() => {
    const article = articleRef.current
    if (!article) return

    const supportsHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function'
    const topInset = () => cssPx('--topbar-h', 56)
    const bottomInset = () => cssPx('--player-h', 88)

    let activeIndex = -1
    let activeEl: HTMLElement | null = null
    let marked: { el: HTMLElement; text: string } | null = null
    let suspendedUntil = 0
    let forceIndex: number | null = null
    let disposed = false

    const io = new IntersectionObserver(
      (entries) => {
        const e = entries.findLast((x) => x.target === activeEl)
        if (e) offscreenRef.current(!e.isIntersecting)
      },
      { rootMargin: `-${topInset()}px 0px -${bottomInset()}px 0px` },
    )

    const findSpan = (i: number) => article.querySelector<HTMLElement>(`span[data-s="${i}"]`)

    const clearWord = () => {
      if (supportsHighlight) CSS.highlights.delete(WORD_HIGHLIGHT)
      if (marked) {
        marked.el.textContent = marked.text
        marked = null
      }
    }

    const paintWord = (w: WordSpan | null) => {
      clearWord()
      if (!w || !activeEl || !getSettings().display.highlightWord) return
      const text = activeEl.textContent ?? ''
      const start = Math.max(0, Math.min(text.length, w.start))
      const end = Math.max(start, Math.min(text.length, w.end))
      if (end <= start) return
      if (supportsHighlight) {
        const node = activeEl.firstChild
        if (!node || node.nodeType !== Node.TEXT_NODE) return
        const range = new Range()
        range.setStart(node, start)
        range.setEnd(node, end)
        CSS.highlights.set(WORD_HIGHLIGHT, new Highlight(range))
      } else {
        // Fallback: wrap the word in <mark> inside the active sentence only; restored on change.
        const mark = document.createElement('mark')
        mark.className = 'w'
        mark.textContent = text.slice(start, end)
        activeEl.replaceChildren(text.slice(0, start), mark, text.slice(end))
        marked = { el: activeEl, text }
      }
    }

    /** Is the element comfortably inside the visible reading area? */
    const inView = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      const top = topInset()
      const bottom = window.innerHeight - bottomInset()
      const h = bottom - top
      return r.top >= top + h * 0.08 && r.bottom <= top + h * 0.72
    }

    const scrollToEl = (el: HTMLElement, instant = false) => {
      const r = el.getBoundingClientRect()
      const target = window.scrollY + r.top - window.innerHeight * 0.35
      window.scrollTo({ top: Math.max(0, target), behavior: instant || prefersReducedMotion() ? 'auto' : 'smooth' })
    }

    const activate = (i: number, mode: 'initial' | 'change') => {
      activeIndex = i
      const apply = () => {
        if (disposed || activeIndex !== i) return
        if (activeEl) {
          activeEl.classList.remove('s--active')
          io.unobserve(activeEl)
        }
        clearWord()
        activeEl = findSpan(i)
        if (!activeEl) return
        activeEl.classList.add('s--active')
        io.observe(activeEl)
        const forced = forceIndex === i
        if (forced) forceIndex = null
        if (forced) scrollToEl(activeEl)
        else if (mode === 'initial') {
          if (!inView(activeEl)) scrollToEl(activeEl, true)
        } else if (getSettings().display.autoScroll && Date.now() > suspendedUntil && !inView(activeEl)) scrollToEl(activeEl)
        paintWord(usePlayer.getState().word)
      }
      if (!findSpan(i) && apiRef.current) apiRef.current.renderUpTo(sentences[i]?.block ?? 0, apply)
      else apply()
    }

    const unsubPlayer = usePlayer.subscribe((s, prev) => {
      if (s.docId !== docId) return
      if (prev.docId !== docId) activate(s.sentence, 'initial')
      else if (s.sentence !== prev.sentence) activate(s.sentence, 'change')
      else if (s.word !== prev.word) paintWord(s.word)
    })
    const unsubSettings = useSettings.subscribe((s, prev) => {
      if (s.display.highlightWord !== prev.display.highlightWord) paintWord(s.display.highlightWord ? usePlayer.getState().word : null)
      if (s.display.autoScroll && !prev.display.autoScroll) suspendedUntil = 0
    })
    const p = usePlayer.getState()
    if (p.docId === docId) activate(Math.min(p.sentence, sentences.length - 1), 'initial')

    // Only real user input suspends follow-along (layout shifts and our own smooth scrolls don't).
    const suspend = () => {
      suspendedUntil = Date.now() + SUSPEND_MS
    }
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key) && !isTypingTarget(e.target)) suspend()
    }
    const onPointerDown = (e: PointerEvent) => {
      // A press on the page's own scrollbar targets <html>.
      if (e.target === document.documentElement) suspend()
    }
    window.addEventListener('wheel', suspend, { passive: true })
    window.addEventListener('touchmove', suspend, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown)

    trackerRef.current = {
      scrollToActive() {
        suspendedUntil = 0
        if (activeEl) scrollToEl(activeEl)
      },
      jumpTo(index) {
        suspendedUntil = 0
        if (index === activeIndex && activeEl) scrollToEl(activeEl)
        else forceIndex = index
      },
      resume() {
        suspendedUntil = 0
      },
    }

    return () => {
      disposed = true
      unsubPlayer()
      unsubSettings()
      window.removeEventListener('wheel', suspend)
      window.removeEventListener('touchmove', suspend)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown)
      io.disconnect()
      clearWord()
      activeEl?.classList.remove('s--active')
      trackerRef.current = null
    }
  }, [docId, sentences, articleRef, apiRef])

  return trackerRef
}
