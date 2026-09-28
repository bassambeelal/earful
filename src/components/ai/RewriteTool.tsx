import { useMemo, useState } from 'react'
import { CheckCircle2, FilePlus2, Square } from 'lucide-react'
import {
  READING_LEVELS,
  TRANSLATE_LANGUAGES,
  rewriteDocument,
  rewriteParts,
  type AiScope,
  type ReadingLevel,
} from '../../lib/ai/tools'
import type { OpenDoc } from '../../lib/library'
import { useSettings } from '../../lib/settings'
import type { ImportedDoc } from '../../types'
import { Button, Callout, Segmented, Select } from '../ui'
import { availableScopes, effectiveScope } from './helpers'
import { ErrorNotice, OptionRow, ProgressLine, ScopePicker, Waiting } from './parts'
import { useAiTask } from './useAiTask'
import { useScopedText } from './useScopedText'

const LANG_KEY = 'earful:ai:translate-lang'

function initialLanguage(docLang: string | undefined): string {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved && TRANSLATE_LANGUAGES.some((l) => l.code === saved)) return saved
  } catch {
    /* storage unavailable */
  }
  const base = (docLang ?? 'en').split('-')[0]
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'en').split('-')[0]
  const match = TRANSLATE_LANGUAGES.find((l) => l.code.split('-')[0] === nav)
  if (match && nav !== base) return match.code
  return base === 'es' ? 'en' : 'es'
}

export function RewriteTool({
  kind,
  doc,
  currentSentence,
  selection,
  onCreateDoc,
  onOpenSettings,
}: {
  kind: 'simplify' | 'translate'
  doc: OpenDoc
  currentSentence: number
  selection?: string | null
  onCreateDoc: (doc: ImportedDoc) => void
  onOpenSettings: () => void
}) {
  const options = availableScopes(doc, currentSentence, selection)
  const [chosen, setChosen] = useState<AiScope>(options.includes('chapter') ? 'chapter' : 'document')
  const scope = effectiveScope(chosen, options)
  const scoped = useScopedText(doc, scope, currentSentence, selection)
  const [level, setLevel] = useState<ReadingLevel>('grade6')
  const [lang, setLang] = useState(() => initialLanguage(doc.meta.lang))
  const task = useAiTask()
  const [created, setCreated] = useState<string | null>(null)
  // Chunk size depends on the provider (local models get smaller requests).
  const provider = useSettings((s) => s.ai.provider)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parts = useMemo(() => rewriteParts(scoped.blocks), [scoped.blocks, provider])
  const verb = kind === 'simplify' ? 'Simplifying' : 'Translating'

  const create = async () => {
    setCreated(null)
    const target = scoped
    const r = await task.run((ctx) =>
      rewriteDocument({
        doc,
        blocks: target.blocks,
        partTitle: target.scope === 'chapter' ? target.chapterTitle : target.scope === 'selection' ? 'Selection' : undefined,
        mode: kind === 'simplify' ? { kind, level } : { kind, lang },
        signal: ctx.signal,
        onProgress: ctx.onProgress,
      }),
    )
    if (r.status === 'done') {
      setCreated(r.value.title)
      onCreateDoc(r.value)
    }
  }

  const levelInfo = READING_LEVELS.find((l) => l.id === level)

  return (
    <div className="ai-tool">
      <p className="ai-intro">
        {kind === 'simplify'
          ? 'Rewrite the text in simpler language and save it as a new document you can listen to.'
          : 'Translate the text and save it as a new document you can listen to.'}
      </p>
      <div className="ai-options">
        <OptionRow
          label={kind === 'simplify' ? 'Simplify' : 'Translate'}
          hint={
            <>
              {scoped.label} · about {scoped.words.toLocaleString()} words · {parts} {parts === 1 ? 'request' : 'requests'}
            </>
          }
        >
          <ScopePicker value={scope} options={options} onChange={setChosen} />
        </OptionRow>
        {kind === 'simplify' ? (
          <OptionRow label="Reading level" hint={levelInfo?.hint}>
            <Segmented label="Reading level" value={level} onChange={setLevel} options={READING_LEVELS.map((l) => ({ value: l.id, label: l.label }))} />
          </OptionRow>
        ) : (
          <OptionRow label="Into">
            <Select
              aria-label="Translate into"
              value={lang}
              onChange={(e) => {
                setLang(e.target.value)
                try {
                  localStorage.setItem(LANG_KEY, e.target.value)
                } catch {
                  /* storage unavailable */
                }
              }}
            >
              {TRANSLATE_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native === l.name ? l.name : `${l.name} — ${l.native}`}
                </option>
              ))}
            </Select>
          </OptionRow>
        )}
        {parts > 15 && !task.running && (
          <Callout tone="warning">
            This is a lot of text ({parts} requests). It may take several minutes and use a fair amount of your API credits. Choosing one chapter is quicker.
          </Callout>
        )}
        <div className="ai-row">
          {task.running ? (
            <Button icon={<Square />} onClick={task.stop}>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" icon={<FilePlus2 />} onClick={() => void create()} disabled={!scoped.words}>
              Create document
            </Button>
          )}
        </div>
      </div>

      {task.running &&
        (task.progress && task.progress.total > 1 ? (
          <ProgressLine label={`${verb}…`} done={task.progress.done} total={task.progress.total} />
        ) : (
          <Waiting label={`${verb}…`} />
        ))}
      {created && !task.running && (
        <Callout icon={<CheckCircle2 />}>
          Created “{created}” and added it to your library.
        </Callout>
      )}
      {task.status === 'error' && <ErrorNotice error={task.error} onRetry={() => void create()} onOpenSettings={onOpenSettings} />}
    </div>
  )
}
