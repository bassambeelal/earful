import { useEffect, useState } from 'react'
import { Cpu, Download, ExternalLink, KeyRound, Settings } from 'lucide-react'
import { aiNotReadyReason, describeAiError, isAbortError, prepareChromeAi, providerInfo, refreshChromeAi, useChromeAi } from '../../lib/ai'
import { useSettings } from '../../lib/settings'
import { Button, Callout, Progress } from '../ui'

/** Shown instead of the tools when no AI provider is usable yet. */
export function AiSetup({ onOpenSettings }: { onOpenSettings: () => void }) {
  const chrome = useChromeAi()
  const setAi = useSettings((s) => s.setAi)
  // Re-render when anything the readiness reason depends on changes.
  useSettings((s) => s.keys)
  useSettings((s) => s.ai.models)
  useSettings((s) => s.ai.customBaseUrl)
  const provider = useSettings((s) => s.ai.provider)
  const hasKey = useSettings((s) => provider !== 'chrome' && provider !== 'custom' && !!s.keys[provider]?.trim())
  const [error, setError] = useState<string | null>(null)
  const reason = aiNotReadyReason()

  // Chrome's status can change outside this page (model evicted, download finished).
  // Re-check on open, and keep checking while Chrome downloads the model on its own.
  const browserDownloading = chrome.status === 'downloading' && chrome.progress === null
  useEffect(() => {
    void refreshChromeAi()
    if (!browserDownloading) return
    const t = setInterval(() => void refreshChromeAi(), 5000)
    return () => clearInterval(t)
  }, [browserDownloading])

  const enableChrome = async () => {
    setError(null)
    try {
      if (chrome.status !== 'available') await prepareChromeAi()
      setAi({ provider: 'chrome' })
    } catch (e) {
      if (!isAbortError(e)) setError(describeAiError(e))
    }
  }

  const gemini = providerInfo('gemini')
  const groq = providerInfo('groq')
  const downloading = chrome.status === 'downloading'

  return (
    <div className="ai-empty">
      <div className="ai-empty__icon" aria-hidden>
        <KeyRound />
      </div>
      <h3 className="ai-empty__title">Bring your own AI</h3>
      <p className="ai-empty__text">
        Use your own API key — it stays in this browser and requests go straight to the provider. Earful never sees your documents or your key.
      </p>
      {reason && <p className="ai-muted ai-empty__reason">{reason}</p>}
      <Button variant="primary" icon={<Settings />} onClick={onOpenSettings}>
        {hasKey || provider === 'custom' ? 'Open AI settings' : 'Add an API key'}
      </Button>

      {(chrome.status === 'available' || chrome.status === 'downloadable' || downloading) && (
        <div className="ai-empty__chrome">
          <div className="ai-empty__chrome-head">
            <Cpu aria-hidden />
            <div>
              <strong>No key? Use Chrome’s built-in AI</strong>
              <div className="ai-muted">
                Free and private — it runs on this device.
                {chrome.status === 'downloadable' && ' Needs a one-time download and about 22 GB of free disk space.'}
              </div>
            </div>
          </div>
          {downloading ? (
            <Progress value={chrome.progress} label="Downloading Chrome’s built-in AI" />
          ) : (
            <Button icon={chrome.status === 'available' ? <Cpu /> : <Download />} onClick={() => void enableChrome()}>
              {chrome.status === 'available' ? 'Use Chrome’s built-in AI' : 'Download and use it'}
            </Button>
          )}
          {error && <Callout tone="danger">{error}</Callout>}
        </div>
      )}

      <p className="ai-empty__free">
        Free tiers are available from{' '}
        <a href={gemini.keyUrl} target="_blank" rel="noopener noreferrer">
          Google Gemini <ExternalLink aria-hidden />
        </a>{' '}
        and{' '}
        <a href={groq.keyUrl} target="_blank" rel="noopener noreferrer">
          Groq <ExternalLink aria-hidden />
        </a>
        . You can also run a local model with Ollama or LM Studio.
      </p>
    </div>
  )
}
