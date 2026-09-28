import type { CSSProperties } from 'react'
import { BookOpen, ClipboardType, FileText, Globe, Image, Sparkles } from 'lucide-react'
import type { DocMeta, SourceKind } from '../../types'
import { cx, progressOf } from '../../lib/ui-format'

export function SourceIcon({ source, className }: { source: SourceKind; className?: string }) {
  const props = { className, 'aria-hidden': true as const }
  switch (source) {
    case 'epub':
      return <BookOpen {...props} />
    case 'image':
      return <Image {...props} />
    case 'paste':
      return <ClipboardType {...props} />
    case 'html':
      return <Globe {...props} />
    case 'sample':
    case 'ai':
      return <Sparkles {...props} />
    default:
      return <FileText {...props} />
  }
}

/** First letter or digit of the title. */
function initialOf(title: string): string {
  const m = /[\p{L}\p{N}]/u.exec(title)
  return m ? m[0].toUpperCase() : '·'
}

/** Generated book cover: gradient from the doc's hue, a big initial, the source icon and progress. */
export function Cover({ meta, size = 'md', showProgress = true }: { meta: DocMeta; size?: 'sm' | 'md'; showProgress?: boolean }) {
  const p = progressOf(meta)
  return (
    <div className={cx('cover', `cover--${size}`)} style={{ '--h': meta.hue } as CSSProperties} aria-hidden>
      <span className="cover__initial">{initialOf(meta.title)}</span>
      <span className="cover__title">{meta.title}</span>
      <span className="cover__source">
        <SourceIcon source={meta.source} />
      </span>
      {showProgress && p > 0 && (
        <span className="cover__progress">
          <span style={{ width: `${Math.max(3, p * 100)}%` }} />
        </span>
      )}
    </div>
  )
}
