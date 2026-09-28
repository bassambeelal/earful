import { memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type Ref, type RefObject } from 'react'
import type { Block, DocContent } from '../../types'
import type { Sentence } from '../../lib/text'

// Renders the document once. Sentences are <span data-s={index}> so highlighting can be done
// imperatively (see useSentenceTracking) without re-rendering thousands of nodes.

export interface ContentApi {
  /** Make sure blocks up to `block` are in the DOM, then call `cb` (after commit). */
  renderUpTo(block: number, cb?: () => void): void
  /** Everything rendered? */
  complete(): boolean
}

interface Props {
  content: DocContent
  sentences: Sentence[]
  blockFirstSentence: number[]
  /** Block to make sure is rendered on first paint (reading position). */
  startBlock: number
  title: string
  subtitle: string
  lang?: string
  apiRef: Ref<ContentApi>
  articleRef: RefObject<HTMLElement | null>
  onSentenceClick: (index: number, charOffset: number | undefined) => void
}

const FIRST_BATCH = 400
const BATCH = 800

/** Character offset inside `span` under the pointer, for starting mid-sentence. */
function caretOffsetIn(span: HTMLElement, x: number, y: number): number | undefined {
  let node: Node | null = null
  let offset = 0
  if (typeof document.caretPositionFromPoint === 'function') {
    const p = document.caretPositionFromPoint(x, y)
    if (p) {
      node = p.offsetNode
      offset = p.offset
    }
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const r = document.caretRangeFromPoint(x, y)
    if (r) {
      node = r.startContainer
      offset = r.startOffset
    }
  }
  if (!node || !span.contains(node)) return undefined
  try {
    const r = document.createRange()
    r.setStart(span, 0)
    r.setEnd(node, offset)
    return r.toString().length
  } catch {
    return undefined
  }
}

function inlineSentences(block: Block, blockIndex: number, sentences: Sentence[], first: number): ReactNode {
  const text = block.text
  if (first < 0) return text
  const parts: ReactNode[] = []
  let pos = 0
  for (let i = first; i < sentences.length && sentences[i].block === blockIndex; i++) {
    const s = sentences[i]
    if (s.start > pos) parts.push(text.slice(pos, s.start))
    parts.push(
      <span key={i} className="s" data-s={i}>
        {s.text}
      </span>,
    )
    pos = s.end
  }
  if (pos < text.length) parts.push(text.slice(pos))
  return parts
}

const BlockView = memo(function BlockView({ block, index, sentences, first }: { block: Block; index: number; sentences: Sentence[]; first: number }) {
  const inner = inlineSentences(block, index, sentences, first)
  switch (block.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level ?? 2))
      const Tag = `h${level}` as 'h1'
      return (
        <Tag className={`blk doc-h doc-h${level}`} data-b={index}>
          {inner}
        </Tag>
      )
    }
    case 'quote':
      return (
        <blockquote className="blk" data-b={index}>
          {inner}
        </blockquote>
      )
    case 'code':
      return (
        <pre className="blk" data-b={index}>
          {inner}
        </pre>
      )
    case 'list-item':
      return (
        <li className="blk" data-b={index}>
          {inner}
        </li>
      )
    default:
      return (
        <p className="blk" data-b={index}>
          {inner}
        </p>
      )
  }
})

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

export const ReaderContent = memo(function ReaderContent({
  content,
  sentences,
  blockFirstSentence,
  startBlock,
  title,
  subtitle,
  lang,
  apiRef,
  articleRef,
  onSentenceClick,
}: Props) {
  const blocks = content.blocks
  const [count, setCount] = useState(() => Math.min(blocks.length, Math.max(FIRST_BATCH, startBlock + 150)))
  const countRef = useRef(count)
  countRef.current = count
  const pending = useRef<Array<{ block: number; cb: () => void }>>([])

  useImperativeHandle(
    apiRef,
    () => ({
      renderUpTo(block, cb) {
        if (block < countRef.current) {
          cb?.()
          return
        }
        if (cb) pending.current.push({ block, cb })
        setCount((c) => Math.max(c, Math.min(blocks.length, block + BATCH)))
      },
      complete: () => countRef.current >= blocks.length,
    }),
    [blocks.length],
  )

  // Render the rest in the background, a batch at a time, so the first paint is fast.
  useEffect(() => {
    if (count >= blocks.length) return
    const t = setTimeout(() => setCount((c) => Math.min(blocks.length, c + BATCH)), 40)
    return () => clearTimeout(t)
  }, [count, blocks.length])

  useLayoutEffect(() => {
    if (!pending.current.length) return
    const ready = pending.current.filter((p) => p.block < count)
    pending.current = pending.current.filter((p) => p.block >= count)
    for (const p of ready) p.cb()
  }, [count])

  const onClick = (e: MouseEvent<HTMLElement>) => {
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed && sel.toString().trim()) return
    const span = (e.target as HTMLElement).closest<HTMLElement>('[data-s]')
    if (!span) return
    onSentenceClick(Number(span.dataset.s), caretOffsetIn(span, e.clientX, e.clientY))
  }

  const firstIsTitle = blocks[0]?.type === 'heading' && normalize(blocks[0].text) === normalize(title)

  const out: ReactNode[] = []
  let i = 0
  while (i < count) {
    const b = blocks[i]
    if (b.type === 'list-item') {
      const start = i
      const items: ReactNode[] = []
      while (i < count && blocks[i].type === 'list-item') {
        items.push(<BlockView key={i} block={blocks[i]} index={i} sentences={sentences} first={blockFirstSentence[i]} />)
        i++
      }
      out.push(<ul key={`ul-${start}`}>{items}</ul>)
    } else {
      out.push(<BlockView key={i} block={b} index={i} sentences={sentences} first={blockFirstSentence[i]} />)
      i++
    }
  }

  return (
    <article ref={articleRef} className="doc" lang={lang} onClick={onClick}>
      <header className="doc__header">
        {!firstIsTitle && <h1 className="doc__title">{title}</h1>}
        {subtitle && <p className="doc__subtitle">{subtitle}</p>}
      </header>
      {out}
      {count < blocks.length && <p className="doc__more">Loading the rest of the document…</p>}
      {count >= blocks.length && (
        <p className="doc__end" aria-hidden>
          The end
        </p>
      )}
    </article>
  )
})
