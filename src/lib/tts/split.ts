// Dependency-free text splitting, shared by the cloud engines and the Kokoro worker
// (which must not import settings or other main-thread modules).

/**
 * Split text into pieces of at most `limit` characters, preferring sentence
 * ends, then commas/semicolons, then spaces. Used for providers with small input limits.
 */
export function splitText(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const head = rest.slice(0, limit + 1)
    let cut = -1
    for (const re of [/[.!?…]["')\]”’]?\s/g, /[,;:—–]\s/g, /\s/g]) {
      let m: RegExpExecArray | null
      while ((m = re.exec(head))) {
        const end = m.index + m[0].length - 1
        if (end > limit * 0.3 && end <= limit) cut = end
      }
      if (cut > 0) break
    }
    if (cut <= 0) {
      cut = limit
      // Don't split an emoji or other surrogate pair in half.
      const code = rest.charCodeAt(cut - 1)
      if (code >= 0xd800 && code <= 0xdbff) cut--
    }
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) out.push(rest)
  return out
}
