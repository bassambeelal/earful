import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { AlertTriangle, Info, X, XCircle } from 'lucide-react'
import './ui.css'

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ')

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  loading?: boolean
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', block, loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ui-btn', variant !== 'default' && `ui-btn--${variant}`, size !== 'md' && `ui-btn--${size}`, block && 'ui-btn--block', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="ui-spinner" aria-hidden /> : icon}
      {children}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label (also used as tooltip). Required. */
  label: string
  size?: 'sm' | 'md' | 'lg'
  variant?: 'default' | 'primary'
  pressed?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'default', pressed, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx('ui-icon-btn', size !== 'md' && `ui-icon-btn--${size}`, variant === 'primary' && 'ui-icon-btn--primary', className)}
      {...rest}
    >
      {children}
    </button>
  )
})

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function Field({ label, hint, error, children, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="ui-field">
      {label && (
        <label className="ui-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      {children}
      {error ? <div className="ui-field__error">{error}</div> : hint ? <div className="ui-field__hint">{hint}</div> : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx('ui-input', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('ui-textarea', className)} {...rest} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx('ui-select', className)} {...rest}>
      {children}
    </select>
  )
})

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="ui-switch" style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
      <span className="ui-switch__text">
        <span className="ui-switch__label">{label}</span>
        {hint && <span className="ui-switch__hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="ui-switch__track" aria-hidden />
    </label>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  className,
  ...rest
}: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'min' | 'max' | 'step'>) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      aria-label={label}
      className={cx('ui-slider', className)}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ['--pct' as string]: `${pct}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      {...rest}
    />
  )
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ui-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" aria-pressed={o.value === value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, tabs, onChange, label }: { value: T; tabs: Array<{ value: T; label: ReactNode; icon?: ReactNode }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}>
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dialog (modal) — portal, focus trap, Escape to close, restores focus.
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  labelledBy,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  labelledBy?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const autoId = useId()
  const titleId = labelledBy ?? `dlg-${autoId}`
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    const focusables = () =>
      Array.from(el?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (n) => n.offsetParent !== null,
      )
    // Focus first input, else the dialog.
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables().find((n) => n.tagName !== 'BUTTON') ?? el
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      } else if (e.key === 'Tab') {
        const f = focusables()
        if (!f.length) return
        const a = f[0]
        const z = f[f.length - 1]
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault()
          z.focus()
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault()
          a.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
      prev?.focus?.()
    }
  }, [open])

  if (!open) return null
  return createPortal(
    <div
      className="ui-dialog-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} className={cx('ui-dialog', wide && 'ui-dialog--wide')} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="ui-dialog__head">
          <h2 className="ui-dialog__title" id={titleId}>
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X />
          </IconButton>
        </div>
        <div className="ui-dialog__body">{children}</div>
        {footer && <div className="ui-dialog__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Popover — anchored to an element; closes on outside click / Escape.
// ---------------------------------------------------------------------------

export function Popover({
  open,
  onClose,
  anchor,
  children,
  placement = 'top',
  align = 'start',
  label,
}: {
  open: boolean
  onClose: () => void
  anchor: RefObject<HTMLElement | null>
  children: ReactNode
  placement?: 'top' | 'bottom'
  align?: 'start' | 'end' | 'center'
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect()
    const p = ref.current
    if (!a || !p) return
    const pw = p.offsetWidth
    const ph = p.offsetHeight
    let left = align === 'start' ? a.left : align === 'end' ? a.right - pw : a.left + a.width / 2 - pw / 2
    left = Math.max(8, Math.min(window.innerWidth - pw - 8, left))
    let top = placement === 'top' ? a.top - ph - 8 : a.bottom + 8
    if (placement === 'top' && top < 8) top = a.bottom + 8
    if (placement === 'bottom' && top + ph > window.innerHeight - 8) top = Math.max(8, a.top - ph - 8)
    setPos({ left, top })
  }, [anchor, placement, align])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        anchor.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchor])

  if (!open) return null
  return createPortal(
    <div ref={ref} className="ui-popover" role="dialog" aria-label={label} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({ icon, children, onClick, danger, disabled }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={cx('ui-menu-item', danger && 'ui-menu-item--danger')} onClick={onClick} disabled={disabled} style={disabled ? { opacity: 0.5 } : undefined}>
      {icon}
      <span style={{ flex: 1 }}>{children}</span>
    </button>
  )
}

export const MenuSeparator = () => <div className="ui-menu-sep" role="separator" />

// ---------------------------------------------------------------------------
// Small display pieces
// ---------------------------------------------------------------------------

export function Badge({ children, tone = 'default', title }: { children: ReactNode; tone?: 'default' | 'accent' | 'success' | 'warning'; title?: string }) {
  return (
    <span className={cx('ui-badge', tone !== 'default' && `ui-badge--${tone}`)} title={title}>
      {children}
    </span>
  )
}

export const Spinner = ({ label = 'Loading' }: { label?: string }) => <span className="ui-spinner" role="status" aria-label={label} />

export function Progress({ value, label }: { value: number | null; label?: string }) {
  return (
    <div
      className={cx('ui-progress', value === null && 'ui-progress--indeterminate')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <div style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
    </div>
  )
}

export function Callout({ tone = 'info', children, icon }: { tone?: 'info' | 'warning' | 'danger'; children: ReactNode; icon?: ReactNode }) {
  const Icon = tone === 'danger' ? XCircle : tone === 'warning' ? AlertTriangle : Info
  return (
    <div className={cx('ui-callout', tone !== 'info' && `ui-callout--${tone}`)} role={tone === 'danger' ? 'alert' : undefined}>
      {icon ?? <Icon />}
      <div>{children}</div>
    </div>
  )
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="ui-kbd">{children}</kbd>

export function Section({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-section">
      {title && <h3 className="ui-section__title">{title}</h3>}
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Toasts — call toast('Saved') / toast.error('Nope') from anywhere.
// ---------------------------------------------------------------------------

interface ToastItem {
  id: number
  message: string
  tone: 'default' | 'error'
  action?: { label: string; onClick: () => void }
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }))
let toastSeq = 0

function pushToast(message: string, tone: ToastItem['tone'], opts?: { action?: ToastItem['action']; duration?: number }) {
  const id = ++toastSeq
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), { id, message, tone, action: opts?.action }] }))
  const duration = opts?.duration ?? (tone === 'error' ? 7000 : 3500)
  if (duration > 0) setTimeout(() => dismissToast(id), duration)
  return id
}

export function dismissToast(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }))
}

export const toast = Object.assign((message: string, opts?: { action?: ToastItem['action']; duration?: number }) => pushToast(message, 'default', opts), {
  error: (message: string, opts?: { action?: ToastItem['action']; duration?: number }) => pushToast(message, 'error', opts),
})

export function Toaster() {
  const items = useToasts((s) => s.items)
  return createPortal(
    <div className="ui-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={cx('ui-toast', t.tone === 'error' && 'ui-toast--error')} role={t.tone === 'error' ? 'alert' : 'status'}>
          <div className="ui-toast__msg">{t.message}</div>
          {t.action && (
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              onClick={() => {
                t.action!.onClick()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <IconButton label="Dismiss" size="sm" onClick={() => dismissToast(t.id)}>
            <X />
          </IconButton>
        </div>
      ))}
    </div>,
    document.body,
  )
}
