import { create } from 'zustand'

// Captures the browser's install prompt so the library header can offer an "Install" button.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

interface InstallState {
  /** Deferred prompt, present only while the app is installable and not installed. */
  event: BeforeInstallPromptEvent | null
  installed: boolean
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export const useInstall = create<InstallState>(() => ({ event: null, installed: isStandalone() }))

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    useInstall.setState({ event: e as BeforeInstallPromptEvent })
  })
  window.addEventListener('appinstalled', () => useInstall.setState({ event: null, installed: true }))
}

/** Show the native install prompt. Resolves true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const ev = useInstall.getState().event
  if (!ev) return false
  try {
    await ev.prompt()
    const choice = await ev.userChoice
    useInstall.setState({ event: null, installed: choice.outcome === 'accepted' })
    return choice.outcome === 'accepted'
  } catch {
    useInstall.setState({ event: null })
    return false
  }
}
