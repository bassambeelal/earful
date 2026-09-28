import { useEffect, useRef, type ReactNode } from 'react'
import { BookOpen, Database, Info, Palette, Sparkles, AudioLines } from 'lucide-react'
import { Dialog, Tabs } from '../ui'
import { DisplayControls } from '../DisplayControls'
import { AboutTab } from './AboutTab'
import { AiTab } from './AiTab'
import { DataTab } from './DataTab'
import { ReadingTab } from './ReadingTab'
import { SetGroup } from './parts'
import { VoicesTab } from './VoicesTab'
import { useUi, type SettingsTab } from '../../lib/ui-store'
import { prefersReducedMotion } from '../../lib/ui-format'
import './settings.css'

const TABS: Array<{ value: SettingsTab; label: string; icon: ReactNode }> = [
  { value: 'voices', label: 'Voices', icon: <AudioLines aria-hidden /> },
  { value: 'ai', label: 'AI', icon: <Sparkles aria-hidden /> },
  { value: 'reading', label: 'Reading', icon: <BookOpen aria-hidden /> },
  { value: 'appearance', label: 'Appearance', icon: <Palette aria-hidden /> },
  { value: 'data', label: 'Data', icon: <Database aria-hidden /> },
  { value: 'about', label: 'About', icon: <Info aria-hidden /> },
]

function AppearanceTab() {
  return (
    <SetGroup id="settings-appearance" title="Reading display" description="How documents look in the reader. You can also change these from the Aa button while reading.">
      <DisplayControls />
    </SetGroup>
  )
}

function TabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'ai':
      return <AiTab />
    case 'reading':
      return <ReadingTab />
    case 'appearance':
      return <AppearanceTab />
    case 'data':
      return <DataTab />
    case 'about':
      return <AboutTab />
    default:
      return <VoicesTab />
  }
}

/** Find a section anchor: "settings-openai", or a bare engine/provider id like "openai". */
function findSection(section: string): HTMLElement | null {
  return document.getElementById(section) ?? document.getElementById(`settings-${section}`)
}

/**
 * Settings. The tab and an optional section to scroll to come from the UI store, so any part
 * of the app can open e.g. Settings › Voices › OpenAI with `openSettings('voices', 'openai')`.
 */
export function SettingsDialog() {
  const tab = useUi((s) => s.settings.tab)
  const section = useUi((s) => s.settings.section)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = () => useUi.getState().closeSettings()
  const setTab = (next: SettingsTab) => useUi.setState((s) => ({ settings: { ...s.settings, tab: next, section: null } }))

  // On a tab change start at the top; when a section is requested, scroll to it and focus its first field.
  useEffect(() => {
    let flashTimer: ReturnType<typeof setTimeout> | undefined
    let target: HTMLElement | null = null
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      target = section ? findSection(section) : null
      if (target && panel.contains(target)) {
        target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
        target.classList.add('set-flash')
        flashTimer = setTimeout(() => target?.classList.remove('set-flash'), 1800)
        const field = target.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])')
        field?.focus({ preventScroll: true })
      } else {
        panel.closest('.ui-dialog__body')?.scrollTo({ top: 0 })
      }
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(flashTimer)
      target?.classList.remove('set-flash')
    }
  }, [tab, section])

  const label = TABS.find((t) => t.value === tab)?.label ?? 'Settings'

  return (
    <Dialog open onClose={close} title="Settings" wide>
      <div className="set-tabs">
        <Tabs label="Settings sections" value={tab} tabs={TABS} onChange={setTab} />
      </div>
      <div ref={panelRef} className="set-panel" role="tabpanel" aria-label={label}>
        <TabContent tab={tab} />
      </div>
    </Dialog>
  )
}
