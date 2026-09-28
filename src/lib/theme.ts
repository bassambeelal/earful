import { useEffect } from 'react'
import { getSettings, resolvedTheme, useSettings, type Theme } from './settings'

// Applies the chosen theme to <html data-theme> and keeps <meta name="theme-color"> in sync.

const FALLBACK_BG = { light: '#fbfaf8', dark: '#121117', sepia: '#f4ecd8' } as const

export function applyTheme(theme: Theme = getSettings().display.theme) {
  const root = document.documentElement
  const resolved = resolvedTheme(theme)
  root.dataset.theme = resolved
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim() || FALLBACK_BG[resolved]
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'theme-color'
    document.head.appendChild(meta)
  }
  meta.content = bg
}

/** React hook: re-applies on setting changes and, for "system", on OS light/dark changes. */
export function useThemeSync() {
  const theme = useSettings((s) => s.display.theme)
  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
}
