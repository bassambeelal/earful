import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, Download, FileAudio, KeyRound, Server } from 'lucide-react'
import { Button, Callout, Dialog, Field, Progress, Segmented, Select, Spinner } from '../ui'
import { KokoroCard } from '../voices/KokoroCard'
import { useVoices } from '../player/useVoices'
import { getContent, getDoc } from '../../lib/db'
import { buildOpenDoc, useLibrary, type OpenDoc } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { getSettings, useSettings, type EngineId } from '../../lib/settings'
import { estimateSeconds, formatDuration } from '../../lib/text'
import { ENGINE_INFO, ENGINE_ORDER, getEngine } from '../../lib/tts/registry'
import { isKokoroCached, kokoroDownloadSizeMB, loadKokoro, useKokoroStatus } from '../../lib/tts/kokoro'
import type { VoiceInfo } from '../../lib/tts/types'
import { useUi } from '../../lib/ui-store'
import { errorMessage, formatBytes, formatRate, isAbort, languageName, safeFileName } from '../../lib/ui-format'
import './dialogs.css'

type RangeKind = 'whole' | 'chapter' | 'from'
type Format = 'mp3' | 'wav'

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number; etaSec: number | null }
  | { kind: 'done'; name: string; blob: Blob }
  | { kind: 'error'; message: string }

/** Engines that produce audio clips (browser voices can't be recorded). */
const SYNTH_ENGINES: EngineId[] = ENGINE_ORDER.filter((id) => getEngine(id).kind === 'synth')

/** Bytes per second of audio: 128 kbps MP3, or 24 kHz 16-bit mono WAV. */
const BYTES_PER_SEC: Record<Format, number> = { mp3: 16_000, wav: 48_000 }

interface Readiness {
  ready: boolean
  reason: string | null
}

/** Whether an engine can export now. Downloaded natural voices count: export loads them itself. */
function readinessOf(id: EngineId, kokoroCached: boolean): Readiness {
  const engine = getEngine(id)
  if (engine.isReady()) return { ready: true, reason: null }
  if (id === 'kokoro') {
    const { state } = useKokoroStatus.getState()
    if (state === 'downloading' || state === 'loading' || (kokoroCached && state !== 'error')) return { ready: true, reason: null }
  }
  return { ready: false, reason: engine.notReadyReason() }
}

/** Title of the chapter a sentence belongs to. */
function chapterTitle(doc: OpenDoc, sentence: number): string {
  const block = doc.sentences[sentence]?.block ?? 0
  let title = ''
  for (const ch of [...doc.content.chapters].sort((a, b) => a.block - b.block)) if (ch.block <= block) title = ch.title
  return title.trim() || 'This chapter'
}

/** Inclusive sentence range of the chapter containing `pos`, or null if the document has no chapters. */
function chapterRange(doc: OpenDoc, pos: number): { from: number; to: number; title: string } | null {
  const starts = doc.chapterStarts
  const last = doc.sentences.length - 1
  if (!starts.length || last < 0) return null
  let k = -1
  for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) k = i
  if (k < 0) return starts[0] > 0 ? { from: 0, to: starts[0] - 1, title: 'Opening pages' } : null
  const from = starts[k]
  const to = k + 1 < starts.length ? Math.max(from, starts[k + 1] - 1) : last
  return { from, to, title: chapterTitle(doc, from) }
}

function voiceLabel(v: VoiceInfo): string {
  const extra = [v.description, v.lang ? languageName(v.lang) : null].filter(Boolean).join(', ')
  return extra ? `${v.name} (${extra})` : v.name
}

/** Save a document (or part of it) as an MP3/WAV file with an audio-producing voice. */
export function ExportDialog({ docId }: { docId: string }) {
  const ids = useId()
  const close = () => useUi.getState().setExportDoc(null)

  // --- The document -------------------------------------------------------------------------
  const [doc, setDoc] = useState<OpenDoc | null>(() => {
    const open = useLibrary.getState().open
    return open?.meta.id === docId ? open : null
  })
  const [loadError, setLoadError] = useState<string | null>(null)
  const liveTitle = useLibrary((s) => s.docs.find((d) => d.id === docId)?.title)
  const title = liveTitle ?? doc?.meta.title ?? 'Document'

  useEffect(() => {
    if (doc) return
    let cancelled = false
    Promise.all([getDoc(docId), getContent(docId)])
      .then(([meta, content]) => {
        if (cancelled) return
        if (!meta || !content) setLoadError('This document is no longer in your library.')
        else setDoc(buildOpenDoc(meta, content))
      })
      .catch(() => {
        if (!cancelled) setLoadError('This document could not be opened. Please try again.')
      })
    return () => {
      cancelled = true
    }
  }, [doc, docId])

  // Where the listener is now: the player's position if this document is loaded, else the saved one.
  const [playerPos] = useState(() => {
    const p = usePlayer.getState()
    return p.docId === docId ? p.sentence : null
  })
  const last = doc ? doc.sentences.length - 1 : -1
  const pos = doc ? Math.max(0, Math.min(last, playerPos ?? doc.meta.position ?? 0)) : 0

  // --- Range --------------------------------------------------------------------------------
  const chapter = useMemo(() => (doc ? chapterRange(doc, pos) : null), [doc, pos])
  const rangeOptions = useMemo(() => {
    const opts: Array<{ value: RangeKind; label: string }> = [{ value: 'whole', label: 'Whole document' }]
    if (chapter && !(chapter.from === 0 && chapter.to === last)) opts.push({ value: 'chapter', label: 'Current chapter' })
    if (pos > 0) opts.push({ value: 'from', label: 'From current position' })
    return opts
  }, [chapter, last, pos])
  const [rangeChoice, setRangeChoice] = useState<RangeKind>('whole')
  const range: RangeKind = rangeOptions.some((o) => o.value === rangeChoice) ? rangeChoice : 'whole'
  const [from, to] = range === 'chapter' && chapter ? [chapter.from, chapter.to] : range === 'from' ? [pos, last] : [0, last]

  const stats = useMemo(() => {
    if (!doc || last < 0) return { words: 0, chars: 0 }
    let words = 0
    let chars = 0
    for (let i = from; i <= to; i++) {
      const s = doc.sentences[i]
      words += s.words.length
      chars += s.text.length
    }
    return { words, chars }
  }, [doc, from, to, last])

  const rangeHint =
    range === 'chapter' && chapter
      ? chapter.title
      : range === 'from'
        ? `From ${Math.round((pos / Math.max(1, last)) * 100)}% to the end`
        : doc && doc.chapterStarts.length > 1
          ? `${doc.chapterStarts.length} chapters`
          : null

  // --- Voice --------------------------------------------------------------------------------
  // Re-render when keys, the server address or the local model change.
  useSettings((s) => s.keys)
  useSettings((s) => s.customTtsBaseUrl)
  const currentEngine = useSettings((s) => s.engine)
  const rate = useSettings((s) => s.rate)
  const kokoroState = useKokoroStatus((s) => s.state)
  const [kokoroCached, setKokoroCached] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void isKokoroCached().then((v) => {
      if (!cancelled) setKokoroCached(v)
    })
    return () => {
      cancelled = true
    }
  }, [kokoroState])

  const readiness = Object.fromEntries(SYNTH_ENGINES.map((id) => [id, readinessOf(id, kokoroCached === true)])) as Record<EngineId, Readiness>
  const noneReady = !SYNTH_ENGINES.some((id) => readiness[id].ready)
  const autoEngine: EngineId =
    SYNTH_ENGINES.includes(currentEngine) && readiness[currentEngine].ready
      ? currentEngine
      : (SYNTH_ENGINES.find((id) => readiness[id].ready) ?? (SYNTH_ENGINES.includes(currentEngine) ? currentEngine : 'kokoro'))
  const [engineChoice, setEngineChoice] = useState<EngineId | null>(null)
  const engineId = engineChoice ?? autoEngine
  const engine = getEngine(engineId)
  const info = ENGINE_INFO[engineId]
  const { ready, reason } = readiness[engineId] ?? { ready: false, reason: null }

  const { voices, loading: voicesLoading, error: voicesError } = useVoices(engineId)
  const savedVoice = useSettings((s) => s.voices[engineId])
  const [voiceChoice, setVoiceChoice] = useState<Partial<Record<EngineId, string>>>({})
  const has = (id: string | undefined): id is string => !!id && voices.some((v) => v.id === id)
  const chosen = voiceChoice[engineId]
  const voiceId = has(chosen) ? chosen : has(savedVoice) ? savedVoice : (voices.find((v) => v.recommended)?.id ?? voices[0]?.id ?? savedVoice ?? '')
  const recommended = voices.filter((v) => v.recommended)
  const others = voices.filter((v) => !v.recommended)

  // --- Format, speed, estimate --------------------------------------------------------------
  const [format, setFormat] = useState<Format>('mp3')
  const [speedChoice, setSpeedChoice] = useState<'normal' | 'mine'>('normal')
  const exportRate = speedChoice === 'mine' ? rate : 1
  const seconds = estimateSeconds(stats.words, exportRate)
  const cost = engine.kind === 'synth' && !info.free ? engine.estimateCost(stats.chars) : null

  // --- Running ------------------------------------------------------------------------------
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const ctrlRef = useRef<AbortController | null>(null)
  const downloadRef = useRef<((blob: Blob, name: string) => void) | null>(null)
  const running = phase.kind === 'running'

  // Closing the dialog (or leaving the page section) cancels a running export.
  useEffect(() => () => ctrlRef.current?.abort(), [])

  const resetPhase = () => {
    if (phase.kind === 'done' || phase.kind === 'error') setPhase({ kind: 'idle' })
  }

  const start = async () => {
    if (!doc || running || !ready || stats.words === 0) return
    const ctrl = new AbortController()
    ctrlRef.current?.abort()
    ctrlRef.current = ctrl
    setPhase({ kind: 'running', done: 0, total: 0, etaSec: null })
    const startedAt = performance.now()
    let lock: WakeLockSentinel | null = null
    try {
      // Keep the screen (and so the tab) awake on phones while a long file is made.
      if ('wakeLock' in navigator) lock = await navigator.wakeLock.request('screen').catch(() => null)
      const { exportAudio, downloadBlob } = await import('../../lib/export/audio')
      downloadRef.current = downloadBlob
      const blob = await exportAudio({
        sentences: doc.sentences,
        from,
        to,
        engine: engineId,
        voice: voiceId,
        format,
        filters: getSettings().reading,
        rate: exportRate,
        signal: ctrl.signal,
        onProgress: (done, total) => {
          if (ctrl.signal.aborted) return
          const elapsed = (performance.now() - startedAt) / 1000
          const etaSec = done > 0 && done < total ? (elapsed / done) * (total - done) : null
          setPhase({ kind: 'running', done, total, etaSec })
        },
      })
      if (ctrl.signal.aborted) return
      const suffix = range === 'chapter' && chapter ? ` - ${chapter.title}` : range === 'from' ? ' (continued)' : ''
      const name = `${safeFileName(`${title}${suffix}`, 'Earful audio')}.${format}`
      downloadBlob(blob, name)
      setPhase({ kind: 'done', name, blob })
    } catch (e) {
      if (isAbort(e) || ctrl.signal.aborted) {
        setPhase({ kind: 'idle' })
        return
      }
      setPhase({ kind: 'error', message: errorMessage(e, 'The audio file couldn’t be created. Please try again.') })
    } finally {
      lock?.release().catch(() => {})
      if (ctrlRef.current === ctrl) ctrlRef.current = null
    }
  }

  const cancel = () => ctrlRef.current?.abort()

  const onClose = () => {
    ctrlRef.current?.abort()
    close()
  }

  const openVoiceSettings = (section?: string) => {
    ctrlRef.current?.abort()
    close()
    useUi.getState().openSettings('voices', section ?? null)
  }

  const downloadKokoro = () => {
    setEngineChoice('kokoro')
    loadKokoro().catch(() => {
      /* the status store carries the error */
    })
  }

  // --- Render -------------------------------------------------------------------------------
  const kokoroNeedsCard = engineId === 'kokoro' && !engine.isReady() && (kokoroState !== 'idle' || kokoroCached === false)
  const progressValue = phase.kind === 'running' && phase.total > 0 ? phase.done / phase.total : null
  const progressLabel =
    phase.kind !== 'running'
      ? ''
      : phase.total === 0
        ? engineId === 'kokoro' && !engine.isReady()
          ? 'Getting natural voices ready…'
          : 'Getting started…'
        : phase.done >= phase.total
          ? 'Finishing the file…'
          : `Creating audio… part ${phase.done + 1} of ${phase.total}`

  let body: ReactNode
  if (loadError) {
    body = <Callout tone="danger">{loadError}</Callout>
  } else if (!doc) {
    body = (
      <div className="dlg-center">
        <Spinner label="Opening the document" />
      </div>
    )
  } else {
    body = (
      <div className="dlg-stack">
        <p className="dlg-doc">
          <FileAudio aria-hidden />
          <strong title={title}>{title}</strong>
        </p>

        <fieldset disabled={running} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="dlg-stack">
          <Field label="What to save" hint={rangeHint}>
            {rangeOptions.length > 1 ? (
              <div className="dlg-seg-wrap">
                <Segmented
                  label="What to save"
                  value={range}
                  options={rangeOptions}
                  onChange={(v) => {
                    setRangeChoice(v)
                    resetPhase()
                  }}
                />
              </div>
            ) : (
              <p className="dlg-text">Whole document</p>
            )}
          </Field>

          {noneReady && kokoroCached === null ? null : noneReady && kokoroState !== 'error' ? (
            <Callout icon={<Download />}>
              <p className="dlg-callout-text">
                To save audio you need a voice that creates sound files. Browser voices play through your device’s speech system and can’t be recorded.
                Download the free natural voices (they run on your device), or add a key for a premium voice.
              </p>
              <div className="dlg-actions">
                <Button size="sm" variant="primary" icon={<Download />} onClick={downloadKokoro}>
                  Download natural voices (~{kokoroDownloadSizeMB()} MB)
                </Button>
                <Button size="sm" icon={<KeyRound />} onClick={() => openVoiceSettings()}>
                  Add a key
                </Button>
              </div>
            </Callout>
          ) : (
            <>
              <div className="dlg-grid">
                <Field label="Voice type" htmlFor={`${ids}-engine`}>
                  <Select
                    id={`${ids}-engine`}
                    value={engineId}
                    onChange={(e) => {
                      setEngineChoice(e.target.value as EngineId)
                      resetPhase()
                    }}
                  >
                    {SYNTH_ENGINES.map((id) => (
                      <option key={id} value={id}>
                        {ENGINE_INFO[id].label}
                        {readiness[id].ready ? '' : ' (not set up)'}
                      </option>
                    ))}
                  </Select>
                </Field>

                {ready && (
                  <Field label="Voice" htmlFor={`${ids}-voice`} error={voicesError}>
                    <Select
                      id={`${ids}-voice`}
                      value={voiceId}
                      disabled={voicesLoading || !voices.length}
                      onChange={(e) => {
                        setVoiceChoice((c) => ({ ...c, [engineId]: e.target.value }))
                        resetPhase()
                      }}
                    >
                      {voicesLoading && <option value={voiceId}>Loading voices…</option>}
                      {!voicesLoading && !voices.length && <option value={voiceId}>{voiceId || 'Default voice'}</option>}
                      {recommended.length > 0 && others.length > 0 ? (
                        <>
                          <optgroup label="Recommended">
                            {recommended.map((v) => (
                              <option key={v.id} value={v.id}>
                                {voiceLabel(v)}
                              </option>
                            ))}
                          </optgroup>
                          <optgroup label="More voices">
                            {others.map((v) => (
                              <option key={v.id} value={v.id}>
                                {voiceLabel(v)}
                              </option>
                            ))}
                          </optgroup>
                        </>
                      ) : (
                        voices.map((v) => (
                          <option key={v.id} value={v.id}>
                            {voiceLabel(v)}
                          </option>
                        ))
                      )}
                    </Select>
                  </Field>
                )}
              </div>

              {kokoroNeedsCard ? (
                <KokoroCard />
              ) : (
                !ready &&
                reason && (
                  <Callout tone="warning" icon={info.needsKey ? <KeyRound /> : engineId === 'custom' ? <Server /> : undefined}>
                    <p className="dlg-callout-text">{reason}</p>
                    {(info.needsKey || engineId === 'custom') && (
                      <div className="dlg-actions">
                        <Button size="sm" onClick={() => openVoiceSettings(engineId)}>
                          {engineId === 'custom' ? 'Set up your server' : `Add your ${info.label} key`}
                        </Button>
                      </div>
                    )}
                  </Callout>
                )
              )}
            </>
          )}

          <div className="dlg-grid">
            <Field label="File type" hint={format === 'mp3' ? 'Smaller files that play everywhere.' : 'Uncompressed, for editing. Much larger.'}>
              <Segmented
                label="File type"
                value={format}
                options={[
                  { value: 'mp3', label: 'MP3' },
                  { value: 'wav', label: 'WAV' },
                ]}
                onChange={(v) => {
                  setFormat(v)
                  resetPhase()
                }}
              />
            </Field>
            {rate !== 1 && (
              <Field label="Speed" hint="Speech is sped up without changing the pitch.">
                <Segmented
                  label="Speed"
                  value={speedChoice}
                  options={[
                    { value: 'normal', label: 'Normal (1×)' },
                    { value: 'mine', label: `Yours (${formatRate(rate)})` },
                  ]}
                  onChange={(v) => {
                    setSpeedChoice(v)
                    resetPhase()
                  }}
                />
              </Field>
            )}
          </div>
        </fieldset>

        {stats.words > 0 ? (
          <dl className="dlg-estimate" aria-label="Estimate">
            <div>
              <dt>Length</dt>
              <dd>≈ {formatDuration(seconds)}</dd>
            </div>
            <div>
              <dt>File size</dt>
              <dd>≈ {formatBytes(seconds * BYTES_PER_SEC[format])}</dd>
            </div>
            {cost && (
              <div>
                <dt>Cost to your {info.label} account</dt>
                <dd>{cost}</dd>
              </div>
            )}
          </dl>
        ) : (
          <Callout tone="warning">There’s nothing to read aloud in this part.</Callout>
        )}

        {cost && phase.kind === 'idle' && (
          <p className="dlg-muted">You pay {info.label} directly with your key. Sentences you’ve already listened to with this voice are reused for free.</p>
        )}
        {engineId === 'kokoro' && ready && phase.kind === 'idle' && stats.words > 3000 && (
          <p className="dlg-muted">Natural voices make audio on your device, so a long document can take a while. Keep this tab open until it finishes.</p>
        )}

        {phase.kind === 'running' && (
          <div className="dlg-progress">
            <div className="dlg-progress__row" aria-live="polite">
              <span>{progressLabel}</span>
              {progressValue !== null && <strong>{Math.round(progressValue * 100)}%</strong>}
            </div>
            <Progress value={progressValue} label="Export progress" />
            <p className="dlg-muted">
              {phase.etaSec !== null && phase.etaSec > 5 ? `About ${formatDuration(phase.etaSec)} left. ` : ''}
              Keep this tab open. You can cancel at any time.
            </p>
          </div>
        )}

        {phase.kind === 'done' && (
          <div className="dlg-done" role="status">
            <CircleCheck aria-hidden />
            <div className="dlg-stack dlg-stack--tight">
              <p>
                Saved <strong>{phase.name}</strong> ({formatBytes(phase.blob.size)}) to your downloads.
              </p>
              <div>
                <Button size="sm" icon={<Download />} onClick={() => downloadRef.current?.(phase.blob, phase.name)}>
                  Download again
                </Button>
              </div>
            </div>
          </div>
        )}

        {phase.kind === 'error' && <Callout tone="danger">{phase.message}</Callout>}
      </div>
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Save as audio"
      footer={
        running ? (
          <Button onClick={cancel}>Cancel export</Button>
        ) : (
          <>
            <Button onClick={onClose}>{phase.kind === 'done' ? 'Close' : 'Cancel'}</Button>
            <Button
              variant="primary"
              icon={<Download />}
              onClick={() => void start()}
              disabled={!doc || !ready || noneReady || stats.words === 0 || (ready && voicesLoading)}
            >
              {phase.kind === 'done' ? 'Export again' : phase.kind === 'error' ? 'Try again' : `Export ${format.toUpperCase()}`}
            </Button>
          </>
        )
      }
    >
      {body}
    </Dialog>
  )
}
