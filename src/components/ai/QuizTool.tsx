import { useState } from 'react'
import { Check, ListChecks, RotateCcw, Square, Volume2, X } from 'lucide-react'
import { makeQuiz, type AiScope, type Quiz, type QuizQuestion } from '../../lib/ai/tools'
import type { OpenDoc } from '../../lib/library'
import { Button, IconButton, Segmented } from '../ui'
import { availableScopes, effectiveScope, readAloud } from './helpers'
import { ErrorNotice, OptionRow, ScopePicker, Waiting } from './parts'
import { useAiTask } from './useAiTask'
import { useScopedText } from './useScopedText'

type Mode = 'one' | 'all'
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

export function QuizTool({
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
  const [count, setCount] = useState(5)
  const [mode, setMode] = useState<Mode>('one')
  const scoped = useScopedText(doc, scope, currentSentence, selection)
  const task = useAiTask()
  const [quiz, setQuiz] = useState<(Quiz & { label: string }) | null>(null)
  const [picks, setPicks] = useState<Array<number | null>>([])
  const [current, setCurrent] = useState(0)

  const generate = async () => {
    const target = scoped
    const r = await task.run((ctx) => makeQuiz({ text: target.text, title: doc.meta.title, scopeLabel: target.label, count, signal: ctx.signal }))
    if (r.status === 'done') {
      setQuiz({ ...r.value, label: target.label })
      setPicks(r.value.questions.map(() => null))
      setCurrent(0)
    }
  }

  const restart = () => {
    setPicks((p) => p.map(() => null))
    setCurrent(0)
  }

  if (!quiz) {
    return (
      <div className="ai-tool">
        <div className="ai-options">
          <OptionRow label="Quiz me on" hint={`${scoped.label} · about ${scoped.words.toLocaleString()} words`}>
            <ScopePicker value={scope} options={options} onChange={setChosen} />
          </OptionRow>
          <OptionRow label="Questions">
            <Segmented label="Number of questions" value={count} onChange={setCount} options={[5, 7, 10].map((n) => ({ value: n, label: String(n) }))} />
          </OptionRow>
          <OptionRow label="Show">
            <Segmented
              label="How to show questions"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'one', label: 'One at a time' },
                { value: 'all', label: 'All at once' },
              ]}
            />
          </OptionRow>
          <div className="ai-row">
            {task.running ? (
              <Button icon={<Square />} onClick={task.stop}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" icon={<ListChecks />} onClick={() => void generate()} disabled={!scoped.words}>
                Make a quiz
              </Button>
            )}
          </div>
        </div>
        {task.running && <Waiting label={`Writing ${count} questions…`} />}
        {task.status === 'error' && <ErrorNotice error={task.error} onRetry={() => void generate()} onOpenSettings={onOpenSettings} />}
      </div>
    )
  }

  const qs = quiz.questions
  const answered = picks.filter((p) => p !== null).length
  const correct = picks.filter((p, i) => p !== null && p === qs[i].answer).length
  const finished = answered === qs.length
  const pick = (i: number, choice: number) => setPicks((p) => (p[i] !== null ? p : p.map((v, k) => (k === i ? choice : v))))

  const footer = (
    <div className="ai-row ai-row--wrap">
      <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={restart}>
        Try again
      </Button>
      <Button size="sm" variant="ghost" icon={<ListChecks />} onClick={() => setQuiz(null)}>
        New quiz
      </Button>
    </div>
  )

  return (
    <div className="ai-tool ai-quiz">
      <div className="ai-quiz__head">
        <div>
          <div className="ai-result__title">Quiz · {quiz.label}</div>
          <div className="ai-muted" aria-live="polite">
            {answered ? `${correct} of ${answered} correct` : `${qs.length} questions`}
          </div>
        </div>
        <Segmented
          label="How to show questions"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'one', label: 'One' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>

      {mode === 'one' && !(finished && current >= qs.length) ? (
        <>
          <QuestionCard
            key={current}
            q={qs[Math.min(current, qs.length - 1)]}
            index={Math.min(current, qs.length - 1)}
            total={qs.length}
            picked={picks[Math.min(current, qs.length - 1)]}
            onPick={(c) => pick(Math.min(current, qs.length - 1), c)}
            autoFocus
          />
          <div className="ai-row ai-row--between">
            <Button size="sm" variant="ghost" disabled={current === 0} onClick={() => setCurrent((c) => Math.max(0, c - 1))}>
              Previous
            </Button>
            <Button
              size="sm"
              variant={picks[current] !== null ? 'primary' : 'default'}
              disabled={picks[current] === null}
              onClick={() => setCurrent((c) => c + 1)}
            >
              {current >= qs.length - 1 ? 'See results' : 'Next question'}
            </Button>
          </div>
        </>
      ) : mode === 'all' ? (
        <>
          {qs.map((q, i) => (
            <QuestionCard key={i} q={q} index={i} total={qs.length} picked={picks[i]} onPick={(c) => pick(i, c)} />
          ))}
          {finished && <Score correct={correct} total={qs.length} />}
          {footer}
        </>
      ) : (
        <>
          <Score correct={correct} total={qs.length} />
          <ol className="ai-quiz__review">
            {qs.map((q, i) => (
              <li key={i} className={picks[i] === q.answer ? 'is-right' : 'is-wrong'}>
                {picks[i] === q.answer ? <Check aria-label="Correct" /> : <X aria-label="Incorrect" />}
                <button type="button" className="ai-link" onClick={() => setCurrent(i)}>
                  {q.q}
                </button>
              </li>
            ))}
          </ol>
          {footer}
        </>
      )}
    </div>
  )
}

function Score({ correct, total }: { correct: number; total: number }) {
  const pct = total ? correct / total : 0
  const message = pct === 1 ? 'Perfect score!' : pct >= 0.8 ? 'Great work!' : pct >= 0.5 ? 'Good effort — review the ones you missed.' : 'Worth another listen, then try again.'
  return (
    <div className="ai-score" role="status">
      <div className="ai-score__num">
        {correct} / {total}
      </div>
      <div>{message}</div>
    </div>
  )
}

function QuestionCard({
  q,
  index,
  total,
  picked,
  onPick,
  autoFocus,
}: {
  q: QuizQuestion
  index: number
  total: number
  picked: number | null
  onPick: (choice: number) => void
  autoFocus?: boolean
}) {
  const done = picked !== null
  // Blank lines keep the question and each option as separate paragraphs when spoken.
  const speak = () => void readAloud([q.q, ...q.options.map((o, i) => `${LETTERS[i]}: ${o}`)].join('\n\n'))
  return (
    <fieldset className="ai-q">
      <legend className="ai-q__legend">
        <span className="ai-q__num">
          Question {index + 1} of {total}
        </span>
        <span className="ai-q__text">{q.q}</span>
      </legend>
      <IconButton label="Read question aloud" size="sm" className="ai-q__speak" onClick={speak}>
        <Volume2 />
      </IconButton>
      <div className="ai-q__options">
        {q.options.map((opt, i) => {
          const state = !done ? '' : i === q.answer ? 'is-right' : i === picked ? 'is-wrong' : 'is-dim'
          return (
            <button
              key={i}
              type="button"
              className={`ai-q__opt ${state}`}
              aria-pressed={picked === i}
              aria-disabled={done}
              autoFocus={autoFocus && i === 0 && !done}
              onClick={() => !done && onPick(i)}
            >
              <span className="ai-q__letter" aria-hidden>
                {done && i === q.answer ? <Check /> : done && i === picked ? <X /> : LETTERS[i]}
              </span>
              <span>{opt}</span>
            </button>
          )
        })}
      </div>
      <div aria-live="polite">
        {done && (
          <div className={`ai-q__feedback ${picked === q.answer ? 'is-right' : 'is-wrong'}`}>
            <strong>{picked === q.answer ? 'Correct!' : `Not quite — the answer is ${LETTERS[q.answer]}.`}</strong>
            {q.explanation && <span> {q.explanation}</span>}
          </div>
        )}
      </div>
    </fieldset>
  )
}
