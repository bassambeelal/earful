// AI study tools built on chat(): summary, chat with document, quiz, explain, simplify, translate.
import type { Block, ImportedDoc } from '../../types'
import type { OpenDoc } from '../library'
import { AiError, abortError, throwIfAborted } from './errors'
import { aiBudget, chat } from './index'
import { passageIndex, scorePassages, tokenize } from './search'
import { blocksToText, chaptersFromBlocks, chunkBlocks, chunkText, contextAround, markdownToBlocks, sampleText } from './text'
import type { ChatMessage, ChatOptions } from './types'

export * from './text'

export interface Progress {
  done: number
  total: number
}

/** Run `fn` over items with limited concurrency, preserving order. Stops everything on the first error. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  onDone?: (done: number) => void,
): Promise<R[]> {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const results = new Array<R>(items.length)
  let next = 0
  let done = 0
  let failure: unknown = null
  const worker = async () => {
    while (next < items.length && !failure) {
      const i = next++
      try {
        results[i] = await fn(items[i], i, ctrl.signal)
        onDone?.(++done)
      } catch (e) {
        if (!failure) failure = e
        ctrl.abort()
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted) throw abortError()
  if (failure) throw failure
  return results
}

const LANGUAGE_RULE = 'Write in the same language as the document unless asked otherwise.'

/** chat() that treats a blank reply as an error (e.g. a thinking model ran out of room to answer). */
async function chatText(opts: ChatOptions): Promise<string> {
  const text = await chat(opts)
  if (!text.trim()) {
    throwIfAborted(opts.signal)
    throw new AiError('bad-response', 'The AI sent back an empty answer. Try again, or pick a different model in Settings.')
  }
  return text
}

function docHeader(title: string, scopeLabel?: string): string {
  return `Document: “${title}”${scopeLabel && scopeLabel !== 'Whole document' ? ` — ${scopeLabel}` : ''}`
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type SummaryStyle = 'brief' | 'detailed' | 'key-points'

export const SUMMARY_STYLES: Array<{ id: SummaryStyle; label: string }> = [
  { id: 'brief', label: 'Brief' },
  { id: 'detailed', label: 'Detailed' },
  { id: 'key-points', label: 'Key points' },
]

const STYLE_INSTRUCTIONS: Record<SummaryStyle, { text: string; maxTokens: number }> = {
  brief: { text: 'Write a brief summary: 3–5 sentences that capture the main point and the most important supporting ideas.', maxTokens: 700 },
  detailed: {
    text: 'Write a detailed summary. Start with a one-paragraph overview, then cover each major section or idea in order under short ### headings. Include the key arguments, evidence, examples and conclusions. Aim for roughly 300–700 words depending on the length of the text.',
    maxTokens: 2500,
  },
  'key-points': {
    text: 'List the key points as 5–10 concise bullet points, most important first. Each bullet is one or two sentences. Finish with a one-sentence takeaway in bold.',
    maxTokens: 1200,
  },
}

const SUMMARY_SYSTEM = `You are Earful’s study assistant. You write clear, accurate summaries for someone who is reading or listening to a document. Use only information from the provided text and never invent facts. ${LANGUAGE_RULE} Format with Markdown: short paragraphs, **bold** for key terms, bullet lists where they help. Don’t mention excerpts, notes or parts you were given — just summarize.`

/** Number of requests a summary will take (for "this will be read in N parts" hints). */
export function summaryParts(chars: number): number {
  const b = aiBudget()
  return chars <= b.contextChars ? 1 : Math.ceil(chars / b.chunkChars) + 1
}

export async function summarize(opts: {
  text: string
  title: string
  scopeLabel?: string
  style: SummaryStyle
  signal?: AbortSignal
  onToken?: (delta: string) => void
  /** Called while long documents are read part by part (map phase). */
  onProgress?: (p: Progress) => void
}): Promise<string> {
  const { title, style, signal } = opts
  const b = aiBudget()
  let material = opts.text.trim()
  if (!material) throw new AiError('config', 'There’s no text to summarize here.')
  let fromNotes = false

  // Map-reduce: condense long text into ordered notes until it fits in one request.
  for (let round = 0; material.length > b.contextChars && round < 3; round++) {
    const chunks = chunkText(material, b.chunkChars)
    opts.onProgress?.({ done: 0, total: chunks.length })
    const notes = await mapPool(
      chunks,
      b.concurrency,
      signal,
      (chunk, i, sig) =>
        chatText({
          signal: sig,
          temperature: 0.2,
          maxTokens: 1200,
          messages: [
            { role: 'system', content: `You take dense, faithful study notes. ${LANGUAGE_RULE}` },
            {
              role: 'user',
              content: `${docHeader(title, opts.scopeLabel)}\nThis is ${fromNotes ? 'a set of notes on ' : ''}part ${i + 1} of ${chunks.length}.\n\n<text>\n${chunk}\n</text>\n\nWrite concise bullet-point notes covering every important idea, argument, fact, name, number and conclusion in this part, in the original order. No introduction or commentary.`,
            },
          ],
        }),
      (done) => opts.onProgress?.({ done, total: chunks.length }),
    )
    material = notes.map((n, i) => `## Part ${i + 1}\n${n.trim()}`).join('\n\n')
    fromNotes = true
  }
  if (material.length > b.contextChars) material = sampleText(material, b.contextChars)

  const instruction = STYLE_INSTRUCTIONS[style]
  return chatText({
    signal,
    onToken: opts.onToken,
    temperature: 0.3,
    maxTokens: instruction.maxTokens,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      {
        role: 'user',
        content: `${docHeader(title, opts.scopeLabel)}\n\n${fromNotes ? 'Here are ordered notes covering the whole text:' : 'Here is the text:'}\n\n<document>\n${material}\n</document>\n\n${instruction.text}`,
      },
    ],
  })
}

// ---------------------------------------------------------------------------
// Chat with the document
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export const STARTER_QUESTIONS = [
  'What is this about, in a few sentences?',
  'What are the main ideas I should remember?',
  'Explain the hardest part in simple terms.',
  'What questions might I be asked about this?',
]

/** Pick the most relevant parts of a long document for a question (BM25 + text around the reader's position). */
export function selectContext(doc: OpenDoc, question: string, history: ChatTurn[], currentSentence: number, budget: number): string {
  const full = blocksToText(doc.content.blocks)
  if (full.length <= budget) return full
  const index = passageIndex(doc.content)
  const { passages } = index
  if (!passages.length) return full.slice(0, budget)

  const query = new Map<string, number>()
  for (const t of tokenize(question)) query.set(t, (query.get(t) ?? 0) + 1)
  // Follow-ups ("what about the second one?") lean on the previous question.
  const prev = [...history].reverse().find((h) => h.role === 'user')
  if (prev) for (const t of tokenize(prev.content)) query.set(t, (query.get(t) ?? 0) + 0.5)
  const scores = scorePassages(index, query)

  const chosen = new Set<number>()
  let used = 0
  const add = (i: number) => {
    if (i < 0 || i >= passages.length || chosen.has(i)) return false
    if (used + passages[i].text.length > budget) return false
    chosen.add(i)
    used += passages[i].text.length + 40
    return true
  }

  // Around the current position: roughly a fifth of the budget.
  const block = doc.sentences[currentSentence]?.block ?? 0
  const here = Math.max(0, passages.findIndex((p) => block >= p.start && block <= p.end))
  for (let d = 0; d <= 3 && used < budget * 0.2; d++) {
    add(here + d)
    if (d) add(here - d)
  }
  // Best matches.
  const ranked = scores.map((s, i) => ({ s, i })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
  for (const { i } of ranked) {
    if (used >= budget * 0.95) break
    add(i)
  }
  // General questions match nothing: fill with an even spread (with the opening first).
  if (used < budget * 0.6) {
    add(0)
    const step = Math.max(1, Math.floor(passages.length / Math.max(1, Math.floor((budget - used) / 1600))))
    for (let i = 0; i < passages.length && used < budget * 0.95; i += step) add(i)
  }

  let out = ''
  let lastHeading = ''
  let prevIdx = -2
  for (const i of [...chosen].sort((a, b) => a - b)) {
    const p = passages[i]
    if (prevIdx >= 0 && i !== prevIdx + 1) out += '\n\n[…]\n\n'
    else if (out) out += '\n\n'
    if (p.heading && p.heading !== lastHeading && !p.text.startsWith('#')) out += `[From “${p.heading}”]\n`
    lastHeading = p.heading
    out += p.text
    prevIdx = i
  }
  return out
}

export async function askDocument(opts: {
  doc: OpenDoc
  question: string
  history: ChatTurn[]
  currentSentence: number
  selection?: string | null
  signal?: AbortSignal
  onToken?: (delta: string) => void
}): Promise<string> {
  const { doc, question, history } = opts
  const b = aiBudget()
  const context = selectContext(doc, question, history, opts.currentSentence, b.contextChars)
  const complete = context.length >= blocksToText(doc.content.blocks).length
  const here = doc.sentences[opts.currentSentence]?.text
  const system = [
    `You are Earful’s study assistant, helping someone understand the document “${doc.meta.title}”${doc.meta.author ? ` by ${doc.meta.author}` : ''}.`,
    complete ? 'The full document is below.' : 'Below are the parts of the document most relevant to the conversation ([…] marks skipped text).',
    'Answer from the document. Quote short phrases when useful. If the answer isn’t in the document, say so plainly, then give a brief general answer and make clear it doesn’t come from the document.',
    'Be concise and friendly. Use Markdown for lists or emphasis. Answer in the language the user writes in.',
    here ? `The reader is currently at: “${here}”` : '',
    opts.selection?.trim() ? `The reader has selected: “${opts.selection.trim().slice(0, 1500)}”` : '',
    `<document>\n${context}\n</document>`,
  ]
    .filter(Boolean)
    .join('\n\n')

  // Clean history: skip blank turns, and drop questions that never got an answer
  // (stopped or failed) so user and assistant turns alternate.
  const turns: ChatTurn[] = []
  for (const h of history) {
    if (!h.content.trim()) continue
    if (turns.length && turns[turns.length - 1].role === h.role) turns[turns.length - 1] = h
    else turns.push(h)
  }
  if (turns.length && turns[turns.length - 1].role === 'user') turns.pop()

  // Recent history only, newest kept, ~8k characters.
  const recent: ChatMessage[] = []
  let size = 0
  for (let i = turns.length - 1; i >= 0 && recent.length < 10; i--) {
    size += turns[i].content.length
    if (size > 8000 && recent.length) break
    recent.unshift({ role: turns[i].role, content: turns[i].content })
  }
  while (recent.length && recent[0].role !== 'user') recent.shift()

  return chatText({
    signal: opts.signal,
    onToken: opts.onToken,
    temperature: 0.4,
    maxTokens: 1500,
    messages: [{ role: 'system', content: system }, ...recent, { role: 'user', content: question }],
  })
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

export interface QuizQuestion {
  q: string
  options: string[]
  /** Index into options. */
  answer: number
  explanation: string
}

export interface Quiz {
  questions: QuizQuestion[]
}

/** Parse JSON from model output that may include code fences, prose or trailing commas. */
export function parseLooseJson(text: string): unknown {
  let t = text.trim()
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t)
  if (fence) t = fence[1].trim()
  const start = t.search(/[[{]/)
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (start < 0 || end <= start) throw new SyntaxError('No JSON found')
  t = t.slice(start, end + 1)
  try {
    return JSON.parse(t)
  } catch {
    return JSON.parse(
      t
        .replace(/[“”]/g, '"')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\n\r\t]+/g, ' '),
    )
  }
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return asString(o.text ?? o.option ?? o.label ?? o.value ?? '')
  }
  return ''
}

/** Normalise whatever shape the model returned into valid quiz questions. */
export function normaliseQuiz(raw: unknown): QuizQuestion[] {
  const obj = raw as Record<string, unknown> | unknown[]
  const list = Array.isArray(obj) ? obj : Array.isArray(obj?.questions) ? (obj.questions as unknown[]) : Array.isArray(obj?.quiz) ? (obj.quiz as unknown[]) : []
  const parsed = list.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>
    const q = asString(o.q ?? o.question ?? o.prompt)
    const rawOptions = (Array.isArray(o.options) ? o.options : Array.isArray(o.choices) ? o.choices : []) as unknown[]
    const options = rawOptions.map((x) => asString(x).replace(/^\(?[A-Da-d][).:]\s+/, '')).filter(Boolean)
    const a = o.answer ?? o.correct ?? o.answerIndex ?? o.correctIndex ?? o.correct_answer
    let answer = -1
    if (typeof a === 'number') answer = a
    else if (typeof a === 'string') {
      const s = a.trim()
      if (/^\d+$/.test(s)) answer = Number(s)
      else if (/^\(?[A-Da-d]\)?[).:]?$/.test(s)) answer = s.replace(/[^A-Da-d]/g, '').toUpperCase().charCodeAt(0) - 65
      else answer = options.findIndex((opt) => opt.toLowerCase() === s.replace(/^\(?[A-Da-d][).:]\s+/, '').toLowerCase())
    }
    return { q, options, answer, explanation: asString(o.explanation ?? o.why ?? o.rationale) }
  })
  // If any answer equals the option count, the model counted from 1.
  const oneBased = parsed.some((p) => p.options.length && p.answer === p.options.length) && !parsed.some((p) => p.answer === 0)
  return parsed
    .map((p) => ({ ...p, answer: oneBased ? p.answer - 1 : p.answer }))
    .filter((p) => p.q && p.options.length >= 2 && p.answer >= 0 && p.answer < p.options.length)
    .map((p) => {
      // Keep at most 4 options, always including the right one.
      if (p.options.length <= 4) return p
      const correct = p.options[p.answer]
      const others = p.options.filter((_, i) => i !== p.answer).slice(0, 3)
      const options = [correct, ...others]
      return { ...p, options, answer: 0 }
    })
}

/** Shuffle options so the right answer isn't always in the same place. */
function shuffleOptions(q: QuizQuestion): QuizQuestion {
  const order = q.options.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return { ...q, options: order.map((i) => q.options[i]), answer: order.indexOf(q.answer) }
}

export async function makeQuiz(opts: { text: string; title: string; scopeLabel?: string; count: number; signal?: AbortSignal }): Promise<Quiz> {
  const count = Math.max(3, Math.min(10, Math.round(opts.count)))
  const b = aiBudget()
  const material = sampleText(opts.text.trim(), b.contextChars)
  if (!material) throw new AiError('config', 'There’s no text to make a quiz from here.')
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You write multiple-choice quizzes that check real understanding of a document. You always reply with a single valid JSON object and nothing else. ${LANGUAGE_RULE}`,
    },
    {
      role: 'user',
      content: `${docHeader(opts.title, opts.scopeLabel)}\n\n<document>\n${material}\n</document>\n\nWrite ${count} multiple-choice questions about this text.\nRules:\n- Each question has exactly 4 options and exactly one correct answer.\n- Wrong options are plausible, not silly.\n- Test important ideas, causes, meanings and conclusions — not trivia like page numbers.\n- Cover the whole text, in order.\n- "explanation" says in 1–2 sentences why the answer is right, based on the text.\n\nReply with JSON in exactly this shape:\n{"questions":[{"q":"…","options":["…","…","…","…"],"answer":0,"explanation":"…"}]}\n"answer" is the 0-based index of the correct option.`,
    },
  ]
  let reply = await chat({ messages, json: true, temperature: 0.5, maxTokens: 350 * count + 300, signal: opts.signal })
  for (let attempt = 0; ; attempt++) {
    try {
      const questions = normaliseQuiz(parseLooseJson(reply))
      if (questions.length) return { questions: questions.slice(0, count).map(shuffleOptions) }
    } catch {
      /* fall through to retry */
    }
    throwIfAborted(opts.signal)
    if (attempt >= 1) throw new AiError('bad-response', 'The AI didn’t return a usable quiz. Try again, or pick a different model.')
    reply = await chat({
      messages: [
        ...messages,
        { role: 'assistant', content: reply.slice(0, 4000) || '(empty)' },
        { role: 'user', content: 'That wasn’t valid JSON in the requested shape. Reply again with only the JSON object — no code fences, no other text.' },
      ],
      json: true,
      temperature: 0.2,
      maxTokens: 350 * count + 300,
      signal: opts.signal,
    })
  }
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

export type ExplainLevel = 'simple' | 'normal' | 'expert'

export const EXPLAIN_LEVELS: Array<{ id: ExplainLevel; label: string }> = [
  { id: 'simple', label: 'Simple' },
  { id: 'normal', label: 'Normal' },
  { id: 'expert', label: 'Expert' },
]

const EXPLAIN_INSTRUCTIONS: Record<ExplainLevel, string> = {
  simple: 'Explain it like I’m 12: plain everyday words, short sentences, and a quick analogy if it helps. No jargon. Under 150 words.',
  normal: 'Explain it clearly for a general adult reader: what it means, why it matters here, and what any difficult terms mean. Under 220 words.',
  expert: 'Explain it for an expert: be precise and cover nuances, assumptions, implications and related concepts. Technical vocabulary is fine. Under 350 words.',
}

export async function explainPassage(opts: {
  passage: string
  context: string
  title: string
  level: ExplainLevel
  signal?: AbortSignal
  onToken?: (delta: string) => void
}): Promise<string> {
  const passage = opts.passage.trim()
  if (!passage) throw new AiError('config', 'Select some text or move to a sentence to explain.')
  return chatText({
    signal: opts.signal,
    onToken: opts.onToken,
    temperature: 0.4,
    maxTokens: 900,
    messages: [
      {
        role: 'system',
        content: `You are Earful’s study assistant. You explain passages from documents so they are easy to understand. ${LANGUAGE_RULE} Use Markdown sparingly. Start directly with the explanation.`,
      },
      {
        role: 'user',
        content: `${docHeader(opts.title)}\n\nSurrounding text, for context:\n<context>\n${opts.context.slice(0, 4000)}\n</context>\n\nExplain this passage:\n<passage>\n${passage.slice(0, 6000)}\n</passage>\n\n${EXPLAIN_INSTRUCTIONS[opts.level]}`,
      },
    ],
  })
}

/** Grounding text for Explain: a couple of thousand characters around the reader's position. */
export function explainContext(doc: OpenDoc, currentSentence: number): string {
  return contextAround(doc, currentSentence, 2000)
}

// ---------------------------------------------------------------------------
// Simplify / Translate -> new document
// ---------------------------------------------------------------------------

export type ReadingLevel = 'grade3' | 'grade6' | 'grade9' | 'plain'

export const READING_LEVELS: Array<{ id: ReadingLevel; label: string; hint: string; prompt: string }> = [
  {
    id: 'grade3',
    label: 'Grade 3',
    hint: 'Very short sentences and everyday words (ages 8–9).',
    prompt: 'a US Grade 3 reading level (ages 8–9): very short sentences, common everyday words, and hard ideas explained simply',
  },
  {
    id: 'grade6',
    label: 'Grade 6',
    hint: 'Short sentences, familiar words, terms explained (ages 11–12).',
    prompt: 'a US Grade 6 reading level (ages 11–12): short sentences, familiar words, and technical terms briefly explained',
  },
  {
    id: 'grade9',
    label: 'Grade 9',
    hint: 'Clear sentences; keeps key terms and explains them (ages 14–15).',
    prompt: 'a US Grade 9 reading level (ages 14–15): clear sentences, keeping important terms but explaining them',
  },
  {
    id: 'plain',
    label: 'Plain English',
    hint: 'Direct, jargon-free wording for adults, keeping every detail.',
    prompt: 'plain English for busy adults: short direct sentences, active voice and no jargon, while keeping every detail',
  },
]

export interface TranslateLanguage {
  code: string
  name: string
  native: string
}

export const TRANSLATE_LANGUAGES: TranslateLanguage[] = [
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-Hant', name: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'cs', name: 'Czech', native: 'Čeština' },
  { code: 'da', name: 'Danish', native: 'Dansk' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'en', name: 'English', native: 'English' },
  { code: 'fil', name: 'Filipino', native: 'Filipino' },
  { code: 'fi', name: 'Finnish', native: 'Suomi' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά' },
  { code: 'ha', name: 'Hausa', native: 'Hausa' },
  { code: 'he', name: 'Hebrew', native: 'עברית' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar' },
  { code: 'ig', name: 'Igbo', native: 'Igbo' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu' },
  { code: 'no', name: 'Norwegian', native: 'Norsk' },
  { code: 'fa', name: 'Persian', native: 'فارسی' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', native: 'Português (Brasil)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', native: 'Português (Portugal)' },
  { code: 'ro', name: 'Romanian', native: 'Română' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
  { code: 'sv', name: 'Swedish', native: 'Svenska' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'yo', name: 'Yoruba', native: 'Yorùbá' },
]

export type RewriteMode = { kind: 'simplify'; level: ReadingLevel } | { kind: 'translate'; lang: string }

const STRUCTURE_RULES =
  'Keep the same structure: headings stay headings (lines starting with #), list items stay list items (lines starting with -), quotes stay quotes (lines starting with >), and paragraphs stay separated by blank lines. Leave code blocks unchanged. Keep names, numbers and facts accurate. Output only the rewritten text — no introduction, notes or commentary.'

/** Characters per request for simplify/translate. */
function rewriteChunkChars(): number {
  return Math.min(6000, aiBudget().chunkChars)
}

/** Number of requests a rewrite will take. */
export function rewriteParts(blocks: Block[]): number {
  return chunkBlocks(blocks, rewriteChunkChars()).length
}

export async function rewriteDocument(opts: {
  doc: OpenDoc
  blocks: Block[]
  /** Chapter title when only one chapter is rewritten. */
  partTitle?: string
  mode: RewriteMode
  signal?: AbortSignal
  onProgress?: (p: Progress) => void
}): Promise<ImportedDoc> {
  const { doc, mode, signal } = opts
  const source = opts.blocks.filter((b) => b.text.trim())
  if (!source.length) throw new AiError('config', 'There’s no text to rewrite here.')
  const b = aiBudget()
  const chunks = chunkBlocks(source, rewriteChunkChars())
  const language = mode.kind === 'translate' ? TRANSLATE_LANGUAGES.find((l) => l.code === mode.lang) ?? { code: mode.lang, name: mode.lang, native: mode.lang } : null
  const level = mode.kind === 'simplify' ? READING_LEVELS.find((l) => l.id === mode.level) ?? READING_LEVELS[3] : null

  const system =
    mode.kind === 'translate'
      ? `You are a professional translator. You translate documents faithfully and naturally into ${language!.name}, preserving meaning, tone and formatting.`
      : 'You rewrite text so it is easier to read while keeping its meaning and all important information. You write in the same language as the original.'
  const instruction =
    mode.kind === 'translate'
      ? `Translate the text below into ${language!.name} (${language!.native}). Translate everything; don’t summarize or skip anything. ${STRUCTURE_RULES}`
      : `Rewrite the text below at ${level!.prompt}. Don’t summarize — keep every point, in the same order. ${STRUCTURE_RULES}`

  opts.onProgress?.({ done: 0, total: chunks.length })
  const outputs = await mapPool(
    chunks,
    b.concurrency,
    signal,
    async (chunk, i, sig) => {
      const input = blocksToText(chunk)
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await chat({
          signal: sig,
          temperature: 0.3,
          // Generous: some scripts need close to one token per character.
          maxTokens: Math.min(16000, input.length + 1024),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `${instruction}\n\n<text>\n${input}\n</text>` },
          ],
        })
        const blocks = markdownToBlocks(out.replace(/^\s*<\/?text>\s*|\s*<\/?text>\s*$/g, ''))
        if (blocks.length) return blocks
        throwIfAborted(sig)
      }
      throw new AiError('bad-response', `The AI returned an empty result for part ${i + 1}. Try again, or pick a different model.`)
    },
    (done) => opts.onProgress?.({ done, total: chunks.length }),
  )

  const blocks = outputs.flat()
  const baseTitle = opts.partTitle ? `${doc.meta.title} — ${opts.partTitle}` : doc.meta.title
  return {
    title: mode.kind === 'translate' ? `${baseTitle} (${language!.native})` : `Simplified: ${baseTitle}`,
    author: doc.meta.author,
    source: 'ai',
    lang: mode.kind === 'translate' ? language!.code : doc.meta.lang,
    blocks,
    chapters: chaptersFromBlocks(blocks),
  }
}
