import { useEffect, useState, type ReactNode } from 'react'
import { AudioLines, Download, KeyRound, RefreshCw, Trash2 } from 'lucide-react'
import { Badge, Button, Callout, Field, Input, Progress, Segmented, Select, Switch, Textarea, toast } from '../ui'
import { useVoiceName } from '../player/useVoices'
import { ExternalLink, KeyInput, ModelInput, SetGroup, TestButton } from './parts'
import { useSettings, type EngineId, type Settings } from '../../lib/settings'
import { ENGINE_INFO, ENGINE_ORDER, getEngine, testEngine } from '../../lib/tts/registry'
import { deleteKokoroCache, isKokoroCached, kokoroDownloadSizeMB, loadKokoro, unloadKokoro, useKokoroStatus } from '../../lib/tts/kokoro'
import { KEY_LINKS, TTS_MODEL_SUGGESTIONS } from '../../lib/ui-constants'
import { useUi } from '../../lib/ui-store'
import { errorMessage, formatBytes } from '../../lib/ui-format'

type CloudEngine = 'openai' | 'gemini' | 'elevenlabs' | 'groq'
const CLOUD_ENGINES: CloudEngine[] = ['openai', 'gemini', 'elevenlabs', 'groq']

function readiness(id: EngineId): { ready: boolean; reason: string | null } {
  try {
    const e = getEngine(id)
    const ready = e.isReady()
    return { ready, reason: ready ? null : e.notReadyReason() }
  } catch (err) {
    return { ready: false, reason: errorMessage(err) }
  }
}

function switchEngine(id: EngineId) {
  const s = useSettings.getState()
  s.set({ engine: id })
  toast(`Now reading with ${ENGINE_INFO[id].label}.`)
}

export function VoicesTab() {
  return (
    <>
      <DefaultEngine />
      <KokoroSettings />
      <Callout icon={<KeyRound />}>
        <p className="set-callout-text">
          <strong>Premium voices use your own API key.</strong> You pay the provider directly, only for what you listen to. Keys are saved only in this
          browser and are sent only to that provider. A key you add here is also used by the AI tools for the same provider (OpenAI, Gemini, Groq and
          your own server).
        </p>
      </Callout>
      {CLOUD_ENGINES.map((id) => (
        <CloudEngineSettings key={id} id={id} />
      ))}
      <CustomServerSettings />
    </>
  )
}

// ---------------------------------------------------------------------------
// Default engine
// ---------------------------------------------------------------------------

function DefaultEngine() {
  const engine = useSettings((s) => s.engine)
  const voice = useSettings((s) => s.voices[engine])
  // Readiness depends on keys, the server address and the local model.
  useSettings((s) => s.keys)
  useSettings((s) => s.customTtsBaseUrl)
  useKokoroStatus((s) => s.state)
  const voiceName = useVoiceName(engine, voice)
  const { ready, reason } = readiness(engine)

  const chooseVoice = () => {
    const ui = useUi.getState()
    ui.closeSettings()
    ui.setVoicePicker(true)
  }

  return (
    <SetGroup id="settings-engine" title="Voice for reading" description="Pick the kind of voice Earful reads with. You can switch at any time from the player.">
      <div className="set-row">
        <Field label="Voice type" htmlFor="settings-engine-select" hint={ready ? ENGINE_INFO[engine].description : reason}>
          <Select id="settings-engine-select" value={engine} onChange={(e) => useSettings.getState().set({ engine: e.target.value as EngineId })}>
            {ENGINE_ORDER.map((id) => (
              <option key={id} value={id}>
                {ENGINE_INFO[id].label}
                {readiness(id).ready ? '' : ' (needs setup)'}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="set-actions">
        <span className="set-muted">
          Voice: <strong>{voiceName}</strong>
        </span>
        <Button size="sm" icon={<AudioLines />} onClick={chooseVoice}>
          Choose a voice
        </Button>
      </div>
    </SetGroup>
  )
}

// ---------------------------------------------------------------------------
// Kokoro (offline natural voices)
// ---------------------------------------------------------------------------

const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator

function KokoroSettings() {
  const st = useKokoroStatus()
  const device = useSettings((s) => s.kokoro.device)
  const autoload = useSettings((s) => s.kokoro.autoload)
  const engine = useSettings((s) => s.engine)
  const [cached, setCached] = useState<boolean | null>(null)
  const [recheck, setRecheck] = useState(0)
  const [removing, setRemoving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void isKokoroCached().then((v) => {
      if (!cancelled) setCached(v)
    })
    return () => {
      cancelled = true
    }
  }, [st.state, recheck])

  const setKokoro = (patch: Partial<Settings['kokoro']>) => {
    const s = useSettings.getState()
    s.set({ kokoro: { ...s.kokoro, ...patch } })
  }

  const load = () => {
    loadKokoro().catch(() => {
      /* the status store carries the error */
    })
  }

  const reload = () => {
    unloadKokoro()
    load()
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await deleteKokoroCache()
      setKokoro({ autoload: false })
      if (useSettings.getState().engine === 'kokoro') {
        useSettings.getState().set({ engine: 'browser' })
        toast('Natural voices removed. Earful will use browser voices for now.')
      } else {
        toast('Natural voices removed from this device.')
      }
    } catch (e) {
      toast.error(errorMessage(e, 'The downloaded voices could not be removed.'))
    } finally {
      setRemoving(false)
      setRecheck((n) => n + 1)
    }
  }

  const downloaded = cached === true || st.state === 'ready'
  const busy = st.state === 'downloading' || st.state === 'loading'
  const deviceLabel = st.device === 'webgpu' ? 'WebGPU' : st.device === 'wasm' ? 'WebAssembly' : null
  const deviceMismatch = st.state === 'ready' && device !== 'auto' && st.device !== null && st.device !== device && (device !== 'webgpu' || hasWebGpu)

  let status: ReactNode
  switch (st.state) {
    case 'downloading':
      status = (
        <div className="set-kokoro__progress" aria-live="polite">
          <Progress value={st.progress} label="Natural voices download" />
          <span className="set-muted">
            Downloading… {Math.round(st.progress * 100)}%
            {st.total ? ` · ${formatBytes(st.loaded ?? 0)} of ${formatBytes(st.total)}` : ''}
          </span>
        </div>
      )
      break
    case 'loading':
      status = (
        <div className="set-kokoro__progress" aria-live="polite">
          <Progress value={null} label="Preparing natural voices" />
          <span className="set-muted">Getting the voices ready…</span>
        </div>
      )
      break
    case 'ready':
      status = (
        <p className="set-status set-status--ok">
          <Badge tone="success">Ready</Badge>
          Running on this device{deviceLabel ? ` with ${deviceLabel}` : ''}. Works offline.
        </p>
      )
      break
    case 'error':
      status = (
        <Callout tone="danger">
          <p className="set-callout-text">{st.error || 'The natural voices could not be loaded.'}</p>
        </Callout>
      )
      break
    default:
      status = (
        <p className="set-status">
          {downloaded ? (
            <>
              <Badge tone="success">Downloaded</Badge>
              They load in a few seconds the first time you use them.
            </>
          ) : (
            <>
              <Badge>Not downloaded</Badge>A one-time download of about {kokoroDownloadSizeMB()} MB. No account or key needed.
            </>
          )}
        </p>
      )
  }

  return (
    <SetGroup
      id="settings-kokoro"
      title={ENGINE_INFO.kokoro.label}
      badges={
        <>
          <Badge tone="success">Free</Badge>
          <Badge>Offline</Badge>
          {engine === 'kokoro' && <Badge tone="accent">In use</Badge>}
        </>
      }
      description={ENGINE_INFO.kokoro.description}
    >
      {status}

      <div className="set-actions">
        {busy ? (
          <Button size="sm" onClick={() => unloadKokoro()}>
            Stop
          </Button>
        ) : st.state === 'ready' ? null : st.state === 'error' ? (
          <Button size="sm" variant="primary" icon={<RefreshCw />} onClick={load}>
            Try again
          </Button>
        ) : downloaded ? (
          <Button size="sm" onClick={load}>
            Load now
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Download />} onClick={load}>
            Download (~{kokoroDownloadSizeMB()} MB)
          </Button>
        )}
        {engine !== 'kokoro' && (st.state === 'ready' || downloaded) && !busy && (
          <Button size="sm" onClick={() => switchEngine('kokoro')}>
            Use for reading
          </Button>
        )}
        {downloaded && !busy && (
          <Button size="sm" variant="danger" icon={<Trash2 />} loading={removing} onClick={() => void remove()}>
            Remove download
          </Button>
        )}
      </div>

      <Field
        label="Run on"
        hint={
          hasWebGpu
            ? 'WebGPU uses your graphics chip and is usually much faster. WebAssembly works everywhere. Changes apply the next time the voices load.'
            : 'This browser doesn’t support WebGPU, so WebAssembly is used.'
        }
      >
        <div className="set-seg-wrap">
          <Segmented
            label="Run natural voices on"
            value={device}
            onChange={(v) => setKokoro({ device: v })}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'webgpu', label: 'WebGPU', title: hasWebGpu ? undefined : 'Not supported in this browser' },
              { value: 'wasm', label: 'WebAssembly' },
            ]}
          />
        </div>
      </Field>
      {deviceMismatch && (
        <div className="set-actions">
          <span className="set-muted">The voices are still running with {deviceLabel}.</span>
          <Button size="sm" icon={<RefreshCw />} onClick={reload}>
            Reload now
          </Button>
        </div>
      )}

      <Switch
        checked={autoload}
        disabled={!downloaded && !autoload}
        onChange={(v) => setKokoro({ autoload: v })}
        label="Load when Earful opens"
        hint={downloaded ? 'Natural voices are ready as soon as you press play.' : 'Available after the voices have been downloaded once.'}
      />
    </SetGroup>
  )
}

// ---------------------------------------------------------------------------
// Cloud voices (bring your own key)
// ---------------------------------------------------------------------------

const SHARED_WITH_AI: Partial<Record<CloudEngine, string>> = {
  openai: 'Also used for OpenAI in the AI tools.',
  gemini: 'Also used for Gemini in the AI tools.',
  groq: 'Also used for Groq in the AI tools.',
}

function CloudEngineSettings({ id }: { id: CloudEngine }) {
  const info = ENGINE_INFO[id]
  const key = useSettings((s) => s.keys[id] ?? '')
  const model = useSettings((s) => s.ttsModels[id])
  const instructions = useSettings((s) => s.openaiInstructions)
  const engine = useSettings((s) => s.engine)
  const base = `settings-${id}`

  return (
    <SetGroup
      id={base}
      title={info.label}
      badges={
        <>
          {key ? <Badge tone="success">Key saved</Badge> : <Badge tone="warning">Your key</Badge>}
          {engine === id && <Badge tone="accent">In use</Badge>}
          {info.priceHint && <span className="set-price">{info.priceHint}</span>}
        </>
      }
      description={info.description}
    >
      <KeyInput id={`${base}-key`} keyId={id} label={`${info.label} API key`} hint={SHARED_WITH_AI[id]} link={KEY_LINKS[id]} />
      <ModelInput
        id={`${base}-model`}
        value={model}
        onChange={(v) => useSettings.getState().setTtsModel(id, v)}
        suggestions={TTS_MODEL_SUGGESTIONS[id]}
        hint="The suggested model is a good choice. Any model name the provider offers will work."
      />
      {id === 'openai' && (
        <Field
          label="Speaking style (optional)"
          htmlFor={`${base}-style`}
          hint="Tell the voice how to sound. Works with gpt-4o-mini-tts; older models ignore it."
        >
          <Textarea
            id={`${base}-style`}
            value={instructions}
            onChange={(e) => useSettings.getState().set({ openaiInstructions: e.target.value })}
            placeholder="For example: Speak calmly and warmly, like an audiobook narrator."
            rows={3}
            maxLength={2000}
            style={{ minHeight: 80 }}
          />
        </Field>
      )}
      <TestButton run={() => testEngine(id)} signature={`${key}|${model}|${id === 'openai' ? instructions : ''}`} disabled={!key}>
        {key && engine !== id && (
          <Button size="sm" onClick={() => switchEngine(id)}>
            Use for reading
          </Button>
        )}
      </TestButton>
    </SetGroup>
  )
}

function CustomServerSettings() {
  const baseUrl = useSettings((s) => s.customTtsBaseUrl)
  const model = useSettings((s) => s.ttsModels.custom)
  const key = useSettings((s) => s.keys.custom ?? '')
  const engine = useSettings((s) => s.engine)

  return (
    <SetGroup
      id="settings-custom"
      title={ENGINE_INFO.custom.label}
      badges={
        <>
          <Badge tone="success">Free</Badge>
          {engine === 'custom' && <Badge tone="accent">In use</Badge>}
        </>
      }
      description={
        <>
          {ENGINE_INFO.custom.description} For example{' '}
          <ExternalLink href="https://github.com/remsky/Kokoro-FastAPI">Kokoro-FastAPI</ExternalLink>. Your server must allow requests from this site
          (CORS).
        </>
      }
    >
      <Field label="Server address" htmlFor="settings-custom-url" hint="The address that ends in /v1. Earful adds /audio/speech itself.">
        <Input
          id="settings-custom-url"
          type="url"
          inputMode="url"
          value={baseUrl}
          onChange={(e) => useSettings.getState().set({ customTtsBaseUrl: e.target.value })}
          placeholder="http://localhost:8880/v1"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <ModelInput
        id="settings-custom-model"
        value={model}
        onChange={(v) => useSettings.getState().setTtsModel('custom', v)}
        suggestions={TTS_MODEL_SUGGESTIONS.custom}
        hint="Use the model name your server expects."
      />
      <KeyInput
        id="settings-custom-key"
        keyId="custom"
        label="API key (optional)"
        placeholder="Only if your server asks for one"
        hint="Shared with “Custom (OpenAI-compatible)” in the AI tools."
      />
      <TestButton run={() => testEngine('custom')} signature={`${baseUrl}|${model}|${key}`} disabled={!baseUrl.trim()}>
        {baseUrl.trim() && engine !== 'custom' && (
          <Button size="sm" onClick={() => switchEngine('custom')}>
            Use for reading
          </Button>
        )}
      </TestButton>
    </SetGroup>
  )
}
