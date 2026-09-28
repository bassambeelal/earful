// The single long-lived <audio> element that plays synthesized clips.
// One element (rather than one per clip) is what lets iOS/Safari keep playing after the
// first user gesture, and what the OS media controls attach to.
import { abortError, isAbortError } from './util'

/** 10 ms of silence (8 kHz, 16-bit mono WAV), played once inside a user gesture to unlock audio on iOS. */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

type PitchAwareAudio = HTMLAudioElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean }

let el: HTMLAudioElement | null = null
let clipUrl: string | null = null
/** A playClip() promise is pending (a clip is loaded, playing or paused). */
let clipActive = false
/** The src just changed: ignore 'pause' events until the new clip is actually playing. */
let starting = false
/** We called pause() ourselves; the next 'pause' event is expected. */
let selfPaused = false
let externalPauseHandler: (() => void) | null = null

export function audioElement(): HTMLAudioElement {
  if (el) return el
  const a = new Audio() as PitchAwareAudio
  a.preload = 'auto'
  a.preservesPitch = true
  a.webkitPreservesPitch = true
  a.mozPreservesPitch = true
  a.addEventListener('playing', () => {
    starting = false
  })
  a.addEventListener('pause', () => {
    const expected = selfPaused || starting || !clipActive || a.ended
    selfPaused = false
    // Paused by something else: a phone call, headphones unplugged, OS controls...
    if (!expected) externalPauseHandler?.()
  })
  el = a
  return a
}

/** Called when the OS or browser pauses a playing clip behind our back. */
export function onExternalPause(handler: (() => void) | null): void {
  externalPauseHandler = handler
}

let unlocked = false

/**
 * Must be called synchronously inside a user gesture (before any await) the first time
 * we might play audio. Plays a tiny silent clip so later programmatic play() calls are allowed.
 */
export function unlockAudio(): void {
  if (unlocked || clipActive) return
  // Outside a gesture this would only fail (and could hide the next real gesture): wait for one.
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  if (activation && !activation.isActive) return
  unlocked = true
  try {
    const a = audioElement()
    a.src = SILENT_WAV
    a.play()?.catch((e: unknown) => {
      if ((e as { name?: string })?.name === 'NotAllowedError') unlocked = false
    })
  } catch {
    unlocked = false
  }
}

function releaseUrl() {
  if (clipUrl) {
    URL.revokeObjectURL(clipUrl)
    clipUrl = null
  }
}

/** 4 = MEDIA_ERR_SRC_NOT_SUPPORTED */
function mediaErrorMessage(code: number | undefined): string {
  if (code === 4) return 'This voice returned audio your browser can’t play. Try another voice.'
  return 'The audio couldn’t be played. Please try again.'
}

/**
 * Play `blob` from the start at `rate` (pitch preserved). Resolves when it ends, rejects on a
 * playback error (NotAllowedError if the browser blocked autoplay) or an AbortError when `signal` aborts.
 * Pausing (pauseClip) leaves the promise pending until the clip is resumed and finishes.
 */
export function playClip(blob: Blob, rate: number, signal: AbortSignal): Promise<void> {
  const a = audioElement()
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    releaseUrl()
    clipUrl = URL.createObjectURL(blob)
    clipActive = true
    starting = true
    a.src = clipUrl
    a.defaultPlaybackRate = rate
    a.playbackRate = rate

    const cleanup = () => {
      clipActive = false
      a.removeEventListener('ended', onEnded)
      a.removeEventListener('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onEnded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(mediaErrorMessage(a.error?.code)))
    }
    const onAbort = () => {
      cleanup()
      a.pause()
      releaseUrl()
      reject(abortError())
    }
    a.addEventListener('ended', onEnded)
    a.addEventListener('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    a.play()?.catch((e: unknown) => {
      // Interrupted by pause() or a newer clip: not an error, the owner decides what happens next.
      if (isAbortError(e) || !clipActive || a.src !== clipUrl) return
      cleanup()
      // NotAllowedError (autoplay blocked) is passed on as is: the player turns it into a pause.
      reject((e as { name?: string })?.name === 'NotSupportedError' ? new Error(mediaErrorMessage(4)) : e)
    })
  })
}

/** True while a clip is loaded (playing or paused mid-way). */
export function hasActiveClip(): boolean {
  return clipActive
}

export function pauseClip(): void {
  if (!el || !clipActive) return
  if (!el.paused) selfPaused = true
  el.pause()
}

/** Resume a paused clip. Must run inside a user gesture on iOS. */
export function resumeClip(): Promise<void> {
  if (!el || !clipActive) return Promise.resolve()
  return el.play()
}

/** Change speed of the current (and following) clips immediately. */
export function setClipRate(rate: number): void {
  if (!el) return
  el.defaultPlaybackRate = rate
  el.playbackRate = rate
}

/** Stop and release whatever is loaded. */
export function stopClip(): void {
  if (!el) return
  if (!el.paused) selfPaused = true
  el.pause()
  releaseUrl()
}
