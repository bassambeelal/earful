import { create } from 'zustand'
import type { AiTool } from '../components/ai/AiPanel'

// Which dialogs/panels are open. Lets any component open Settings on a given tab/section,
// the voice picker, the AI panel, etc. without prop drilling.

export type SettingsTab = 'voices' | 'ai' | 'reading' | 'appearance' | 'data' | 'about'

interface UiState {
  settings: { open: boolean; tab: SettingsTab; section: string | null }
  paste: boolean
  shortcuts: boolean
  voicePicker: boolean
  exportDocId: string | null
  renameDocId: string | null
  deleteDocId: string | null
  /** AI side panel. `nonce` changes when it is reopened with a new tool/selection so it remounts. */
  ai: { open: boolean; tool: AiTool | undefined; selection: string | null; nonce: number }
  /** Start playing as soon as this document opens in the reader. */
  autoplayDocId: string | null

  openSettings(tab?: SettingsTab, section?: string | null): void
  closeSettings(): void
  setPaste(open: boolean): void
  setShortcuts(open: boolean): void
  setVoicePicker(open: boolean): void
  setExportDoc(id: string | null): void
  setRenameDoc(id: string | null): void
  setDeleteDoc(id: string | null): void
  openAi(tool?: AiTool, selection?: string | null): void
  closeAi(): void
  toggleAi(): void
  setAutoplay(id: string | null): void
}

export const useUi = create<UiState>()((set, get) => ({
  settings: { open: false, tab: 'voices', section: null },
  paste: false,
  shortcuts: false,
  voicePicker: false,
  exportDocId: null,
  renameDocId: null,
  deleteDocId: null,
  ai: { open: false, tool: undefined, selection: null, nonce: 0 },
  autoplayDocId: null,

  openSettings: (tab, section = null) =>
    set((s) => ({ settings: { open: true, tab: tab ?? s.settings.tab, section }, voicePicker: false })),
  closeSettings: () => set((s) => ({ settings: { ...s.settings, open: false, section: null } })),
  setPaste: (paste) => set({ paste }),
  setShortcuts: (shortcuts) => set({ shortcuts }),
  setVoicePicker: (voicePicker) => set({ voicePicker }),
  setExportDoc: (exportDocId) => set({ exportDocId }),
  setRenameDoc: (renameDocId) => set({ renameDocId }),
  setDeleteDoc: (deleteDocId) => set({ deleteDocId }),
  openAi: (tool, selection = null) =>
    set((s) => ({
      ai: {
        open: true,
        tool: tool ?? s.ai.tool,
        selection,
        // Remount only when asked for something specific, so an open chat isn't thrown away.
        nonce: tool || selection ? s.ai.nonce + 1 : s.ai.nonce,
      },
    })),
  closeAi: () => set((s) => ({ ai: { ...s.ai, open: false } })),
  toggleAi: () => (get().ai.open ? get().closeAi() : get().openAi()),
  setAutoplay: (autoplayDocId) => set({ autoplayDocId }),
}))

/** True while any modal dialog is open (shortcuts and drag-and-drop stand down). */
export function modalOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-modal="true"]')
}
