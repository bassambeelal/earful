import { useId, useState, type ReactNode } from 'react'
import { CircleCheck, CircleX, ExternalLink as ExternalIcon, Eye, EyeOff } from 'lucide-react'
import { Button, Field, IconButton, Input } from '../ui'
import { useSettings, type KeyId } from '../../lib/settings'
import { cx } from '../../lib/ui-format'

// Small building blocks shared by the settings tabs.

/** A titled group inside a settings tab. `id` is the anchor Settings can scroll to. */
export function SetGroup({
  id,
  title,
  badges,
  description,
  children,
}: {
  id?: string
  title: ReactNode
  badges?: ReactNode
  description?: ReactNode
  children?: ReactNode
}) {
  const auto = useId()
  const headingId = `${id ?? auto}-title`
  return (
    <section id={id} className="set-group" aria-labelledby={headingId}>
      <div className="set-group__head">
        <h3 className="set-group__title" id={headingId}>
          {title}
        </h3>
        {badges && <span className="set-group__badges">{badges}</span>}
      </div>
      {description && <p className="set-group__desc">{description}</p>}
      {children}
    </section>
  )
}

/** A link that opens in a new tab without sending this page as the referrer. */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a className={cx('set-link', className)} href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalIcon aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** Password-style API key field with show/hide. Saved as you type (trimmed). */
export function KeyInput({
  id,
  keyId,
  label,
  hint,
  placeholder = 'Paste your key here',
  link,
}: {
  id: string
  keyId: KeyId
  label: string
  hint?: ReactNode
  placeholder?: string
  /** "Get a key" page. */
  link?: string
}) {
  const value = useSettings((s) => s.keys[keyId] ?? '')
  const setKey = useSettings((s) => s.setKey)
  const [show, setShow] = useState(false)
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={
        hint || link ? (
          <span className="set-hint-row">
            {hint && <span>{hint}</span>}
            {link && <ExternalLink href={link}>Get a key</ExternalLink>}
          </span>
        ) : undefined
      }
    >
      <div className="ui-input-row">
        <Input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => setKey(keyId, e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          className="set-key"
        />
        <IconButton label={show ? 'Hide key' : 'Show key'} pressed={show} onClick={() => setShow((v) => !v)}>
          {show ? <EyeOff /> : <Eye />}
        </IconButton>
      </div>
    </Field>
  )
}

/** Free-text model id with suggestions (any id the provider accepts works). */
export function ModelInput({
  id,
  label = 'Model',
  value,
  onChange,
  suggestions,
  hint,
  placeholder,
}: {
  id: string
  label?: string
  value: string
  onChange: (v: string) => void
  suggestions: readonly string[]
  hint?: ReactNode
  placeholder?: string
}) {
  const listId = `${id}-list`
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        list={suggestions.length ? listId : undefined}
        placeholder={placeholder ?? suggestions[0]}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </Field>
  )
}

export interface TestOutcome {
  ok: boolean
  message: string
}

/**
 * "Test" button with an inline result. The result is tied to `signature` (key, model, address…),
 * so it disappears as soon as any of those change.
 */
export function TestButton({
  run,
  signature,
  label = 'Test',
  disabled,
  children,
}: {
  run: () => Promise<TestOutcome>
  signature: string
  label?: string
  disabled?: boolean
  /** Extra buttons shown next to Test. */
  children?: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<(TestOutcome & { sig: string }) | null>(null)

  const onClick = async () => {
    const sig = signature
    setBusy(true)
    setResult(null)
    let outcome: TestOutcome
    try {
      outcome = await run()
    } catch (e) {
      outcome = { ok: false, message: e instanceof Error && e.message ? e.message : 'The test failed. Please try again.' }
    }
    setResult({ ...outcome, sig })
    setBusy(false)
  }

  const shown = result && result.sig === signature && !busy ? result : null
  return (
    <div className="set-test">
      <div className="set-actions">
        <Button size="sm" onClick={() => void onClick()} loading={busy} disabled={disabled}>
          {busy ? 'Testing…' : label}
        </Button>
        {children}
      </div>
      <div aria-live="polite">
        {shown && (
          <p className={cx('set-result', shown.ok ? 'set-result--ok' : 'set-result--err')}>
            {shown.ok ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}
            <span>{shown.message}</span>
          </p>
        )}
      </div>
    </div>
  )
}
