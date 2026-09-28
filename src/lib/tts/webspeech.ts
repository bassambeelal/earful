// Browser voices via the Web Speech API (window.speechSynthesis).

import { getSettings } from '../settings'
import { abortError } from './http'
import { ENGINE_INFO } from './info'
import type { SpeakOptions, SpeechEngine, VoiceInfo } from './types'

const RECOMMENDED = /natural|neural|online|premium|enhanced|google/i

/** Roughly how many characters a voice speaks per second at 1x. */
const CHARS_PER_SECOND = 14

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
}

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const isAndroid = /Android/i.test(ua)
const isChromium = /Chrome\//.test(ua) && !/Edg\//.test(ua)

/** Wait up to ~1.5 s for the voice list: Chrome fills it asynchronously, Safari sometimes never fires the event. */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth()
  if (!s) return Promise.resolve([])
  const now = s.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      clearInterval(poll)
      s.removeEventListener('voiceschanged', done)
      resolve(s.getVoices())
    }
    const timeout = setTimeout(done, 1500)
    const poll = setInterval(() => {
      if (s.getVoices().length) done()
    }, 150)
    s.addEventListener('voiceschanged', done)
  })
}

const normLang = (lang: string | undefined) => (lang ?? '').replace('_', '-')
const baseLang = (lang: string | undefined) => normLang(lang).split('-')[0].toLowerCase()

function isRecommended(v: SpeechSynthesisVoice) {
  return RECOMMENDED.test(v.name)
}

function toVoiceInfo(v: SpeechSynthesisVoice): VoiceInfo {
  return {
    id: v.voiceURI || v.name,
    name: v.name,
    lang: normLang(v.lang) || undefined,
    local: v.localService,
    recommended: isRecommended(v),
    description: v.localService ? 'On this device' : 'Needs internet',
  }
}

/** Pick the voice for `id`, or the best voice for `lang` when id is missing or no longer installed. */
function pickVoice(voices: SpeechSynthesisVoice[], id: string | undefined, lang: string | undefined): SpeechSynthesisVoice | null {
  if (id) {
    const exact = voices.find((v) => v.voiceURI === id) ?? voices.find((v) => v.name === id)
    if (exact) return exact
  }
  const want = normLang(lang || (typeof navigator !== 'undefined' ? navigator.language : 'en')).toLowerCase()
  const base = baseLang(want)
  const score = (v: SpeechSynthesisVoice) => {
    const l = normLang(v.lang).toLowerCase()
    let s = 0
    if (l === want) s += 4
    else if (baseLang(l) === base) s += 3
    else return -1
    if (isRecommended(v)) s += 2
    if (v.default) s += 1
    return s
  }
  let best: SpeechSynthesisVoice | null = null
  let bestScore = -1
  for (const v of voices) {
    const s = score(v)
    if (s > bestScore) {
      best = v
      bestScore = s
    }
  }
  return best
}

/** Chrome's online Google voices ignore rates above 2. */
function maxRateFor(voice: SpeechSynthesisVoice | null | undefined): number {
  return voice && !voice.localService && /google/i.test(voice.name) ? 2 : 3
}

function friendlyError(code: string): string {
  switch (code) {
    case 'not-allowed':
      return 'The browser blocked speech until you interact with the page. Press play again.'
    case 'network':
      return 'This voice needs an internet connection. Pick a voice marked "On this device" to listen offline.'
    case 'audio-busy':
    case 'audio-hardware':
      return 'Your audio output is busy or unavailable. Check your speakers or headphones.'
    case 'language-unavailable':
    case 'voice-unavailable':
      return "This voice isn't available right now. Pick another voice."
    case 'text-too-long':
      return 'This passage is too long for the browser voice.'
    case 'invalid-argument':
      return 'The browser rejected the speech settings. Try another speed or voice.'
    default:
      return "The browser couldn't speak this text. Try another voice."
  }
}

/** Keeps utterances reachable until they finish: Chrome garbage-collects them mid-speech and drops their events otherwise. */
const live = new Set<SpeechSynthesisUtterance>()

/** Settles the utterance currently being spoken (so a new speak() supersedes it cleanly). */
let cancelActive: (() => void) | null = null

/** Call `cb` whenever the installed browser voices change. Returns an unsubscribe function. */
export function watchBrowserVoices(cb: () => void): () => void {
  const s = synth()
  if (!s) return () => {}
  s.addEventListener('voiceschanged', cb)
  return () => s.removeEventListener('voiceschanged', cb)
}

function speak(text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void> {
  const s = synth()
  if (!s) return Promise.reject(new Error(webSpeechEngine.notReadyReason() ?? 'Browser voices are unavailable.'))
  if (signal.aborted) return Promise.reject(abortError())
  // Always call speechSynthesis.speak() synchronously, before any await: iOS Safari (and
  // Chrome's first utterance) only allow speech started directly inside the user's tap.
  // If the voice list hasn't loaded yet, this sentence uses the default voice for the
  // language, and loading is kicked off so the next one gets the chosen voice.
  const voices = s.getVoices()
  if (!voices.length) void loadVoices()
  return start(s, voices, text, opts, signal)
}

function start(s: SpeechSynthesis, voices: SpeechSynthesisVoice[], text: string, opts: SpeakOptions, signal: AbortSignal): Promise<void> {
  cancelActive?.()
  if (s.speaking || s.pending) s.cancel()
  if (!text.trim()) {
    opts.onStart?.()
    return Promise.resolve()
  }

  const voice = pickVoice(voices, opts.voice, opts.lang)
  const u = new SpeechSynthesisUtterance(text)
  if (voice) {
    u.voice = voice
    u.lang = voice.lang
  } else if (opts.lang) {
    u.lang = opts.lang
  }
  const rate = Math.min(Math.max(opts.rate || 1, 0.1), maxRateFor(voice))
  u.rate = rate

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let started = false
    let retried = false
    const timers: ReturnType<typeof setTimeout>[] = []
    let keepAlive: ReturnType<typeof setInterval> | undefined

    const expected = Math.max(2, text.length / (CHARS_PER_SECOND * rate))

    const cleanup = () => {
      timers.forEach(clearTimeout)
      clearInterval(keepAlive)
      signal.removeEventListener('abort', onAbort)
      live.delete(u)
      if (cancelActive === supersede) cancelActive = null
    }
    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve()
    }
    const onAbort = () => {
      finish(abortError())
      s.cancel()
    }
    const supersede = () => finish(abortError())

    // Some engines never fire 'end'. Once the expected duration has clearly passed,
    // finish as soon as the synthesizer goes idle; give up entirely after a hard cap
    // (which waits while speech is paused, e.g. by the OS or another page).
    const armWatchdog = () => {
      timers.forEach(clearTimeout)
      timers.length = 0
      const check = () => {
        if (settled) return
        if (s.paused) {
          timers.push(setTimeout(check, 1000))
          return
        }
        if (!s.speaking && !s.pending) finish()
        else timers.push(setTimeout(check, 1000))
      }
      const cap = () => {
        if (settled) return
        if (s.paused) {
          timers.push(setTimeout(cap, 5000))
          return
        }
        finish()
        s.cancel()
      }
      timers.push(setTimeout(check, (expected * 1.5 + 3) * 1000))
      timers.push(setTimeout(cap, (expected * 4 + 15) * 1000))
    }

    u.onstart = () => {
      if (started || settled) return
      started = true
      armWatchdog()
      opts.onStart?.()
    }
    u.onboundary = (e) => {
      // Word boundaries only (Safari and Chrome also report 'sentence' boundaries).
      if (settled || (e.name && e.name !== 'word')) return
      opts.onBoundary?.(e.charIndex, e.charLength || undefined)
    }
    u.onend = () => finish()
    u.onerror = (e) => {
      if (settled) return
      if (signal.aborted) return finish(abortError())
      if (e.error === 'interrupted' || e.error === 'canceled') {
        // Chrome sometimes cancels an utterance queued right after cancel(): try it once more.
        if (!started && !retried) {
          retried = true
          timers.push(
            setTimeout(() => {
              if (!settled && !signal.aborted) s.speak(u)
            }, 250),
          )
          return
        }
        // Stopped by the OS or another page: an AbortError lets the player pause at this word.
        return finish(abortError('Speech was stopped by the browser.'))
      }
      if (e.error === 'not-allowed') {
        // Named like the autoplay error so the player pauses and waits for a tap instead of failing.
        return finish(new DOMException(friendlyError(e.error), 'NotAllowedError'))
      }
      finish(new Error(friendlyError(e.error)))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    cancelActive = supersede
    live.add(u)
    s.speak(u)
    if (s.paused) s.resume()
    armWatchdog()

    // Chrome occasionally drops an utterance queued right after cancel(): retry once.
    timers.push(
      setTimeout(() => {
        if (settled || started || retried || s.speaking || s.pending) return
        retried = true
        s.speak(u)
      }, 1500),
    )

    // Desktop Chrome stops online voices after ~15 s unless nudged.
    if (voice && !voice.localService && isChromium && !isAndroid) {
      keepAlive = setInterval(() => {
        if (s.speaking && !s.paused) {
          s.pause()
          s.resume()
        }
      }, 10_000)
    }
  })
}

export const webSpeechEngine: SpeechEngine = {
  info: ENGINE_INFO.browser,
  kind: 'speech',
  get maxRate() {
    const s = synth()
    if (!s) return 3
    const id = getSettings().voices.browser
    return maxRateFor(pickVoice(s.getVoices(), id, undefined))
  },
  isReady: () => synth() !== null,
  notReadyReason: () =>
    synth() ? null : "This browser doesn't have built-in speech. Try Natural voices (offline) instead.",
  async listVoices() {
    const voices = await loadVoices()
    const userBase = baseLang(typeof navigator !== 'undefined' ? navigator.language : 'en')
    return voices.map(toVoiceInfo).sort((a, b) => {
      const la = baseLang(a.lang) === userBase ? 0 : 1
      const lb = baseLang(b.lang) === userBase ? 0 : 1
      if (la !== lb) return la - lb
      if (!!a.recommended !== !!b.recommended) return a.recommended ? -1 : 1
      return (a.lang ?? '').localeCompare(b.lang ?? '') || a.name.localeCompare(b.name)
    })
  },
  speak,
}
