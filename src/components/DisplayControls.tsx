import type { CSSProperties, ReactNode } from 'react'
import { AArrowDown, AArrowUp, Coffee, Monitor, Moon, Sun } from 'lucide-react'
import { IconButton, Segmented, Slider, Switch } from './ui'
import { useSettings, type ReaderFont, type Theme } from '../lib/settings'
import { cx } from '../lib/ui-format'

export const FONT_OPTIONS: Array<{ value: ReaderFont; label: string; family: string }> = [
  { value: 'serif', label: 'Serif', family: 'var(--font-serif)' },
  { value: 'sans', label: 'Sans', family: 'var(--font-sans)' },
  { value: 'hyperlegible', label: 'Hyperlegible', family: 'var(--font-hyperlegible)' },
  { value: 'dyslexic', label: 'Dyslexic', family: 'var(--font-dyslexic)' },
]

export const fontFamilyOf = (f: ReaderFont) => FONT_OPTIONS.find((o) => o.value === f)?.family ?? 'var(--font-serif)'

const THEMES: Array<{ value: Theme; label: string; icon: ReactNode }> = [
  { value: 'system', label: 'Auto', icon: <Monitor aria-hidden /> },
  { value: 'light', label: 'Light', icon: <Sun aria-hidden /> },
  { value: 'sepia', label: 'Sepia', icon: <Coffee aria-hidden /> },
  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden /> },
]

export const FONT_SIZE_MIN = 14
export const FONT_SIZE_MAX = 32

/** Reading appearance controls, shared by the reader's "Aa" popover and Settings › Appearance. */
export function DisplayControls({ compact }: { compact?: boolean }) {
  const d = useSettings((s) => s.display)
  const setDisplay = useSettings((s) => s.setDisplay)

  return (
    <div className={cx('display-controls', compact && 'display-controls--compact')}>
      <div className="dc-row">
        <span className="dc-label">Theme</span>
        <Segmented
          label="Theme"
          value={d.theme}
          onChange={(theme) => setDisplay({ theme })}
          options={THEMES.map((t) => ({
            value: t.value,
            title: t.label,
            label: (
              <span className="dc-seg">
                {t.icon}
                <span>{t.label}</span>
              </span>
            ),
          }))}
        />
      </div>

      <div className="dc-row dc-row--stack">
        <span className="dc-label">Font</span>
        <div className="dc-fonts" role="group" aria-label="Font">
          {FONT_OPTIONS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="dc-font"
              aria-pressed={d.font === f.value}
              onClick={() => setDisplay({ font: f.value })}
              style={{ '--f': f.family } as CSSProperties}
            >
              <span className="dc-font__sample" aria-hidden>
                Aa
              </span>
              <span className="dc-font__label">{f.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="dc-row dc-row--stack">
        <span className="dc-label">
          Text size <span className="dc-value">{d.fontSize}px</span>
        </span>
        <div className="dc-slider">
          <IconButton size="sm" label="Smaller text" disabled={d.fontSize <= FONT_SIZE_MIN} onClick={() => setDisplay({ fontSize: Math.max(FONT_SIZE_MIN, d.fontSize - 1) })}>
            <AArrowDown />
          </IconButton>
          <Slider label="Text size" min={FONT_SIZE_MIN} max={FONT_SIZE_MAX} step={1} value={d.fontSize} onChange={(fontSize) => setDisplay({ fontSize })} />
          <IconButton size="sm" label="Larger text" disabled={d.fontSize >= FONT_SIZE_MAX} onClick={() => setDisplay({ fontSize: Math.min(FONT_SIZE_MAX, d.fontSize + 1) })}>
            <AArrowUp />
          </IconButton>
        </div>
      </div>

      <div className="dc-row dc-row--stack">
        <span className="dc-label">
          Line spacing <span className="dc-value">{d.lineHeight.toFixed(2).replace(/0$/, '')}</span>
        </span>
        <Slider label="Line spacing" min={1.3} max={2.2} step={0.05} value={d.lineHeight} onChange={(lineHeight) => setDisplay({ lineHeight: Math.round(lineHeight * 100) / 100 })} />
      </div>

      <div className="dc-row dc-row--stack">
        <span className="dc-label">
          Text width <span className="dc-value">{d.width} characters</span>
        </span>
        <Slider label="Text width" min={40} max={100} step={2} value={d.width} onChange={(width) => setDisplay({ width })} />
      </div>

      <div className="dc-switches">
        <Switch checked={d.highlightSentence} onChange={(highlightSentence) => setDisplay({ highlightSentence })} label="Highlight sentence" />
        <Switch checked={d.highlightWord} onChange={(highlightWord) => setDisplay({ highlightWord })} label="Highlight word" />
        <Switch checked={d.focusMode} onChange={(focusMode) => setDisplay({ focusMode })} label="Focus mode" hint="Dim everything except the sentence being read" />
        <Switch checked={d.autoScroll} onChange={(autoScroll) => setDisplay({ autoScroll })} label="Follow along" hint="Scroll automatically to keep up with the voice" />
      </div>
    </div>
  )
}
