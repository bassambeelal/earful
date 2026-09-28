import { useEffect, useRef } from 'react'
import { usePlayer } from './player'
import { getSettings, RATE_MAX, RATE_MIN } from './settings'
import { modalOpen } from './ui-store'

// Global keyboard shortcuts. Ignored while typing or while a modal dialog is open.

export const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['Space', 'K'], label: 'Play or pause' },
  { keys: ['←', '→'], label: 'Previous or next sentence' },
  { keys: ['Shift + ←', 'Shift + →'], label: 'Previous or next paragraph' },
  { keys: ['+', ']'], label: 'Faster' },
  { keys: ['−', '['], label: 'Slower' },
  { keys: ['/'], label: 'Search your library' },
  { keys: ['Esc'], label: 'Close panels' },
  { keys: ['?'], label: 'Show keyboard shortcuts' },
]

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color'].includes(type)
  }
  return false
}

export interface ShortcutHandlers {
  /** '/' — focus the library search. */
  onSearch?: () => void
  /** '?' — show the shortcuts help. */
  onHelp?: () => void
  /** Esc — close the top-most panel. Return true if something was closed. */
  onEscape?: () => boolean
}

function stepRate(delta: number) {
  const next = Math.round((getSettings().rate + delta) * 100) / 100
  usePlayer.getState().setRate(Math.min(RATE_MAX, Math.max(RATE_MIN, next)))
}

export function useShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
      if (modalOpen()) return
      const target = e.target
      if (e.key === 'Escape') {
        if (ref.current.onEscape?.()) e.preventDefault()
        return
      }
      if (isTypingTarget(target)) return

      const el = target instanceof HTMLElement ? target : null
      const onButton = !!el?.closest('button, a, [role="button"], summary')
      const onRange = el instanceof HTMLInputElement && el.type === 'range'
      const player = usePlayer.getState()
      const hasDoc = !!player.docId

      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          // Let a focused button handle its own Space press.
          if (e.key === ' ' && onButton) return
          if (!hasDoc) return
          e.preventDefault()
          player.toggle()
          return
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (onRange || !hasDoc) return
          e.preventDefault()
          const fwd = e.key === 'ArrowRight'
          if (e.shiftKey) {
            if (fwd) player.nextParagraph()
            else player.prevParagraph()
          } else if (fwd) player.next()
          else player.prev()
          return
        }
        case '+':
        case '=':
        case ']':
          e.preventDefault()
          stepRate(0.25)
          return
        case '-':
        case '_':
        case '[':
          e.preventDefault()
          stepRate(-0.25)
          return
        case '/':
          if (!ref.current.onSearch) return
          e.preventDefault()
          ref.current.onSearch()
          return
        case '?':
          e.preventDefault()
          ref.current.onHelp?.()
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
