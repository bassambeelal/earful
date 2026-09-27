// CONTRACT STUB — replaced by the player module implementation.
// The playback controller: turns sentences into speech with the selected engine,
// tracks the current sentence/word for highlighting, and exposes a zustand store.
import type { UseBoundStore, StoreApi } from 'zustand'
import type { Sentence, WordSpan } from '../text'

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

export declare const usePlayer: UseBoundStore<StoreApi<PlayerState>>
