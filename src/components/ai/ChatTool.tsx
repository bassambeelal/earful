import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MessageSquarePlus, SendHorizontal, Square } from 'lucide-react'
import { STARTER_QUESTIONS, askDocument, type ChatTurn } from '../../lib/ai/tools'
import type { OpenDoc } from '../../lib/library'
import { uid } from '../../lib/text'
import { Button, IconButton, Textarea } from '../ui'
import { AnswerActions, ErrorNotice, Markdown, Waiting } from './parts'
import { useAiTask } from './useAiTask'

interface Message extends ChatTurn {
  id: string
}

export function ChatTool({
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
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [failed, setFailed] = useState<{ question: string; error: unknown } | null>(null)
  const task = useAiTask()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stickRef = useRef(true)

  // Follow the conversation while the user is at the bottom.
  useEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, task.text, task.running, failed])

  // Grow the input with its content (up to a limit set in CSS).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    // scrollHeight excludes the borders, but the field is border-box.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`
  }, [input])

  const send = async (raw: string, history: Message[] = messages) => {
    const question = raw.trim()
    if (!question || task.running) return
    setFailed(null)
    setInput('')
    stickRef.current = true
    const next = [...history, { id: uid(), role: 'user' as const, content: question }]
    setMessages(next)
    const r = await task.run((ctx) =>
      askDocument({
        doc,
        question,
        history: history.map(({ role, content }) => ({ role, content })),
        currentSentence,
        selection,
        signal: ctx.signal,
        onToken: ctx.onToken,
      }),
    )
    if (r.status === 'done' || (r.status === 'stopped' && r.text.trim())) {
      setMessages((m) => [...m, { id: uid(), role: 'assistant', content: r.text }])
      task.reset()
    } else if (r.status === 'error') {
      setFailed({ question, error: r.error })
    } else if (r.status === 'stopped') {
      // Stopped before any answer arrived: take the question back so it can be edited or re-sent.
      task.reset()
      setMessages((m) => (m[m.length - 1]?.role === 'user' && m[m.length - 1].content === question ? m.slice(0, -1) : m))
      setInput((cur) => cur || question)
    }
  }

  const retry = () => {
    if (!failed) return
    // Drop the unanswered question and ask it again.
    const history = messages[messages.length - 1]?.role === 'user' ? messages.slice(0, -1) : messages
    void send(failed.question, history)
  }

  const newChat = () => {
    task.reset()
    setMessages([])
    setFailed(null)
    setInput('')
    inputRef.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(input)
    }
  }

  const empty = !messages.length && !task.running

  return (
    <div className="ai-tool ai-chat">
      <div
        ref={listRef}
        className="ai-chat__list"
        role="log"
        aria-label="Conversation"
        onScroll={(e) => {
          const el = e.currentTarget
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {empty && (
          <div className="ai-chat__intro">
            <p>Ask anything about “{doc.meta.title}”. Answers come from the document{selection?.trim() ? ' and your selection' : ''}.</p>
            <div className="ai-chips">
              {STARTER_QUESTIONS.map((q) => (
                <button key={q} type="button" className="ai-chip" onClick={() => void send(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="ai-msg ai-msg--user">
              <span className="sr-only">You: </span>
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="ai-msg ai-msg--ai">
              <span className="sr-only">AI: </span>
              <Markdown text={m.content} />
              <AnswerActions text={m.content} running={false} onStop={task.stop} />
            </div>
          ),
        )}
        {task.running && (
          <div className="ai-msg ai-msg--ai" aria-busy="true">
            {task.text ? <Markdown text={task.text} streaming /> : <Waiting label="Looking through the document…" />}
          </div>
        )}
        {failed && <ErrorNotice error={failed.error} onRetry={retry} onOpenSettings={onOpenSettings} />}
      </div>

      <form
        className="ai-chat__composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        {messages.length > 0 && !task.running && (
          <IconButton label="New chat" size="sm" onClick={newChat}>
            <MessageSquarePlus />
          </IconButton>
        )}
        <Textarea
          ref={inputRef}
          className="ai-chat__input"
          rows={1}
          value={input}
          placeholder="Ask about this document…"
          aria-label="Your question"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {task.running ? (
          <Button icon={<Square />} onClick={task.stop} aria-label="Stop answering">
            Stop
          </Button>
        ) : (
          <IconButton label="Send" variant="primary" type="submit" disabled={!input.trim()}>
            <SendHorizontal />
          </IconButton>
        )}
      </form>
    </div>
  )
}
