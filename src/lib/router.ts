import { useMemo, useSyncExternalStore } from 'react'

// Tiny hash router: '#/' is the library, '#/read/<id>' is the reader.
// Hash routing keeps GitHub Pages happy (no server rewrites) and the back button works.

export type Route = { name: 'library' } | { name: 'read'; id: string }

export function parseHash(hash: string): Route {
  const m = /^#\/read\/([^/?#]+)/.exec(hash)
  if (m) {
    try {
      return { name: 'read', id: decodeURIComponent(m[1]) }
    } catch {
      return { name: 'library' }
    }
  }
  return { name: 'library' }
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

const getHash = () => window.location.hash

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '')
  return useMemo(() => parseHash(hash), [hash])
}

export function currentRoute(): Route {
  return parseHash(window.location.hash)
}

/** True when the reader was opened from the library, so "back" can pop history instead of pushing. */
let openedFromLibrary = false

export function openReader(id: string) {
  openedFromLibrary = currentRoute().name === 'library'
  window.location.hash = `#/read/${encodeURIComponent(id)}`
}

/** Replace the current entry (no new history item) and notify listeners. */
export function replaceRoute(hash: string) {
  const url = `${window.location.pathname}${window.location.search}${hash}`
  window.history.replaceState(window.history.state, '', url)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function goLibrary() {
  if (openedFromLibrary && currentRoute().name === 'read') {
    openedFromLibrary = false
    window.history.back()
  } else {
    replaceRoute('#/')
  }
}
