import DOMPurify from 'dompurify'
import { Marked } from 'marked'

// Model output is untrusted (a document can contain prompt injections), so it is
// always sanitised. Images are dropped so answers can't trigger requests to other hosts.
const md = new Marked({ gfm: true, breaks: false })
const purifier = DOMPurify(window)
purifier.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.target = '_blank'
    node.rel = 'noopener noreferrer'
  }
})

export function renderMarkdown(src: string): string {
  const html = md.parse(src, { async: false })
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'form', 'input', 'button', 'style', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  })
}
