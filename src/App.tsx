import { useEffect } from 'react'
import { Toaster } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { DropOverlay } from './components/DropOverlay'
import { GlobalDialogs } from './components/GlobalDialogs'
import { LibraryView } from './components/library/LibraryView'
import { ReaderView } from './components/reader/ReaderView'
import { useLibrary } from './lib/library'
import { usePlayer } from './lib/player'
import { useRoute } from './lib/router'
import { getSettings } from './lib/settings'
import { useShortcuts } from './lib/shortcuts'
import { useThemeSync } from './lib/theme'
import { loadKokoro } from './lib/tts/kokoro'
import { runStartup } from './lib/ui-import'
import { useUi } from './lib/ui-store'

export default function App() {
  useThemeSync()
  const route = useRoute()

  useEffect(() => {
    void runStartup()
    if (getSettings().kokoro.autoload) loadKokoro().catch(() => {})
  }, [])

  // Remember the reading position wherever playback happens (reader or mini player).
  useEffect(
    () =>
      usePlayer.subscribe((s, prev) => {
        if (s.docId && s.docId === prev.docId && s.sentence !== prev.sentence) useLibrary.getState().savePosition(s.docId, s.sentence)
      }),
    [],
  )

  useShortcuts({
    onSearch:
      route.name === 'library'
        ? () => {
            const el = document.getElementById('library-search') as HTMLInputElement | null
            el?.focus()
            el?.select()
          }
        : undefined,
    onHelp: () => useUi.getState().setShortcuts(true),
    onEscape: () => {
      const ui = useUi.getState()
      if (ui.ai.open) {
        ui.closeAi()
        return true
      }
      return false
    },
  })

  return (
    <>
      <ErrorBoundary>
        {route.name === 'read' ? <ReaderView key={route.id} id={route.id} /> : <LibraryView />}
        <GlobalDialogs />
        <DropOverlay />
      </ErrorBoundary>
      <Toaster />
    </>
  )
}
