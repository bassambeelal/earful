import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { FileText, Languages, Lightbulb, ListChecks, MessagesSquare, Sparkles, WandSparkles, X } from 'lucide-react'
import { aiLabel, aiReady, useChromeAi } from '../../lib/ai'
import type { OpenDoc } from '../../lib/library'
import { useSettings } from '../../lib/settings'
import type { ImportedDoc } from '../../types'
import { IconButton, Tabs } from '../ui'
import { AiSetup } from './AiSetup'
import { ChatTool } from './ChatTool'
import { ExplainTool } from './ExplainTool'
import { QuizTool } from './QuizTool'
import { RewriteTool } from './RewriteTool'
import { SummaryTool } from './SummaryTool'
import './ai.css'

export type AiTool = 'summary' | 'chat' | 'quiz' | 'explain' | 'simplify' | 'translate'

export interface AiPanelProps {
  doc: OpenDoc
  /** Tool to show first. */
  initialTool?: AiTool
  /** Text the user selected in the reader (for "Explain"), if any. */
  selection?: string | null
  /** Current sentence index, so tools can default to "this chapter/section". */
  currentSentence: number
  onClose: () => void
  /** Save an AI-generated document (simplified / translated) to the library and open it. */
  onCreateDoc: (doc: ImportedDoc) => void
  /** Open settings at the AI section (when no key is configured). */
  onOpenSettings: () => void
}

const TABS: Array<{ value: AiTool; label: string; icon: React.JSX.Element }> = [
  { value: 'summary', label: 'Summary', icon: <FileText /> },
  { value: 'chat', label: 'Chat', icon: <MessagesSquare /> },
  { value: 'quiz', label: 'Quiz', icon: <ListChecks /> },
  { value: 'explain', label: 'Explain', icon: <Lightbulb /> },
  { value: 'simplify', label: 'Simplify', icon: <WandSparkles /> },
  { value: 'translate', label: 'Translate', icon: <Languages /> },
]

/** Side panel (drawer on mobile) with the AI study tools. */
export function AiPanel(props: AiPanelProps): React.JSX.Element {
  const { doc, initialTool, selection, currentSentence, onClose, onCreateDoc, onOpenSettings } = props
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const [tool, setTool] = useState<AiTool>(initialTool ?? (selection?.trim() ? 'explain' : 'summary'))
  // Tools stay mounted once opened so answers and chats survive tab switches.
  const [visited, setVisited] = useState<ReadonlySet<AiTool>>(() => new Set([tool]))

  // Re-render when the provider setup changes.
  useSettings((s) => s.ai)
  useSettings((s) => s.keys)
  useChromeAi((s) => s.status)
  const ready = aiReady()

  const select = (t: AiTool) => {
    setTool(t)
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)))
  }

  // Follow the parent when it asks for a different tool while the panel is open.
  const [lastInitial, setLastInitial] = useState(initialTool)
  if (initialTool !== lastInitial) {
    setLastInitial(initialTool)
    if (initialTool) select(initialTool)
  }

  // Focus the panel when it opens and give focus back when it closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    return () => {
      if (prev?.isConnected) prev.focus()
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing) {
      e.stopPropagation()
      onClose()
    }
  }

  const common = { doc, currentSentence, selection, onOpenSettings }
  const [autoExplain] = useState(() => initialTool === 'explain' && !!selection?.trim())

  return (
    // A labelled section rather than <aside>: the reader already wraps the panel in a complementary landmark.
    <section ref={panelRef} className="ai-panel" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="ai-panel__head">
        <Sparkles className="ai-panel__logo" aria-hidden />
        <h2 className="ai-panel__title" id={titleId}>
          AI tools
        </h2>
        {ready && (
          <button type="button" className="ai-chip ai-chip--provider" onClick={onOpenSettings} title="Change the AI provider or model in Settings">
            {aiLabel()}
          </button>
        )}
        <IconButton label="Close AI tools" onClick={onClose}>
          <X />
        </IconButton>
      </header>

      {ready ? (
        <>
          <div className="ai-panel__tabs">
            <Tabs label="AI tools" value={tool} onChange={select} tabs={TABS} />
          </div>
          <div className="ai-panel__body" key={doc.meta.id}>
            {TABS.filter((t) => visited.has(t.value)).map((t) => (
              <div key={t.value} role="tabpanel" aria-label={t.label} hidden={t.value !== tool} className={`ai-panel__pane ai-panel__pane--${t.value}`}>
                {t.value === 'summary' && <SummaryTool {...common} />}
                {t.value === 'chat' && <ChatTool {...common} />}
                {t.value === 'quiz' && <QuizTool {...common} />}
                {t.value === 'explain' && <ExplainTool {...common} autoRun={autoExplain} />}
                {t.value === 'simplify' && <RewriteTool kind="simplify" {...common} onCreateDoc={onCreateDoc} />}
                {t.value === 'translate' && <RewriteTool kind="translate" {...common} onCreateDoc={onCreateDoc} />}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="ai-panel__body">
          <AiSetup onOpenSettings={onOpenSettings} />
        </div>
      )}
    </section>
  )
}
