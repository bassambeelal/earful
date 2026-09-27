// CONTRACT STUB — replaced by the TTS module implementation.
// Kokoro-82M local neural voices, running in a Web Worker via kokoro-js.
import type { UseBoundStore, StoreApi } from 'zustand'
import type { KokoroStatus } from './types'

/** Reactive status of the local model (download progress, ready, error). */
export declare const useKokoroStatus: UseBoundStore<StoreApi<KokoroStatus>>

/** Download (first time, cached afterwards) and initialise the model. Safe to call repeatedly. */
export declare function loadKokoro(): Promise<void>

/** Terminate the worker and free memory (model stays cached on disk). */
export declare function unloadKokoro(): void

/** Remove the cached model files from Cache Storage. */
export declare function deleteKokoroCache(): Promise<void>

/** Approximate download size in MB for the dtype that would be used on this device. */
export declare function kokoroDownloadSizeMB(): number
