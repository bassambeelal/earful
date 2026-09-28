// The playback controller: turns sentences into speech with the selected engine,
// tracks the current sentence/word for highlighting, and exposes a zustand store.
export { usePlayer } from './controller'
export type { PlayerState, PlayerStatus } from './controller'
