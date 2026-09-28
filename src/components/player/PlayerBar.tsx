import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AudioLines, Check, CircleAlert, Gauge, Minus, Moon, Plus, SkipBack, SkipForward } from 'lucide-react'
import { Button, IconButton, Popover, Slider } from '../ui'
import { PlayPauseButton } from './PlayPauseButton'
import { useVoiceName } from './useVoices'
import { useLibrary } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { RATE_MAX, RATE_MIN, useSettings } from '../../lib/settings'
import { estimateSeconds, formatDuration } from '../../lib/text'
import { getEngine } from '../../lib/tts/registry'
import { SPEED_PRESETS } from '../../lib/ui-constants'
import { useUi } from '../../lib/ui-store'
import { cx, formatClock, formatRate } from '../../lib/ui-format'
import './player.css'

/** Full player docked at the bottom of the reader. */
export function PlayerBar() {
  return (
    <div className="player" role="region" aria-label="Player">
      <PlayerError />
      <Scrubber />
      <div className="player__row">
        <div className="player__side player__side--left">
          <VoiceChip />
        </div>
        <div className="player__transport">
          <IconButton label="Previous sentence" onClick={() => usePlayer.getState().prev()}>
            <SkipBack />
          </IconButton>
          <PlayPauseButton />
          <IconButton label="Next sentence" onClick={() => usePlayer.getState().next()}>
            <SkipForward />
          </IconButton>
        </div>
        <div className="player__side player__side--right">
          <SpeedChip />
          <SleepChip />
        </div>
      </div>
      <PlayerAnnouncer />
    </div>
  )
}

function clampRate(r: number) {
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(r * 100) / 100))
}

// ---------------------------------------------------------------------------

function Scrubber() {
  const sentence = usePlayer((s) => s.sentence)
  const total = usePlayer((s) => s.total)
  const rate = useSettings((s) => s.rate)
  const sentences = useLibrary((s) => s.open?.sentences)
  const inputRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  dragRef.current = drag

  // Words remaining from each sentence to the end, for "12 min left".
  const suffix = useMemo(() => {
    if (!sentences) return null
    const a = new Float64Array(sentences.length + 1)
    for (let i = sentences.length - 1; i >= 0; i--) a[i] = a[i + 1] + sentences[i].words.length
    return a
  }, [sentences])

  // Native 'change' fires once when the user lets go (React's onChange fires on every move).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const commit = () => {
      const v = dragRef.current
      if (v === null) return
      setDrag(null)
      usePlayer.getState().seek(v)
    }
    el.addEventListener('change', commit)
    return () => el.removeEventListener('change', commit)
  }, [])

  const max = Math.max(0, total - 1)
  const value = Math.min(max, drag ?? sentence)
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const left = suffix && suffix.length > 1 ? estimateSeconds(suffix[Math.min(value, suffix.length - 1)], rate) : null

  return (
    <div className="scrub">
      <span className="scrub__label">{pct}%</span>
      <input
        ref={inputRef}
        type="range"
        className="ui-slider scrub__range"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={total <= 1}
        aria-label="Reading position"
        aria-valuetext={`Sentence ${value + 1} of ${total}`}
        style={{ '--pct': `${max ? (value / max) * 100 : 0}%` } as CSSProperties}
        onChange={(e) => setDrag(Number(e.target.value))}
      />
      <span className="scrub__label scrub__label--end">{left !== null ? `${formatDuration(left)} left` : ''}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------

function VoiceChip() {
  const engine = useSettings((s) => s.engine)
  const voice = useSettings((s) => s.voices[s.engine])
  const name = useVoiceName(engine, voice)
  return (
    <button type="button" className="chip chip--voice" onClick={() => useUi.getState().setVoicePicker(true)} aria-label={`Voice: ${name}. Change voice`} title="Change voice">
      <AudioLines aria-hidden />
      <span className="chip__text">{name}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------

function SpeedChip() {
  const rate = useSettings((s) => s.rate)
  const engineId = useSettings((s) => s.engine)
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // While dragging, show the value immediately but only tell the player once the hand rests.
  const [pending, setPending] = useState<number | null>(null)
  const shown = pending ?? rate

  useEffect(() => {
    if (pending === null) return
    const t = setTimeout(() => {
      usePlayer.getState().setRate(pending)
      setPending(null)
    }, 180)
    return () => clearTimeout(t)
  }, [pending])

  const setNow = (r: number) => {
    setPending(null)
    usePlayer.getState().setRate(clampRate(r))
  }

  let capped = false
  try {
    const eng = getEngine(engineId)
    capped = eng.kind === 'speech' && shown > eng.maxRate
  } catch {
    capped = false
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="chip chip--speed"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Speed ${formatRate(rate)}. Change speed`}
        title="Playback speed"
        onClick={() => setOpen((o) => !o)}
      >
        <Gauge aria-hidden className="hide-sm" />
        <span>{formatRate(rate)}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="top" align="end" label="Playback speed">
        <div className="speed-pop">
          <div className="speed-pop__head">
            <IconButton label="Slower" onClick={() => setNow(shown - 0.05)} disabled={shown <= RATE_MIN}>
              <Minus />
            </IconButton>
            <span className="speed-pop__value" aria-live="polite">
              {formatRate(shown)}
            </span>
            <IconButton label="Faster" onClick={() => setNow(shown + 0.05)} disabled={shown >= RATE_MAX}>
              <Plus />
            </IconButton>
          </div>
          <Slider label="Speed" min={RATE_MIN} max={RATE_MAX} step={0.05} value={shown} onChange={(v) => setPending(clampRate(v))} />
          <div className="speed-pop__presets" role="group" aria-label="Speed presets">
            {SPEED_PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={Math.abs(p - shown) < 0.001} onClick={() => setNow(p)}>
                {formatRate(p)}
              </button>
            ))}
          </div>
          {capped && <p className="speed-pop__hint">Browser voices may not go this fast. Natural and premium voices can reach 4×.</p>}
        </div>
      </Popover>
    </>
  )
}

// ---------------------------------------------------------------------------

const SLEEP_OPTIONS: Array<{ label: string; minutes: number | null }> = [
  { label: 'Off', minutes: null },
  { label: '5 minutes', minutes: 5 },
  { label: '15 minutes', minutes: 15 },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
]

function SleepChip() {
  const sleepAt = usePlayer((s) => s.sleepAt)
  const chapterEnd = usePlayer((s) => s.sleepAtChapterEnd)
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!sleepAt) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [sleepAt])

  const active = !!sleepAt || chapterEnd
  const label = sleepAt ? formatClock(sleepAt - now) : chapterEnd ? 'Chapter' : ''

  const choose = (minutes: number | null, atChapterEnd = false) => {
    const p = usePlayer.getState()
    p.setSleepAtChapterEnd(atChapterEnd)
    p.setSleepTimer(atChapterEnd ? null : minutes)
    setOpen(false)
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx('chip chip--sleep', active && 'chip--active')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={active ? `Sleep timer: ${sleepAt ? `${label} left` : 'end of chapter'}. Change` : 'Sleep timer'}
        title="Sleep timer"
        onClick={() => setOpen((o) => !o)}
      >
        <Moon aria-hidden />
        {label && <span className="chip__text">{label}</span>}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="top" align="end" label="Sleep timer">
        <div className="sleep-pop">
          <p className="pop-title">Stop playing after…</p>
          {SLEEP_OPTIONS.map((o) => {
            const selected = o.minutes === null ? !active : false
            return (
              <button key={o.label} type="button" className="ui-menu-item" aria-pressed={selected} onClick={() => choose(o.minutes)}>
                <span style={{ flex: 1 }}>{o.label}</span>
                {selected && <Check className="pop-check" aria-hidden />}
              </button>
            )
          })}
          <button type="button" className="ui-menu-item" aria-pressed={chapterEnd} onClick={() => choose(null, true)}>
            <span style={{ flex: 1 }}>End of chapter</span>
            {chapterEnd && <Check className="pop-check" aria-hidden />}
          </button>
          {sleepAt && <p className="sleep-pop__left">Stopping in {formatClock(sleepAt - now)}</p>}
        </div>
      </Popover>
    </>
  )
}

// ---------------------------------------------------------------------------

function PlayerError() {
  const error = usePlayer((s) => s.error)
  const engine = useSettings((s) => s.engine)
  if (!error) return null

  const retry = () => {
    const p = usePlayer.getState()
    p.refreshEngine()
    p.play()
  }
  const useFree = () => {
    useSettings.getState().set({ engine: 'browser' })
    const p = usePlayer.getState()
    p.refreshEngine()
    p.play()
  }

  return (
    <div className="player-error" role="alert">
      <CircleAlert aria-hidden />
      <span className="player-error__msg">{error}</span>
      <div className="player-error__actions">
        <Button size="sm" onClick={retry}>
          Try again
        </Button>
        {engine !== 'browser' && (
          <Button size="sm" variant="primary" onClick={useFree}>
            Use free voice
          </Button>
        )}
      </div>
    </div>
  )
}

function PlayerAnnouncer() {
  const status = usePlayer((s) => s.status)
  const buffering = usePlayer((s) => s.buffering)
  const text =
    status === 'loading' ? 'Getting the voice ready' : status === 'playing' ? (buffering ? 'Loading audio' : 'Playing') : status === 'paused' ? 'Paused' : ''
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {text}
    </div>
  )
}
