import { useState } from 'react'
import { FileText, Square } from 'lucide-react'
import { SUMMARY_STYLES, summarize, summaryParts, type AiScope, type SummaryStyle } from '../../lib/ai/tools'
import type { OpenDoc } from '../../lib/library'
import { Button, Segmented } from '../ui'
import { availableScopes, effectiveScope } from './helpers'
import { Answer, ErrorNotice, OptionRow, ProgressLine, ScopePicker } from './parts'
import { useAiTask } from './useAiTask'
import { useScopedText } from './useScopedText'

export function SummaryTool({
  doc,
  currentSentence,
  selection,
  onOpenSettings,
}: {
  doc: OpenDoc
  currentSentence: number
  selection?: string | null
  onOpenSettings: () => void
}) {
  const options = availableScopes(doc, currentSentence, selection)
  const [chosen, setChosen] = useState<AiScope>(options.includes('chapter') ? 'chapter' : 'document')
  const scope = effectiveScope(chosen, options)
  const [style, setStyle] = useState<SummaryStyle>('brief')
  const scoped = useScopedText(doc, scope, currentSentence, selection)
  const task = useAiTask()
  const [summarized, setSummarized] = useState('')
  const parts = summaryParts(scoped.text.length)

  const go = () => {
    const target = scoped
    setSummarized(target.label)
    void task.run((ctx) =>
      summarize({
        text: target.text,
        title: doc.meta.title,
        scopeLabel: target.label,
        style,
        signal: ctx.signal,
        onToken: ctx.onToken,
        onProgress: ctx.onProgress,
      }),
    )
  }

  const reading = task.running && !task.text && task.progress && task.progress.done < task.progress.total

  return (
    <div className="ai-tool">
      <div className="ai-options">
        <OptionRow
          label="Summarize"
          hint={
            <>
              {scoped.label} · about {scoped.words.toLocaleString()} words
              {parts > 1 && ` · long text, read in ${parts - 1} parts first`}
            </>
          }
        >
          <ScopePicker value={scope} options={options} onChange={setChosen} />
        </OptionRow>
        <OptionRow label="Style">
          <Segmented label="Summary style" value={style} onChange={setStyle} options={SUMMARY_STYLES.map((s) => ({ value: s.id, label: s.label }))} />
        </OptionRow>
        <div className="ai-row">
          {task.running ? (
            <Button icon={<Square />} onClick={task.stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<FileText />} onClick={go} disabled={!scoped.words}>
              {task.text ? 'Summarize again' : 'Summarize'}
            </Button>
          )}
        </div>
      </div>

      {reading && task.progress && <ProgressLine label="Reading the text…" done={task.progress.done} total={task.progress.total} />}
      {(task.text || (task.running && !reading)) && (
        <section className="ai-result" aria-label="Summary">
          {summarized && <h3 className="ai-result__title">Summary · {summarized}</h3>}
          <Answer text={task.text} running={task.running} onStop={task.stop} showStop={false} waitingLabel={task.progress ? 'Writing the summary…' : 'Thinking…'} />
        </section>
      )}
      {task.status === 'error' && <ErrorNotice error={task.error} onRetry={go} onOpenSettings={onOpenSettings} />}
    </div>
  )
}
