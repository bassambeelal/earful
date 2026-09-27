// CONTRACT STUB — replaced by the AI module implementation.
import type { OpenDoc } from '../../lib/library'
import type { ImportedDoc } from '../../types'

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

/** Side panel (drawer on mobile) with the AI study tools. */
export declare function AiPanel(props: AiPanelProps): React.JSX.Element
