import { useEffect, useState } from 'react'
import { Lightbulb, Square } from 'lucide-react'
import { EXPLAIN_LEVELS, explainContext, explainPassage, type ExplainLevel } from '../../lib/ai/tools'
import type { OpenDoc } from '../../lib/library'
import { Button, Segmented } from '../ui'
import { Answer, ErrorNotice, OptionRow } from './parts'
import { useAiTask } from './useAiTask'

type Source = 'selection' | 'sentence'

export function ExplainTool({
  doc,
  currentSentence,
  selection,
  autoRun,
  onOpenSettings,
}: {
  doc: OpenDoc
  currentSentence: number
  selection?: string | null
  /** Explain the selection immediately (the reader's "Explain" action). */
  autoRun?: boolean
  onOpenSettings: () => void
}) {
  const hasSelection = !!selection?.trim()
  const [chosen, setChosen] = useState<Source>(hasSelection ? 'selection' : 'sentence')
  const source: Source = chosen === 'selection' && hasSelection ? 'selection' : 'sentence'
  const [level, setLevel] = useState<ExplainLevel>('normal')
  const task = useAiTask()
  const [explained, setExplained] = useState('')

  const passage = source === 'selection' ? selection!.trim() : (doc.sentences[currentSentence]?.text ?? '')

  // A new selection becomes the default source.
  const [lastSelection, setLastSelection] = useState(selection)
  if (selection !== lastSelection) {
    setLastSelection(selection)
    if (hasSelection) setChosen('selection')
  }

  const go = (lvl: ExplainLevel = level) => {
    const text = passage
    setExplained(text)
    void task.run((ctx) =>
      explainPassage({
        passage: text,
        context: explainContext(doc, currentSentence),
        title: doc.meta.title,
        level: lvl,
        signal: ctx.signal,
        onToken: ctx.onToken,
      }),
    )
  }

  // Once on mount. Deferred so StrictMode's mount/unmount/mount check doesn't start and abort a request.
  useEffect(() => {
    if (!autoRun || !hasSelection) return
    const t = setTimeout(() => go(), 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shown = task.running ? explained : passage
  const stale = !task.running && !!task.text && explained !== passage

  return (
    <div className="ai-tool">
      <div className="ai-options">
        {hasSelection && (
          <OptionRow label="Explain">
            <Segmented
              label="What to explain"
              value={source}
              onChange={setChosen}
              options={[
                { value: 'selection', label: 'Selection' },
                { value: 'sentence', label: 'Current sentence' },
              ]}
            />
          </OptionRow>
        )}
        {shown ? (
          <blockquote className="ai-passage">{shown}</blockquote>
        ) : (
          <p className="ai-muted">Select some text in the reader, or play the document to explain the current sentence.</p>
        )}
        <OptionRow label="Level">
          <Segmented
            label="Explanation level"
            value={level}
            onChange={(l) => {
              setLevel(l)
              if (task.status === 'done' && explained === passage) go(l)
            }}
            options={EXPLAIN_LEVELS.map((l) => ({ value: l.id, label: l.label }))}
          />
        </OptionRow>
        <div className="ai-row">
          {task.running ? (
            <Button icon={<Square />} onClick={task.stop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" icon={<Lightbulb />} onClick={() => go()} disabled={!passage}>
              {task.text && explained === passage ? 'Explain again' : 'Explain'}
            </Button>
          )}
        </div>
      </div>
      {stale && <p className="ai-muted ai-clamp">Explanation of: “{explained}”</p>}
      <Answer text={task.text} running={task.running} onStop={task.stop} showStop={false} />
      {task.status === 'error' && <ErrorNotice error={task.error} onRetry={() => go()} onOpenSettings={onOpenSettings} />}
    </div>
  )
}
