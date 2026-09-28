import { chapterAt, markdownToSpeech, type AiScope } from '../../lib/ai/tools'
import type { OpenDoc } from '../../lib/library'
import { usePlayer } from '../../lib/player'
import { toast } from '../ui'

/** Speak an AI answer with the current voice (Markdown stripped). */
export async function readAloud(text: string) {
  const spoken = markdownToSpeech(text)
  if (!spoken.trim()) return
  try {
    await usePlayer.getState().speakText(spoken)
  } catch (e) {
    toast.error(e instanceof Error && e.message ? e.message : 'Couldn’t read this aloud.')
  }
}

/** Scopes that make sense for this document right now, in display order. */
export function availableScopes(doc: OpenDoc, currentSentence: number, selection: string | null | undefined): AiScope[] {
  const out: AiScope[] = []
  const ch = chapterAt(doc, currentSentence)
  if (ch && doc.content.chapters.length > 1) out.push('chapter')
  out.push('document')
  if (selection?.trim()) out.push('selection')
  return out
}

/** Keep a chosen scope valid as chapters/selection come and go. */
export function effectiveScope(chosen: AiScope, options: AiScope[]): AiScope {
  if (options.includes(chosen)) return chosen
  return options.includes('chapter') ? 'chapter' : 'document'
}
