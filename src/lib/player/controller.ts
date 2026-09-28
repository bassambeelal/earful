// The playback controller. It turns sentences into speech with the selected engine and
// tracks the current sentence/word for highlighting.
//
// Every play/seek/engine change starts a new "run" with its own AbortController; older runs
// are aborted and can no longer touch the store. Speech engines (Web Speech) speak one
// sentence per utterance. Synth engines return audio clips: a small pipeline synthesizes a
// few chunks ahead while the current one plays through one shared <audio> element.
import { create } from 'zustand'
import type { Block } from '../../types'
import { toast } from '../../components/ui'
import { useLibrary } from '../library'
import { getSettings, RATE_MAX, RATE_MIN, useSettings, type EngineId, type KeyId, type Settings } from '../settings'
import { cleanText, segmentBlocks, spokenToDisplay, wordAt, type Sentence, type SpokenText, type WordSpan } from '../text'
import { ENGINE_INFO, getEngine } from '../tts/registry'
import type { SpeechEngine, SynthEngine, WordTiming } from '../tts/types'
import { audioElement, hasActiveClip, onExternalPause, pauseClip, playClip, resumeClip, setClipRate, stopClip, unlockAudio } from './audio'
import { initMediaSession, setMediaMetadata, setMediaPlaybackState } from './media-session'
import { blocksFor, firstSpokenWord, headingSkip, makePlan, nextPlayable, planChunk, prevPlayable, spokenFrom, spokenOf, type Chunk, type Plan } from './plan'
import { ensureEngineReady, friendlyError, synthesizeChunk, type PreparedAudio } from './synth'
import { estimateTimings, timingIndexAt } from './timing'
import { abortable, abortError, clamp, delay, isAbortError } from './util'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface PlayerState {
  status: PlayerStatus
  /** Document currently loaded into the player. */
  docId: string | null
  title: string
  /** Current global sentence index. */
  sentence: number
  total: number
  /** Current word, display offsets relative to sentences[sentence].text; null if unknown. */
  word: WordSpan | null
  /** Waiting for audio (synthesis in flight / model loading) while status is 'playing'. */
  buffering: boolean
  error: string | null
  /** Epoch ms when the sleep timer stops playback, or null. */
  sleepAt: number | null
  /** Sleep at end of the current chapter/section. */
  sleepAtChapterEnd: boolean
  /** A one-off text from speakText() is being read (the document is paused meanwhile). */
  speakingText: boolean

  /** Load a document. Does not start playback. Stops anything currently playing. */
  load(docId: string, sentences: Sentence[], opts: { startAt: number; title: string; blockCount: number; chapterStarts: number[] }): void
  /** Unload (e.g. document deleted). */
  unload(): void
  play(): void
  pause(): void
  toggle(): void
  /** Jump to a sentence. If playing, continues playing from there. wordOffset (display offset within the sentence) is honoured by engines that can start mid-sentence. */
  seek(sentence: number, opts?: { wordOffset?: number; play?: boolean }): void
  next(): void
  prev(): void
  nextParagraph(): void
  prevParagraph(): void
  /** Update speed immediately (0.5–4). Also persists to settings.rate. */
  setRate(rate: number): void
  /** Minutes from now, or null to cancel. */
  setSleepTimer(minutes: number | null): void
  setSleepAtChapterEnd(on: boolean): void
  /** Re-read settings (engine/voice/filters changed) and restart the current sentence if playing. */
  refreshEngine(): void
  /** Speak a one-off text (e.g. an AI answer) with the current engine; interrupts the document. */
  speakText(text: string): Promise<void>
}

/** Start estimating word positions if a speech voice sends no boundary events for this long. */
const BOUNDARY_TIMEOUT_MS = 600
/** Typical Web Speech pace at 1x, used for that estimate. */
const SPEECH_CHARS_PER_SEC = 14
/** Rapid next/prev clicks while playing a synth voice coalesce into one request. */
const SEEK_DEBOUNCE_MS = 180
/** Speech voices restart the sentence on a speed change; wait for the slider to settle. */
const RATE_RESTART_MS = 350
const REFRESH_FAST_MS = 150
const REFRESH_SLOW_MS = 1000

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** What a run reads: the loaded document, or a one-off text. */
interface Script {
  kind: 'doc' | 'text'
  plan: Plan
  lang?: string
  /** Show a new current sentence/word. */
  position(i: number, word: WordSpan | null): void
  /** About to move from sentence `from` to `to`; return false to stop before `to`. */
  proceed(from: number, to: number): boolean
  /** Called exactly once when the script stops for good (finished, failed or cancelled). */
  onEnd(): void
}

interface Run {
  script: Script
  ctrl: AbortController
  /** Engine kind, known once the engine is ready. */
  kind: 'speech' | 'synth' | null
  /** Synth document runs pause in place (audio paused, pipeline kept) instead of being cancelled. */
  paused: boolean
  resumeWaiters: Array<() => void>
  buffering: boolean
  /** Last position shown by this run (also used to restart it). */
  at: number
  atWord: WordSpan | null
  ended: boolean
}

interface LoadedDoc {
  id: string
  sentences: Sentence[]
  chapterStarts: number[]
  /** The document's blocks (needed to skip headings), remembered once the library has them open. */
  blocks: Block[] | null
}

let doc: LoadedDoc | null = null
let docPlan: Plan | null = null
let docPlanHasBlocks = false
let run: Run | null = null
/** Display offset to resume the current sentence from (speech voices resume mid-sentence). */
let resumeWord: number | undefined
/** The document was read to the end; the next play() starts over. */
let atEnd = false
let appliedRate = clampRate(getSettings().rate)
let sleepTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
let rateRestartTimer: ReturnType<typeof setTimeout> | null = null

const st = () => usePlayer.getState()
const patch = (p: Partial<PlayerState>) => usePlayer.setState(p)

function clampRate(rate: number): number {
  return clamp(Number.isFinite(rate) ? Math.round(rate * 100) / 100 : 1, RATE_MIN, RATE_MAX)
}

function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
  if (t) clearTimeout(t)
  return null
}

function isCurrent(r: Run): boolean {
  return run === r && !r.ctrl.signal.aborted
}

function isNotAllowed(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'NotAllowedError'
}

/** The browser or OS cut a browser voice off (another app took the audio, the tab was backgrounded...). */
function isInterruption(e: unknown): boolean {
  return e instanceof Error && /interrupted/i.test(e.message)
}

/** A run that was replaced or cancelled must not touch anything any more. */
function throwIfStale(r: Run) {
  if (!isCurrent(r)) throw abortError()
}

/**
 * iOS only lets audio start inside a user gesture, so voices that play through the shared
 * <audio> element warm it up here (synchronously, while the gesture is still active).
 * Browser voices don't use it, and starting an <audio> clip can cut off speech on iOS.
 */
function unlockForEngine() {
  try {
    if (getEngine(getSettings().engine).kind === 'synth') unlockAudio()
  } catch {
    /* engine unavailable: nothing to unlock */
  }
}

function paragraphPauseMs(): number {
  return Math.max(0, getSettings().reading.paragraphPauseMs || 0) / appliedRate
}

function reportError(e: unknown) {
  patch({ status: 'error', error: friendlyError(e), buffering: false })
}

function getDocPlan(): Plan | null {
  return doc ? planForDoc(doc) : null
}

/** The library's blocks for `d` when its open document is this one (and really matches it). */
function findBlocks(d: LoadedDoc): Block[] | null {
  const blocks = blocksFor(d.sentences, d.id)
  const last = d.sentences[d.sentences.length - 1]
  return blocks && (!last || last.block < blocks.length) ? blocks : null
}

function planForDoc(d: LoadedDoc): Plan {
  const reading = getSettings().reading
  if (!reading.readHeadings && !d.blocks) d.blocks = findBlocks(d)
  const blocks = reading.readHeadings ? null : d.blocks
  if (!docPlan || (blocks && !docPlanHasBlocks)) {
    docPlan = makePlan(d.sentences, reading, headingSkip(blocks, d.sentences, reading.readHeadings))
    docPlanHasBlocks = !!blocks
  }
  return docPlan
}

function docLang(id: string): string | undefined {
  const lib = useLibrary.getState()
  if (lib.open?.meta.id === id) return lib.open.meta.lang
  return lib.docs.find((d) => d.id === id)?.lang
}

function sameWord(a: WordSpan | null, b: WordSpan | null): boolean {
  return a === b || (!!a && !!b && a.start === b.start && a.end === b.end)
}

/** Move the document position; the store only changes when something actually changed. */
function setPosition(i: number, word: WordSpan | null) {
  const s = st()
  if (s.sentence === i && sameWord(s.word, word)) return
  const moved = s.sentence !== i
  patch({ sentence: i, word })
  if (moved && doc) useLibrary.getState().savePosition(doc.id, i)
}

function docProceed(from: number, to: number): boolean {
  if (!st().sleepAtChapterEnd || !doc?.chapterStarts.some((c) => c > from && c <= to)) return true
  // Crossing into the next chapter with "sleep at end of chapter" on: stop at its start.
  cancelRun()
  resumeWord = undefined
  setPosition(to, null)
  patch({ status: 'paused', buffering: false, sleepAtChapterEnd: false })
  return false
}

function docScript(d: LoadedDoc): Script {
  return {
    kind: 'doc',
    plan: planForDoc(d),
    lang: docLang(d.id),
    position: setPosition,
    proceed: docProceed,
    onEnd: () => {},
  }
}

function endRun(r: Run) {
  if (r.ended) return
  r.ended = true
  r.script.onEnd()
}

/** Abort the current run. `keepScript` means a new run continues the same script (restart). */
function cancelRun(keepScript = false) {
  rateRestartTimer = clearTimer(rateRestartTimer)
  const r = run
  if (!r) return
  run = null
  r.ctrl.abort()
  if (keepScript) r.ended = true
  else endRun(r)
}

function detach(r: Run) {
  run = null
  r.ctrl.abort()
  endRun(r)
}

function startRun(script: Script, start: number, wordOffset?: number, delayMs = 0, keepScript = false) {
  cancelRun(keepScript)
  const r: Run = {
    script,
    ctrl: new AbortController(),
    kind: null,
    paused: false,
    resumeWaiters: [],
    buffering: false,
    at: start,
    atWord: null,
    ended: false,
  }
  run = r
  // Not awaited: for speech voices the first speak() happens synchronously, inside the user's
  // gesture, which iOS requires.
  void execute(r, start, wordOffset, delayMs)
}

/** Restart a run at its current sentence with fresh settings (speech voices resume at the current word). */
function restartRun(r: Run) {
  const script = r.script
  if (script.kind === 'doc') {
    if (!doc) return cancelRun()
    script.plan = planForDoc(doc)
    script.lang = docLang(doc.id)
  } else {
    script.plan = makePlan(script.plan.sentences, getSettings().reading)
  }
  startRun(script, r.at, r.kind === 'speech' ? r.atWord?.start : undefined, 0, true)
}

async function execute(r: Run, start: number, wordOffset: number | undefined, delayMs: number): Promise<void> {
  const signal = r.ctrl.signal
  try {
    const settings = getSettings()
    const engineId = settings.engine
    const engine = getEngine(engineId)
    if (!engine.isReady()) {
      await ensureEngineReady(engineId, engine, signal, () => setBuffering(r, true))
      setBuffering(r, false)
    }
    r.kind = engine.kind
    if (delayMs) await delay(delayMs, signal)
    if (engine.kind === 'speech') await speechLoop(r, engine, settings.voices[engineId], start, wordOffset)
    else await synthLoop(r, engineId, engine, settings.voices[engineId] ?? '', start, wordOffset)
  } catch (e) {
    failRun(r, e)
  }
}

function failRun(r: Run, e: unknown) {
  if (!isCurrent(r)) return
  detach(r)
  if (r.script.kind === 'text') {
    if (!isAbortError(e) && !isNotAllowed(e)) toast.error(friendlyError(e))
    return
  }
  if (isAbortError(e) || isNotAllowed(e) || (r.kind === 'speech' && isInterruption(e))) {
    // Stopped by the browser or OS (autoplay blocked, speech taken over elsewhere): just pause.
    resumeWord = r.kind === 'speech' ? r.atWord?.start : undefined
    patch({ status: 'paused', buffering: false })
    return
  }
  patch({ status: 'error', error: friendlyError(e), buffering: false })
}

function completeRun(r: Run) {
  if (!isCurrent(r)) return
  detach(r)
  if (r.script.kind !== 'doc') return
  atEnd = true
  resumeWord = undefined
  // Nothing after here is spoken: mark the whole document as read (the library shows "Finished").
  setPosition(Math.max(0, r.script.plan.sentences.length - 1), null)
  // "Stop at the end of the chapter" is satisfied by the end of the document too.
  patch({ status: 'paused', buffering: false, sleepAtChapterEnd: false })
}

function track(r: Run, i: number, word: WordSpan | null) {
  if (!isCurrent(r)) return
  r.at = i
  r.atWord = word
  r.script.position(i, word)
}

function setBuffering(r: Run, on: boolean) {
  r.buffering = on
  if (isCurrent(r) && r.script.kind === 'doc' && !r.paused && st().buffering !== on) patch({ buffering: on })
}

/** Resolves immediately unless the run is paused, then when it resumes. */
function gate(r: Run): Promise<void> {
  if (!r.paused) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const signal = r.ctrl.signal
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    r.resumeWaiters.push(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Speech engines: one sentence per utterance
// ---------------------------------------------------------------------------

async function speechLoop(r: Run, engine: SpeechEngine, voice: string | undefined, start: number, wordOffset?: number) {
  const { plan } = r.script
  const signal = r.ctrl.signal
  let i = nextPlayable(plan, start)
  let prev = -1
  // The offset belongs to `start`; it means nothing if that sentence is skipped.
  let offset = i === start ? wordOffset : undefined
  while (i >= 0) {
    throwIfStale(r)
    if (prev >= 0 && !r.script.proceed(prev, i)) return
    const sentence = plan.sentences[i]
    const spoken = spokenFrom(sentence, spokenOf(plan, i), offset)
    offset = undefined
    track(r, i, firstSpokenWord(sentence, spoken))
    await speakSentence(r, engine, voice, i, spoken)
    prev = i
    i = nextPlayable(plan, i + 1)
    if (i >= 0 && plan.sentences[i].block !== sentence.block) await delay(paragraphPauseMs(), signal)
  }
  completeRun(r)
}

function speakSentence(r: Run, engine: SpeechEngine, voice: string | undefined, i: number, spoken: SpokenText): Promise<void> {
  const signal = r.ctrl.signal
  const sentence = r.script.plan.sentences[i]
  const rate = Math.min(appliedRate, engine.maxRate || RATE_MAX)
  let heard = false
  let startedAt = performance.now()
  let timings: WordTiming[] | null = null
  let hint = 0
  let wait: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null

  const show = (charIndex: number) => {
    const d = spokenToDisplay(spoken, charIndex, charIndex + 1)
    track(r, i, wordAt(sentence, d.start))
  }
  // Some voices never fire word boundaries: estimate from elapsed time instead.
  const estimate = () => {
    if (heard || signal.aborted) return
    timings ??= estimateTimings(spoken.text, spoken.text.length / SPEECH_CHARS_PER_SEC)
    hint = timingIndexAt(timings, ((performance.now() - startedAt) / 1000) * rate, hint)
    if (hint >= 0) show(timings[hint].charStart)
  }
  const armFallback = () => {
    if (wait) clearTimeout(wait)
    wait = setTimeout(() => {
      wait = null
      if (!heard && !poll) poll = setInterval(estimate, 100)
    }, BOUNDARY_TIMEOUT_MS)
  }
  const stopFallback = () => {
    if (wait) clearTimeout(wait)
    if (poll) clearInterval(poll)
    wait = null
    poll = null
  }

  armFallback()
  let speaking: Promise<void>
  try {
    speaking = engine.speak(
      spoken.text,
      {
        voice,
        rate,
        lang: r.script.lang,
        onStart: () => {
          startedAt = performance.now()
          if (!heard && !poll) armFallback()
        },
        onBoundary: (charIndex) => {
          if (signal.aborted) return
          heard = true
          stopFallback()
          show(charIndex)
        },
      },
      signal,
    )
  } catch (e) {
    stopFallback()
    return Promise.reject(e)
  }
  return abortable(speaking, signal).finally(stopFallback)
}

// ---------------------------------------------------------------------------
// Synth engines: pipelined chunks through the shared <audio> element
// ---------------------------------------------------------------------------

interface Pending {
  chunk: Chunk
  audio: Promise<PreparedAudio>
  settled: boolean
}

async function synthLoop(r: Run, engineId: EngineId, engine: SynthEngine, voice: string, start: number, wordOffset?: number) {
  const { plan } = r.script
  const signal = r.ctrl.signal
  const ahead = Math.max(0, Math.floor(engine.prefetch || 0))
  const maxChars = Math.max(80, engine.maxChunkChars || 400)
  const queue: Pending[] = []
  let cursor = nextPlayable(plan, start)
  // The offset belongs to `start`; it means nothing if that sentence is skipped.
  const startOffset = cursor === start ? wordOffset : undefined
  let first = true

  // Keep the chunk about to play plus `ahead` more synthesizing. The first chunk after
  // play/seek is a single sentence so audio starts as soon as possible.
  const fill = () => {
    while (cursor >= 0 && queue.length <= ahead) {
      const { chunk, next } = planChunk(plan, cursor, { maxChars, single: first, wordOffset: first ? startOffset : undefined })
      first = false
      cursor = next
      const item: Pending = { chunk, audio: synthesizeChunk(engineId, engine, voice, chunk.text, signal), settled: false }
      const settle = () => {
        item.settled = true
      }
      item.audio.then(settle, settle)
      queue.push(item)
    }
  }

  let prev = -1
  for (;;) {
    throwIfStale(r)
    fill()
    const item = queue.shift()
    if (!item) break
    const head = item.chunk.parts[0]
    if (prev >= 0 && !r.script.proceed(prev, head.sentence)) return
    track(r, head.sentence, firstSpokenWord(plan.sentences[head.sentence], head.spoken))
    if (!item.settled) setBuffering(r, true)
    const audio = await abortable(item.audio, signal)
    setBuffering(r, false)
    await gate(r)
    await playChunk(r, item.chunk, audio)
    prev = item.chunk.parts[item.chunk.parts.length - 1].sentence
    if (item.chunk.blockEnd && (queue.length || cursor >= 0)) await delay(paragraphPauseMs(), signal)
  }
  completeRun(r)
}

/** Play one chunk, moving the sentence/word highlight along with the audio clock. */
async function playChunk(r: Run, chunk: Chunk, audio: PreparedAudio): Promise<void> {
  const el = audioElement()
  const sentences = r.script.plan.sentences
  let timings: WordTiming[] | null = audio.words?.length ? audio.words : null
  let hint = 0
  let part = 0

  const update = () => {
    if (!timings) {
      const known = audio.duration && audio.duration > 0 ? audio.duration : 0
      const duration = known || (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0)
      if (!duration) return
      timings = estimateTimings(chunk.text, duration)
    }
    hint = timingIndexAt(timings, el.currentTime, hint)
    if (hint < 0) return
    const t = timings[hint]
    while (part + 1 < chunk.parts.length && t.charStart >= chunk.parts[part + 1].offset) part++
    while (part > 0 && t.charStart < chunk.parts[part].offset) part--
    const p = chunk.parts[part]
    const d = spokenToDisplay(p.spoken, t.charStart - p.offset, t.charEnd - p.offset)
    track(r, p.sentence, wordAt(sentences[p.sentence], d.start))
  }

  // requestAnimationFrame for smooth highlighting; 'timeupdate' keeps the position (and the
  // saved reading position) moving while the tab is in the background.
  let frame = 0
  const loop = () => {
    if (!el.paused) update()
    frame = requestAnimationFrame(loop)
  }
  el.addEventListener('timeupdate', update)
  frame = requestAnimationFrame(loop)
  try {
    await playClip(audio.blob, appliedRate, r.ctrl.signal)
  } finally {
    cancelAnimationFrame(frame)
    el.removeEventListener('timeupdate', update)
  }
}

// ---------------------------------------------------------------------------
// Rate, refresh, one-off text
// ---------------------------------------------------------------------------

function applyRate(rate: number) {
  if (rate === appliedRate) return
  appliedRate = rate
  setClipRate(rate)
  const r = run
  if (r?.kind === 'speech' && !r.paused) {
    rateRestartTimer = clearTimer(rateRestartTimer)
    rateRestartTimer = setTimeout(() => {
      rateRestartTimer = null
      if (isCurrent(r)) restartRun(r)
    }, RATE_RESTART_MS)
  }
}

function resumeFailed(r: Run, e: unknown) {
  if (!isCurrent(r) || isAbortError(e)) return
  if (isNotAllowed(e)) {
    r.paused = true
    patch({ status: 'paused', buffering: false })
  } else {
    failRun(r, e)
  }
}

function stopText() {
  if (run?.script.kind === 'text') cancelRun()
}

function textScript(sentences: Sentence[], onEnd: () => void): Script {
  return {
    kind: 'text',
    plan: makePlan(sentences, getSettings().reading),
    position: () => {},
    proceed: () => true,
    onEnd,
  }
}

function engineKey(engine: EngineId): KeyId | null {
  try {
    const k = ENGINE_INFO[engine]?.needsKey
    if (k) return k
  } catch {
    /* registry unavailable */
  }
  return engine === 'custom' ? 'custom' : null
}

/** Apply new engine/voice/filter settings: restart what is playing, drop a paused pipeline, clear an error. */
function refreshNow() {
  refreshTimer = clearTimer(refreshTimer)
  docPlan = null
  const r = run
  const s = st()
  if (r && (r.script.kind === 'text' || (!r.paused && s.status === 'playing'))) return restartRun(r)
  if (r) cancelRun() // drop a paused pipeline: resuming re-synthesizes with the new settings
  if (s.status === 'error') patch({ status: doc ? 'paused' : 'idle', error: null })
}

/** How long to wait before refreshing for a settings change, or null if playback isn't affected. */
function refreshDelay(s: Settings, p: Settings): number | null {
  const e = s.engine
  if (e !== p.engine || s.voices[e] !== p.voices[e]) return REFRESH_FAST_MS
  const a = s.reading
  const b = p.reading
  if (a.skipCitations !== b.skipCitations || a.skipUrls !== b.skipUrls || a.skipParentheticals !== b.skipParentheticals || a.readHeadings !== b.readHeadings) {
    return REFRESH_FAST_MS
  }
  if (e === 'kokoro' && s.kokoro.device !== p.kokoro.device) return REFRESH_FAST_MS
  // Free-text settings (keys, URLs, instructions) are typed character by character: wait longer.
  if (e !== 'browser' && e !== 'kokoro' && s.ttsModels[e] !== p.ttsModels[e]) return REFRESH_SLOW_MS
  const key = engineKey(e)
  if (key && s.keys[key] !== p.keys[key]) return REFRESH_SLOW_MS
  if (e === 'custom' && s.customTtsBaseUrl !== p.customTtsBaseUrl) return REFRESH_SLOW_MS
  if (e === 'openai' && s.openaiInstructions !== p.openaiInstructions) return REFRESH_SLOW_MS
  return null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePlayer = create<PlayerState>()((set, get) => {
  const guard = (fn: () => void) => {
    try {
      fn()
    } catch (e) {
      reportError(e)
    }
  }

  return {
    status: 'idle',
    docId: null,
    title: '',
    sentence: 0,
    total: 0,
    word: null,
    buffering: false,
    error: null,
    sleepAt: null,
    sleepAtChapterEnd: false,
    speakingText: false,

    load(docId, sentences, opts) {
      guard(() => {
        const title = opts?.title ?? ''
        if (doc && doc.id === docId) {
          if (get().title !== title) {
            set({ title })
            setMediaMetadata(title)
          }
          return
        }
        cancelRun()
        stopClip()
        const list = sentences ?? []
        doc = { id: docId, sentences: list, chapterStarts: [...(opts?.chapterStarts ?? [])].sort((a, b) => a - b), blocks: null }
        doc.blocks = findBlocks(doc)
        docPlan = null
        resumeWord = undefined
        atEnd = false
        const startAt = clamp(Math.floor(Number(opts?.startAt) || 0), 0, Math.max(0, list.length - 1))
        set({ docId, title, sentence: startAt, total: list.length, word: null, status: 'idle', buffering: false, error: null })
        setMediaMetadata(title)
      })
    },

    unload() {
      guard(() => {
        cancelRun()
        stopClip()
        sleepTimer = clearTimer(sleepTimer)
        doc = null
        docPlan = null
        resumeWord = undefined
        atEnd = false
        set({
          status: 'idle',
          docId: null,
          title: '',
          sentence: 0,
          total: 0,
          word: null,
          buffering: false,
          error: null,
          sleepAt: null,
          sleepAtChapterEnd: false,
        })
        setMediaMetadata(null)
      })
    },

    play() {
      guard(() => {
        if (get().speakingText) stopText()
        const d = doc
        if (!d || !d.sentences.length) return
        unlockForEngine() // synchronously, while we're still inside the user's gesture
        const r = run
        if (r?.script.kind === 'doc' && r.paused) {
          r.paused = false
          set({ status: 'playing', error: null, buffering: r.buffering })
          for (const resume of r.resumeWaiters.splice(0)) resume()
          if (hasActiveClip()) resumeClip().catch((e) => resumeFailed(r, e))
          return
        }
        if (r && get().status === 'playing') return
        let start = get().sentence
        let word = resumeWord
        if (atEnd) {
          start = 0
          word = undefined
          atEnd = false
          setPosition(0, null)
        }
        resumeWord = undefined
        set({ status: 'playing', error: null, buffering: false })
        startRun(docScript(d), start, word)
      })
    },

    pause() {
      guard(() => {
        const s = get()
        if (s.speakingText) return stopText()
        if (s.status !== 'playing' && s.status !== 'loading') return
        const r = run
        if (r?.kind === 'synth') {
          r.paused = true
          pauseClip()
          set({ status: 'paused', buffering: false })
          return
        }
        // Speech can't pause reliably across browsers: stop, and resume from the current word.
        resumeWord = s.word?.start
        cancelRun()
        set({ status: 'paused', buffering: false })
      })
    },

    toggle() {
      const s = get()
      if (s.speakingText || s.status === 'playing' || s.status === 'loading') s.pause()
      else s.play()
    },

    seek(sentence, opts) {
      guard(() => {
        if (get().speakingText) stopText()
        const d = doc
        if (!d || !d.sentences.length) return
        const i = clamp(Math.floor(Number(sentence) || 0), 0, d.sentences.length - 1)
        const s = get()
        const wasPlaying = s.status === 'playing' || s.status === 'loading'
        const shouldPlay = opts?.play ?? wasPlaying
        const offset = opts?.wordOffset != null && opts.wordOffset > 0 ? opts.wordOffset : undefined
        const debounce = wasPlaying && run?.kind === 'synth' ? SEEK_DEBOUNCE_MS : 0
        atEnd = false
        cancelRun()
        setPosition(i, offset != null ? wordAt(d.sentences[i], offset) : null)
        if (shouldPlay) {
          unlockForEngine()
          resumeWord = undefined
          set({ status: 'playing', error: null, buffering: false })
          startRun(docScript(d), i, offset, debounce)
        } else {
          resumeWord = offset
          if (s.status !== 'idle') set({ status: 'paused', error: null, buffering: false })
        }
      })
    },

    next() {
      guard(() => {
        const plan = getDocPlan()
        if (!plan) return
        const n = nextPlayable(plan, get().sentence + 1)
        if (n >= 0) get().seek(n)
      })
    },

    prev() {
      guard(() => {
        const plan = getDocPlan()
        if (!plan) return
        const cur = get().sentence
        const p = prevPlayable(plan, cur - 1)
        get().seek(p >= 0 ? p : cur)
      })
    },

    nextParagraph() {
      guard(() => {
        const plan = getDocPlan()
        if (!plan) return
        const ss = plan.sentences
        const cur = get().sentence
        let i = cur + 1
        while (i < ss.length && ss[i].block === ss[cur]?.block) i++
        const n = nextPlayable(plan, i)
        if (n >= 0) get().seek(n)
      })
    },

    prevParagraph() {
      guard(() => {
        const plan = getDocPlan()
        if (!plan || !plan.sentences.length) return
        const ss = plan.sentences
        const cur = get().sentence
        const blockStart = (i: number) => {
          let k = i
          while (k > 0 && ss[k - 1].block === ss[i].block) k--
          return k
        }
        // Back to the start of this paragraph, or to the previous one when already there.
        const here = nextPlayable(plan, blockStart(cur), cur)
        if (here >= 0 && here < cur) return get().seek(here)
        const p = prevPlayable(plan, blockStart(cur) - 1)
        if (p < 0) return get().seek(here >= 0 ? here : cur)
        get().seek(nextPlayable(plan, blockStart(p), p))
      })
    },

    setRate(rate) {
      guard(() => {
        const r = clampRate(rate)
        applyRate(r)
        if (getSettings().rate !== r) getSettings().set({ rate: r })
      })
    },

    setSleepTimer(minutes) {
      guard(() => {
        sleepTimer = clearTimer(sleepTimer)
        if (minutes == null || !(minutes > 0)) {
          set({ sleepAt: null })
          return
        }
        const ms = minutes * 60_000
        set({ sleepAt: Date.now() + ms })
        sleepTimer = setTimeout(() => {
          sleepTimer = null
          set({ sleepAt: null })
          get().pause()
        }, ms)
      })
    },

    setSleepAtChapterEnd(on) {
      guard(() => set({ sleepAtChapterEnd: !!on }))
    },

    refreshEngine() {
      guard(() => {
        // Called from clicks (voice picker, "Try again"): a newly chosen audio voice may need the unlock.
        unlockForEngine()
        refreshNow()
      })
    },

    speakText(text) {
      return new Promise<void>((resolve) => {
        try {
          const paragraphs = String(text ?? '')
            .split(/\n\s*\n/)
            .map(cleanText)
            .filter(Boolean)
          const sentences = segmentBlocks(paragraphs.map((t) => ({ type: 'paragraph' as const, text: t })))
          if (!sentences.length) return resolve()
          // Interrupt the document, remembering where it was.
          const s = get()
          const r = run
          if (r?.script.kind === 'doc') {
            resumeWord = r.kind === 'synth' ? undefined : s.word?.start
            cancelRun()
            if (s.status === 'playing' || s.status === 'loading') set({ status: 'paused', buffering: false })
          } else {
            cancelRun() // an earlier one-off text: it resolves as interrupted
          }
          unlockForEngine()
          set({ speakingText: true })
          startRun(
            textScript(sentences, () => {
              set({ speakingText: false })
              resolve()
            }),
            0,
          )
        } catch (e) {
          set({ speakingText: false })
          toast.error(friendlyError(e))
          resolve()
        }
      })
    },
  }
})

// ---------------------------------------------------------------------------
// Wiring: settings, OS media controls, external audio interruptions
// ---------------------------------------------------------------------------

const unsubscribeSettings = useSettings.subscribe((s, p) => {
  if (s.rate !== p.rate) applyRate(clampRate(s.rate))
  const wait = refreshDelay(s, p)
  if (wait != null) {
    refreshTimer = clearTimer(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      try {
        refreshNow() // not a user gesture: no audio unlock here
      } catch (e) {
        reportError(e)
      }
    }, wait)
  }
})

const disposeMediaSession = initMediaSession({
  play: () => usePlayer.getState().play(),
  pause: () => usePlayer.getState().pause(),
  stop: () => usePlayer.getState().pause(),
  previousTrack: () => usePlayer.getState().prevParagraph(),
  nextTrack: () => usePlayer.getState().nextParagraph(),
  seekBackward: () => usePlayer.getState().prev(),
  seekForward: () => usePlayer.getState().next(),
})

const unsubscribeMediaState = usePlayer.subscribe((s, p) => {
  if (s.status === p.status && s.speakingText === p.speakingText && s.docId === p.docId) return
  setMediaPlaybackState(s.speakingText || s.status === 'playing' ? 'playing' : s.docId ? 'paused' : 'none')
})

onExternalPause(() => {
  const r = run
  if (!r || r.paused) return
  if (r.script.kind === 'text') return cancelRun()
  r.paused = true
  patch({ status: 'paused', buffering: false })
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribeSettings()
    unsubscribeMediaState()
    disposeMediaSession()
    onExternalPause(null)
    cancelRun()
    stopClip()
    sleepTimer = clearTimer(sleepTimer)
    refreshTimer = clearTimer(refreshTimer)
  })
}
