import { Pause, Play } from 'lucide-react'
import type { DocMeta } from '../../types'
import { Button, Progress } from '../ui'
import { Cover } from './Cover'
import { usePlayer } from '../../lib/player'
import { openReader } from '../../lib/router'
import { useUi } from '../../lib/ui-store'
import { progressOf, timeLeftLabel } from '../../lib/ui-format'

/** "Continue listening" hero for the most recent unfinished document. */
export function ContinueCard({ meta, rate }: { meta: DocMeta; rate: number }) {
  const loaded = usePlayer((s) => s.docId === meta.id)
  const playing = usePlayer((s) => s.docId === meta.id && (s.status === 'playing' || s.status === 'loading'))
  const pct = Math.round(progressOf(meta) * 100)

  const onContinue = () => {
    if (loaded) {
      usePlayer.getState().toggle()
      return
    }
    useUi.getState().setAutoplay(meta.id)
    openReader(meta.id)
  }

  return (
    <section className="hero" aria-labelledby="hero-title">
      <button type="button" className="hero__cover" onClick={() => openReader(meta.id)} aria-label={`Open ${meta.title}`}>
        <Cover meta={meta} size="sm" showProgress={false} />
      </button>
      <div className="hero__body">
        <p className="hero__eyebrow">Continue listening</p>
        <h2 className="hero__title" id="hero-title">
          <button type="button" onClick={() => openReader(meta.id)}>
            {meta.title}
          </button>
        </h2>
        <div className="hero__progress">
          <Progress value={progressOf(meta)} label="Progress" />
          <span>
            {pct}% · {timeLeftLabel(meta, rate)}
          </span>
        </div>
      </div>
      <Button className="hero__play" variant="primary" size="lg" icon={playing ? <Pause /> : <Play />} onClick={onContinue}>
        {playing ? 'Pause' : loaded ? 'Resume' : 'Continue'}
      </Button>
    </section>
  )
}
