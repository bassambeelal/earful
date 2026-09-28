import { CircleCheck, Download } from 'lucide-react'
import { Button, Callout, Progress } from '../ui'
import { kokoroDownloadSizeMB, loadKokoro, useKokoroStatus } from '../../lib/tts/kokoro'
import { formatBytes } from '../../lib/ui-format'
import './voices.css'

const load = () => {
  loadKokoro().catch(() => {
    /* status store carries the error */
  })
}

/** Download / progress / ready card for the free on-device natural voices. */
export function KokoroCard() {
  const st = useKokoroStatus()

  if (st.state === 'ready') {
    return (
      <div className="kokoro kokoro--ready">
        <CircleCheck className="kokoro__icon" aria-hidden />
        <div className="kokoro__text">
          <strong>Natural voices are ready</strong>
          <span>
            Running on this device{st.device ? ` with ${st.device === 'webgpu' ? 'WebGPU' : 'WebAssembly'}` : ''}. They work offline.
          </span>
        </div>
      </div>
    )
  }

  if (st.state === 'downloading' || st.state === 'loading') {
    const known = st.state === 'downloading' && st.total
    return (
      <div className="kokoro" aria-live="polite">
        <div className="kokoro__text" style={{ flex: 1 }}>
          <strong>{st.state === 'downloading' ? 'Downloading natural voices…' : 'Getting the voices ready…'}</strong>
          <Progress value={st.state === 'downloading' ? st.progress : null} label="Natural voices download" />
          <span>
            {st.state === 'downloading'
              ? known
                ? `${Math.round(st.progress * 100)}% · ${formatBytes(st.loaded ?? 0)} of ${formatBytes(st.total ?? 0)}`
                : `${Math.round(st.progress * 100)}%`
              : 'This takes a few seconds the first time.'}{' '}
            You can keep listening with another voice meanwhile.
          </span>
        </div>
      </div>
    )
  }

  if (st.state === 'error') {
    return (
      <Callout tone="danger">
        <p className="kokoro__error">{st.error || 'The natural voices could not be loaded.'}</p>
        <Button size="sm" onClick={load}>
          Try again
        </Button>
      </Callout>
    )
  }

  return (
    <div className="kokoro">
      <Download className="kokoro__icon" aria-hidden />
      <div className="kokoro__text">
        <strong>Download free natural voices (~{Math.round(kokoroDownloadSizeMB())} MB, one time)</strong>
        <span>Human-sounding voices that run on your device and work offline. No account or key needed.</span>
      </div>
      <Button variant="primary" onClick={load}>
        Download
      </Button>
    </div>
  )
}
