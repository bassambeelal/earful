import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, RotateCcw, Settings, Square, Volume2 } from 'lucide-react'
import { AiError, describeAiError } from '../../lib/ai'
import type { AiScope } from '../../lib/ai/tools'
import { Button, Callout, Progress, Segmented, toast } from '../ui'
import { readAloud } from './helpers'
import { renderMarkdown } from './markdown'

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ')

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={cx('ai-md', streaming && 'ai-md--streaming')} dangerouslySetInnerHTML={{ __html: html }} />
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Couldn’t copy. Select the text and copy it instead.')
    }
  }
  return (
    <Button size="sm" variant="ghost" icon={copied ? <Check /> : <Copy />} onClick={copy}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

/** Read aloud / Copy, or Stop while streaming. */
export function AnswerActions({ text, running, onStop }: { text: string; running: boolean; onStop: () => void }) {
  if (running) {
    return (
      <div className="ai-actions">
        <Button size="sm" icon={<Square />} onClick={onStop}>
          Stop
        </Button>
      </div>
    )
  }
  if (!text.trim()) return null
  return (
    <div className="ai-actions">
      <Button size="sm" variant="ghost" icon={<Volume2 />} onClick={() => void readAloud(text)}>
        Read aloud
      </Button>
      <CopyButton text={text} />
    </div>
  )
}

/** Streamed Markdown answer with its actions. The region is announced when streaming finishes. */
export function Answer({
  text,
  running,
  onStop,
  waitingLabel = 'Thinking…',
  showStop = true,
}: {
  text: string
  running: boolean
  onStop: () => void
  waitingLabel?: string
  /** Hide the Stop button when the tool already shows one. */
  showStop?: boolean
}) {
  if (!text && !running) return null
  return (
    <div className="ai-answer">
      <div className="ai-answer__body" aria-live="polite" aria-busy={running}>
        {text ? <Markdown text={text} streaming={running} /> : <Waiting label={waitingLabel} />}
      </div>
      {(showStop || !running) && <AnswerActions text={text} running={running} onStop={onStop} />}
    </div>
  )
}

export function Waiting({ label }: { label: string }) {
  return (
    <div className="ai-waiting" role="status">
      <span className="ai-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label}
    </div>
  )
}

export function ProgressLine({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div className="ai-progress" role="status">
      <div className="ai-progress__label">
        <span>{label}</span>
        <span className="ai-muted">
          {Math.min(done, total)} / {total}
        </span>
      </div>
      <Progress value={total ? done / total : null} label={label} />
    </div>
  )
}

const SETTINGS_KINDS = new Set(['auth', 'model', 'config', 'credits'])

export function ErrorNotice({ error, onRetry, onOpenSettings }: { error: unknown; onRetry?: () => void; onOpenSettings?: () => void }) {
  const showSettings = error instanceof AiError && SETTINGS_KINDS.has(error.kind) && onOpenSettings
  return (
    <Callout tone="danger">
      <p className="ai-error__msg">{describeAiError(error)}</p>
      {(onRetry || showSettings) && (
        <div className="ai-row">
          {onRetry && (
            <Button size="sm" icon={<RotateCcw />} onClick={onRetry}>
              Try again
            </Button>
          )}
          {showSettings && (
            <Button size="sm" variant="ghost" icon={<Settings />} onClick={onOpenSettings}>
              Open settings
            </Button>
          )}
        </div>
      )}
    </Callout>
  )
}

export function OptionRow({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="ai-option">
      <span className="ai-option__label">{label}</span>
      <div className="ai-option__control">{children}</div>
      {hint && <div className="ai-option__hint">{hint}</div>}
    </div>
  )
}

const SCOPE_LABELS: Record<AiScope, string> = {
  chapter: 'This chapter',
  paragraph: 'This paragraph',
  document: 'Whole document',
  selection: 'Selection',
}

export function ScopePicker({ value, options, onChange }: { value: AiScope; options: AiScope[]; onChange: (s: AiScope) => void }) {
  if (options.length < 2) return <span className="ai-muted">{SCOPE_LABELS[options[0] ?? 'document']}</span>
  return <Segmented label="What to use" value={value} onChange={onChange} options={options.map((o) => ({ value: o, label: SCOPE_LABELS[o] }))} />
}
