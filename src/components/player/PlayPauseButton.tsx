import { Pause, Play } from 'lucide-react'
import { IconButton } from '../ui'
import { usePlayer } from '../../lib/player'
import { cx } from '../../lib/ui-format'

/** Big play/pause with a spinner ring while audio is being prepared. */
export function PlayPauseButton({ size = 'lg', className }: { size?: 'md' | 'lg'; className?: string }) {
  const status = usePlayer((s) => s.status)
  const buffering = usePlayer((s) => s.buffering)
  const active = status === 'playing' || status === 'loading'
  const waiting = status === 'loading' || (status === 'playing' && buffering)
  return (
    <span className={cx('play-btn', `play-btn--${size}`, waiting && 'play-btn--waiting', className)}>
      <IconButton variant="primary" size={size} label={active ? 'Pause' : 'Play'} onClick={() => usePlayer.getState().toggle()}>
        {active ? <Pause /> : <Play className="play-btn__play" />}
      </IconButton>
      {waiting && <span className="play-btn__ring" aria-hidden />}
    </span>
  )
}
