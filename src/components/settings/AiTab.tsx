import { useEffect, type ReactNode } from 'react'
import { Download, RefreshCw, ShieldCheck } from 'lucide-react'
import { Badge, Button, Callout, Field, Input, Progress, Select, Spinner, toast } from '../ui'
import { ExternalLink, KeyInput, ModelInput, SetGroup, TestButton } from './parts'
import { AI_PROVIDERS, describeAiError, isAbortError, prepareChromeAi, providerInfo, refreshChromeAi, testAiKey, useChromeAi } from '../../lib/ai'
import { useSettings, type AiProviderId, type KeyId } from '../../lib/settings'

type KeyedProvider = Exclude<AiProviderId, 'chrome'>

const SHARED_WITH_VOICES: Partial<Record<KeyedProvider, string>> = {
  openai: 'Also used for OpenAI voices.',
  gemini: 'Also used for Gemini voices.',
  groq: 'Also used for Groq voices.',
}

export function AiTab() {
  const provider = useSettings((s) => s.ai.provider)

  return (
    <>
      <SetGroup
        id="settings-ai"
        title="AI study tools"
        description="Summaries, questions about your document, quizzes, explanations, simpler wording and translation. Choose which AI service answers."
      >
        <Field label="AI service" htmlFor="settings-ai-provider" hint={provider === 'chrome' ? 'Free and private: runs inside Chrome on your device.' : 'Uses your own API key. You pay the provider directly.'}>
          <Select id="settings-ai-provider" value={provider} onChange={(e) => useSettings.getState().setAi({ provider: e.target.value as AiProviderId })}>
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
      </SetGroup>

      {provider === 'chrome' ? <ChromeAiSettings /> : <ProviderSettings key={provider} provider={provider} />}

      <Callout icon={<ShieldCheck />}>
        <p className="set-callout-text">
          <strong>Your privacy.</strong> When you use an AI tool, only the text it needs (for example the chapter you are summarising) is sent, straight
          from your browser to the service you picked, using your key. Earful has no server and never sees your documents or keys. Chrome’s built-in AI
          and a server on your own computer keep everything on your device.
        </p>
      </Callout>
    </>
  )
}

function ProviderSettings({ provider }: { provider: KeyedProvider }) {
  const info = providerInfo(provider)
  const keyId = provider as KeyId
  const key = useSettings((s) => s.keys[keyId] ?? '')
  const model = useSettings((s) => s.ai.models[provider])
  const customBaseUrl = useSettings((s) => s.ai.customBaseUrl)
  const isCustom = provider === 'custom'
  const base = `settings-ai-${provider}`

  const canTest = isCustom ? !!customBaseUrl.trim() && !!model.trim() : !!key && !!model.trim()

  return (
    <SetGroup id={base} title={info.label} badges={!isCustom && (key ? <Badge tone="success">Key saved</Badge> : <Badge tone="warning">Needs a key</Badge>)}>
      {isCustom && (
        <Field
          label="Server address"
          htmlFor={`${base}-url`}
          hint="Any OpenAI-compatible server, such as Ollama (http://localhost:11434/v1) or LM Studio (http://localhost:1234/v1). It must allow requests from this site; for Ollama, set OLLAMA_ORIGINS."
        >
          <Input
            id={`${base}-url`}
            type="url"
            inputMode="url"
            value={customBaseUrl}
            onChange={(e) => useSettings.getState().setAi({ customBaseUrl: e.target.value })}
            placeholder="http://localhost:11434/v1"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      <KeyInput
        id={`${base}-key`}
        keyId={keyId}
        label={isCustom ? 'API key (optional)' : `${info.label.replace(/ \(.*\)$/, '')} API key`}
        placeholder={isCustom ? 'Only if your server asks for one' : undefined}
        hint={isCustom ? 'Shared with “Your own server” voices.' : SHARED_WITH_VOICES[provider]}
        link={isCustom ? undefined : info.keyUrl}
      />
      <ModelInput
        id={`${base}-model`}
        value={model}
        onChange={(v) => useSettings.getState().setAiModel(provider, v)}
        suggestions={info.modelSuggestions}
        hint={isCustom ? 'The model name as your server lists it.' : 'Smaller, faster models are cheaper and fine for most study tools.'}
      />
      <TestButton run={() => testAiKey(provider)} signature={`${key}|${model}|${isCustom ? customBaseUrl : ''}`} disabled={!canTest} />
    </SetGroup>
  )
}

function ChromeAiSettings() {
  const status = useChromeAi((s) => s.status)
  const progress = useChromeAi((s) => s.progress)

  useEffect(() => {
    void refreshChromeAi()
  }, [])

  const download = () => {
    prepareChromeAi().catch((e: unknown) => {
      if (!isAbortError(e)) toast.error(describeAiError(e))
    })
  }

  let body: ReactNode
  switch (status) {
    case 'available':
      body = (
        <p className="set-status set-status--ok">
          <Badge tone="success">Ready</Badge>
          Runs on your device. Nothing is sent anywhere.
        </p>
      )
      break
    case 'checking':
      body = (
        <p className="set-status">
          <Spinner label="Checking" />
          Checking whether Chrome’s built-in AI is available…
        </p>
      )
      break
    case 'downloadable':
      body = (
        <>
          <p className="set-status">
            <Badge>Not downloaded</Badge>
            Chrome needs to download its AI model once. It is large, so use Wi-Fi.
          </p>
          <div className="set-actions">
            <Button size="sm" variant="primary" icon={<Download />} onClick={download}>
              Download the model
            </Button>
          </div>
        </>
      )
      break
    case 'downloading':
      body = (
        <div className="set-kokoro__progress" aria-live="polite">
          <Progress value={progress} label="Chrome AI model download" />
          <span className="set-muted">
            Chrome is downloading its AI model{progress !== null ? `… ${Math.round(progress * 100)}%` : '…'} This can take a few minutes.
          </span>
        </div>
      )
      break
    case 'unsupported':
      body = (
        <Callout tone="warning">
          <p className="set-callout-text">
            This browser doesn’t have built-in AI. It is available in recent desktop versions of Google Chrome. You can also pick another service above and
            add a key.
          </p>
        </Callout>
      )
      break
    default:
      body = (
        <Callout tone="warning">
          <p className="set-callout-text">
            Chrome’s built-in AI isn’t available on this device. It needs a recent desktop Chrome, enough free disk space and a capable computer. You can
            pick another service above instead.
          </p>
        </Callout>
      )
  }

  return (
    <SetGroup
      id="settings-ai-chrome"
      title="Chrome built-in AI"
      badges={
        <>
          <Badge tone="success">Free</Badge>
          <Badge>On device</Badge>
        </>
      }
      description={
        <>
          Uses the Gemini Nano model built into Chrome. No key needed and your text never leaves your device.{' '}
          <ExternalLink href="https://developer.chrome.com/docs/ai/get-started">Learn more</ExternalLink>
        </>
      }
    >
      {body}
      <TestButton run={() => testAiKey('chrome')} signature={status} disabled={status !== 'available'}>
        {status !== 'available' && status !== 'downloading' && (
          <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => void refreshChromeAi()}>
            Check again
          </Button>
        )}
      </TestButton>
    </SetGroup>
  )
}
