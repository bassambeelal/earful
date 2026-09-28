// Lock-screen / notification / hardware media key integration (Media Session API).

export interface MediaHandlers {
  play(): void
  pause(): void
  stop(): void
  previousTrack(): void
  nextTrack(): void
  seekBackward(): void
  seekForward(): void
}

const supported = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator

/** Register action handlers. Returns a function that removes them. */
export function initMediaSession(h: MediaHandlers): () => void {
  if (!supported()) return () => {}
  const actions: Array<[MediaSessionAction, () => void]> = [
    ['play', h.play],
    ['pause', h.pause],
    ['stop', h.stop],
    ['previoustrack', h.previousTrack],
    ['nexttrack', h.nextTrack],
    ['seekbackward', h.seekBackward],
    ['seekforward', h.seekForward],
  ]
  for (const [action, fn] of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, () => fn())
    } catch {
      /* action not supported by this browser */
    }
  }
  return () => {
    for (const [action] of actions) {
      try {
        navigator.mediaSession.setActionHandler(action, null)
      } catch {
        /* ignore */
      }
    }
  }
}

export function setMediaMetadata(title: string | null): void {
  if (!supported()) return
  try {
    navigator.mediaSession.metadata =
      title == null
        ? null
        : new MediaMetadata({
            title: title || 'Untitled',
            artist: 'Earful',
            artwork: [{ src: import.meta.env.BASE_URL + 'pwa-512x512.png', sizes: '512x512', type: 'image/png' }],
          })
  } catch {
    /* MediaMetadata unavailable */
  }
}

export function setMediaPlaybackState(state: MediaSessionPlaybackState): void {
  if (!supported()) return
  try {
    navigator.mediaSession.playbackState = state
  } catch {
    /* ignore */
  }
}
