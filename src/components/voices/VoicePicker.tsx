import { useMemo, useState } from 'react'
import { Check, Cloud, Cpu, KeyRound, Search, Server, Volume2, Zap } from 'lucide-react'
import type { EngineId } from '../../lib/settings'
import type { VoiceInfo } from '../../lib/tts/types'
import { Badge, Button, Callout, Dialog, IconButton, Input, Spinner, toast } from '../ui'
import { KokoroCard } from './KokoroCard'
import { useVoices } from '../player/useVoices'
import { usePlayer } from '../../lib/player'
import { useSettings } from '../../lib/settings'
import { ENGINE_INFO, ENGINE_ORDER, getEngine } from '../../lib/tts/registry'
import { useKokoroStatus } from '../../lib/tts/kokoro'
import { VOICE_PREVIEW_TEXT } from '../../lib/ui-constants'
import { useUi } from '../../lib/ui-store'
import { cx, errorMessage, languageName, searchKey } from '../../lib/ui-format'
import './voices.css'

export function EngineIcon({ id }: { id: EngineId }) {
  if (id === 'browser') return <Zap aria-hidden />
  if (id === 'kokoro') return <Cpu aria-hidden />
  if (id === 'custom') return <Server aria-hidden />
  return <Cloud aria-hidden />
}

/** Free / Offline / Your key badges for an engine. */
export function EngineBadges({ id }: { id: EngineId }) {
  const info = ENGINE_INFO[id]
  return (
    <span className="engine-badges">
      {info.free && <Badge tone="success">Free</Badge>}
      {info.offline && <Badge>Offline</Badge>}
      {info.needsKey && <Badge tone="warning">Your key</Badge>}
      {info.priceHint && <span className="engine-badges__price">{info.priceHint}</span>}
    </span>
  )
}

function engineReady(id: EngineId): { ready: boolean; reason: string | null } {
  try {
    const e = getEngine(id)
    return { ready: e.isReady(), reason: e.isReady() ? null : e.notReadyReason() }
  } catch (err) {
    return { ready: false, reason: errorMessage(err) }
  }
}

/** Voice picker: choose an engine, then a voice (with previews). */
export function VoicePicker() {
  const open = useUi((s) => s.voicePicker)
  const current = useSettings((s) => s.engine)
  const [view, setView] = useState<EngineId>(current)
  // Readiness depends on keys and the local model; subscribe so the list refreshes.
  useSettings((s) => s.keys)
  useSettings((s) => s.customTtsBaseUrl)
  useKokoroStatus((s) => s.state)

  const close = () => useUi.getState().setVoicePicker(false)

  return (
    <Dialog open={open} onClose={close} title="Choose a voice" wide>
      <div className="vp">
        <ul className="vp__engines" aria-label="Kinds of voices">
          {ENGINE_ORDER.map((id) => {
            const info = ENGINE_INFO[id]
            const { ready } = engineReady(id)
            return (
              <li key={id}>
                <button
                  type="button"
                  className={cx('engine-row', view === id && 'engine-row--selected', !ready && 'engine-row--unready')}
                  aria-current={view === id ? 'true' : undefined}
                  onClick={() => setView(id)}
                >
                  <span className="engine-row__icon">
                    <EngineIcon id={id} />
                  </span>
                  <span className="engine-row__text">
                    <span className="engine-row__label">
                      {info.label}
                      {current === id && <Badge tone="accent">In use</Badge>}
                    </span>
                    <span className="engine-row__desc">{info.description}</span>
                    <EngineBadges id={id} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="vp__voices">
          <EngineVoices key={view} engineId={view} onDone={close} />
        </div>
      </div>
    </Dialog>
  )
}

function groupVoices(voices: VoiceInfo[], filter: string): Array<{ label: string; voices: VoiceInfo[] }> {
  const q = searchKey(filter.trim())
  const list = q
    ? voices.filter((v) => searchKey(`${v.name} ${v.lang ?? ''} ${languageName(v.lang)} ${v.description ?? ''}`).includes(q))
    : voices
  const groups: Array<{ label: string; voices: VoiceInfo[] }> = []
  const recommended = list.filter((v) => v.recommended)
  if (recommended.length) groups.push({ label: 'Recommended', voices: recommended })
  const byLang = new Map<string, VoiceInfo[]>()
  for (const v of list) {
    if (v.recommended) continue
    const base = v.lang?.split(/[-_]/)[0]?.toLowerCase() || ''
    const arr = byLang.get(base)
    if (arr) arr.push(v)
    else byLang.set(base, [v])
  }
  const mine = (navigator.language || 'en').split('-')[0].toLowerCase()
  const langs = [...byLang.keys()].sort((a, b) => {
    if (a === mine) return -1
    if (b === mine) return 1
    return languageName(a).localeCompare(languageName(b))
  })
  for (const l of langs) groups.push({ label: l ? languageName(l) : 'Other', voices: byLang.get(l)! })
  return groups
}

function EngineVoices({ engineId, onDone }: { engineId: EngineId; onDone: () => void }) {
  const info = ENGINE_INFO[engineId]
  const current = useSettings((s) => s.engine)
  const selectedVoice = useSettings((s) => s.voices[engineId])
  const hasKey = useSettings((s) => (info.needsKey ? !!s.keys[info.needsKey] : true))
  const { voices, loading, error } = useVoices(engineId)
  const [filter, setFilter] = useState('')
  const [previewing, setPreviewing] = useState<string | null>(null)
  const groups = useMemo(() => groupVoices(voices, filter), [voices, filter])
  const { ready, reason } = engineReady(engineId)
  const missingKey = !!info.needsKey && !hasKey

  const choose = (v: VoiceInfo) => {
    const s = useSettings.getState()
    s.setVoice(engineId, v.id)
    if (s.engine !== engineId) s.set({ engine: engineId })
    usePlayer.getState().refreshEngine()
  }

  const useEngine = () => {
    useSettings.getState().set({ engine: engineId })
    usePlayer.getState().refreshEngine()
    toast(`Now using ${info.label}.`)
  }

  const preview = async (v: VoiceInfo) => {
    choose(v)
    setPreviewing(v.id)
    try {
      await usePlayer.getState().speakText(VOICE_PREVIEW_TEXT)
    } catch (e) {
      toast.error(errorMessage(e, 'This voice could not be previewed.'))
    } finally {
      setPreviewing((p) => (p === v.id ? null : p))
    }
  }

  const addKey = () => useUi.getState().openSettings('voices', engineId)

  return (
    <div className="ev">
      <div className="ev__head">
        <div>
          <h3 className="ev__title">{info.label}</h3>
          <p className="ev__desc">{info.description}</p>
        </div>
        {current !== engineId && ready && !missingKey && (
          <Button size="sm" onClick={useEngine}>
            Use {info.label}
          </Button>
        )}
      </div>

      {engineId === 'kokoro' && <KokoroCard />}

      {missingKey ? (
        <Callout icon={<KeyRound />}>
          <p className="ev__callout-text">
            Add your own {info.label} key to use these voices. You pay the provider directly, only for what you listen to
            {info.priceHint ? ` (${info.priceHint})` : ''}. Audio is saved on your device so the same sentence never costs twice.
          </p>
          <Button size="sm" variant="primary" icon={<KeyRound />} onClick={addKey}>
            Add your key
          </Button>
        </Callout>
      ) : (
        !ready &&
        engineId !== 'kokoro' &&
        reason && (
          <Callout tone="warning">
            <p className="ev__callout-text">{reason}</p>
            {engineId === 'custom' && (
              <Button size="sm" onClick={addKey}>
                Set up your server
              </Button>
            )}
          </Callout>
        )
      )}

      {!missingKey && (
        <>
          {voices.length > 12 && (
            <div className="ev__filter">
              <Search aria-hidden />
              <Input type="search" placeholder="Filter by name or language" aria-label="Filter voices" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
          {loading ? (
            <div className="ev__loading">
              <Spinner label="Loading voices" />
            </div>
          ) : error ? (
            <Callout tone="warning">{error}</Callout>
          ) : voices.length === 0 ? (
            <p className="ev__empty">
              {engineId === 'browser'
                ? 'Your browser has not listed any voices yet. Some systems add voices after a moment, or when a language pack is installed.'
                : 'No voices found.'}
            </p>
          ) : groups.length === 0 ? (
            <p className="ev__empty">No voices match “{filter}”.</p>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="ev__group" aria-label={g.label}>
                <h4 className="ev__group-title">{g.label}</h4>
                <ul className="ev__list">
                  {g.voices.map((v) => {
                    const selected = current === engineId && selectedVoice === v.id
                    const meta = [v.description, v.lang ? languageName(v.lang) : null].filter(Boolean).join(' · ')
                    return (
                      <li key={v.id} className={cx('voice-row', selected && 'voice-row--selected')}>
                        <button type="button" className="voice-row__main" aria-pressed={selected} onClick={() => choose(v)} onDoubleClick={onDone}>
                          <span className="voice-row__check" aria-hidden>
                            {selected && <Check />}
                          </span>
                          <span className="voice-row__text">
                            <span className="voice-row__name">{v.name}</span>
                            {meta && <span className="voice-row__meta">{meta}</span>}
                          </span>
                        </button>
                        <IconButton size="sm" label={`Preview ${v.name}`} disabled={!ready || previewing === v.id} onClick={() => void preview(v)}>
                          {previewing === v.id ? <Spinner label="Playing preview" /> : <Volume2 />}
                        </IconButton>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}
