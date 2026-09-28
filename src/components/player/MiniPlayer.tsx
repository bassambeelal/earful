import type { CSSProperties } from 'react'
import { ChevronUp } from 'lucide-react'
import { IconButton } from '../ui'
import { PlayPauseButton } from './PlayPauseButton'
import { useLibrary } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { openReader } from '../../lib/router'
import './player.css'

/** Compact "now playing" bar shown in the library while a document is loaded. */
export function MiniPlayer() {
  const docId = usePlayer((s) => s.docId)
  const title = usePlayer((s) => s.title)
  const status = usePlayer((s) => s.status)
  const buffering = usePlayer((s) => s.buffering)
  const pct = usePlayer((s) => (s.total > 1 ? Math.round((s.sentence / (s.total - 1)) * 100) : 0))
  const hue = useLibrary((s) => s.docs.find((d) => d.id === docId)?.hue ?? 250)
  if (!docId) return null

  const state =
    status === 'loading' || (status === 'playing' && buffering) ? 'Getting ready…' : status === 'playing' ? 'Playing' : status === 'error' ? 'Stopped' : 'Paused'

  return (
    <div className="mini-player" role="region" aria-label="Now playing">
      <span className="mini-player__bar" style={{ width: `${pct}%` }} aria-hidden />
      <button type="button" className="mini-player__info" onClick={() => openReader(docId)} aria-label={`Open ${title} in the reader`}>
        <span className="mini-player__art" style={{ '--h': hue } as CSSProperties} aria-hidden />
        <span className="mini-player__text">
          <span className="mini-player__title">{title || 'Untitled'}</span>
          <span className="mini-player__sub">
            {state} · {pct}%
          </span>
        </span>
      </button>
      <PlayPauseButton size="md" />
      <IconButton label="Open reader" onClick={() => openReader(docId)}>
        <ChevronUp />
      </IconButton>
    </div>
  )
}
