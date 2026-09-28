import { useMemo } from 'react'
import { chapterAt, scopedText, type AiScope, type ScopedText } from '../../lib/ai/tools'
import type { OpenDoc } from '../../lib/library'
import { countWords } from '../../lib/text'

/**
 * Text for a scope, recomputed only when the scope's range actually changes
 * (not on every sentence the player advances).
 */
export function useScopedText(doc: OpenDoc, scope: AiScope, currentSentence: number, selection: string | null | undefined): ScopedText & { words: number } {
  const rangeKey =
    scope === 'chapter'
      ? `c${chapterAt(doc, currentSentence)?.start ?? -1}`
      : scope === 'paragraph'
        ? `p${doc.sentences[currentSentence]?.block ?? 0}`
        : scope === 'selection'
          ? `s${selection ?? ''}`
          : 'd'
  // Keyed on content (stable) rather than doc, whose meta changes as the reading position is saved.
  // currentSentence and selection reach the memo through rangeKey.
  return useMemo(() => {
    const s = scopedText(doc, scope, currentSentence, selection)
    return { ...s, words: countWords(s.text) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.content, doc.sentences, scope, rangeKey])
}
