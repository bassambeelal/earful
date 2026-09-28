// Pitch-preserving time stretch for exported speech (WSOLA: waveform-similarity overlap-add).
// Each output frame is taken from near its nominal input position, shifted by up to ±8 ms so
// its waveform lines up with the natural continuation of the previous frame. That keeps pitch
// and avoids the phasiness of plain overlap-add. Good quality for speech at 0.5x–4x.
import { nextTask, throwIfAborted } from '../player/util'

const WINDOW_SEC = 0.032
const TOLERANCE_SEC = 0.008
const SLICE_MS = 12

/** Returns `input` sped up by `rate` (>1 faster, <1 slower) without changing pitch. */
export async function timeStretch(input: Float32Array, sampleRate: number, rate: number, signal?: AbortSignal): Promise<Float32Array> {
  if (!(rate > 0) || Math.abs(rate - 1) < 0.01 || input.length === 0) return input
  const N = 2 * Math.round((sampleRate * WINDOW_SEC) / 2)
  const hopOut = N / 2
  const hopIn = hopOut * rate
  const tol = Math.round(sampleRate * TOLERANCE_SEC)
  const outLen = Math.max(1, Math.round(input.length / rate))

  // Zero padding so every read below stays in bounds.
  const padStart = tol + 1
  const padEnd = 2 * N + 2 * tol + 2 * Math.ceil(hopIn)
  const x = new Float32Array(padStart + input.length + padEnd)
  x.set(input, padStart)

  const win = new Float32Array(N)
  for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N)

  const y = new Float32Array(outLen + N)
  const weight = new Float32Array(outLen + N)
  let delta = 0
  let sliceStart = performance.now()
  for (let k = 0; k * hopOut < outLen; k++) {
    const pos = padStart + Math.round(k * hopIn) + delta
    const at = k * hopOut
    for (let n = 0; n < N; n++) {
      y[at + n] += x[pos + n] * win[n]
      weight[at + n] += win[n]
    }
    delta = bestLag(x, pos + hopOut, padStart + Math.round((k + 1) * hopIn), N, tol)
    if (performance.now() - sliceStart > SLICE_MS) {
      await nextTask()
      throwIfAborted(signal)
      sliceStart = performance.now()
    }
  }

  // Only the first frame covers the first half-window, and it starts exactly at the input.
  const out = new Float32Array(outLen)
  const head = Math.min(hopOut, outLen, input.length)
  out.set(input.subarray(0, head))
  for (let i = head; i < outLen; i++) out[i] = weight[i] > 1e-6 ? y[i] / weight[i] : 0
  return out
}

/**
 * Offset in [-tol, tol] around `nominal` whose frame best matches the frame at `natural`
 * (cross-correlation): a coarse search on a decimated grid, then a fine one around the winner.
 */
function bestLag(x: Float32Array, natural: number, nominal: number, N: number, tol: number): number {
  const score = (d: number, step: number) => {
    const c = nominal + d
    let s = 0
    for (let n = 0; n < N; n += step) s += x[natural + n] * x[c + n]
    return s
  }
  let best = 0
  let bestScore = score(0, 4)
  for (let d = -tol; d <= tol; d += 2) {
    const s = score(d, 4)
    if (s > bestScore) {
      bestScore = s
      best = d
    }
  }
  let refined = best
  bestScore = score(best, 1)
  for (let d = Math.max(-tol, best - 2); d <= Math.min(tol, best + 2); d++) {
    const s = score(d, 1)
    if (s > bestScore) {
      bestScore = s
      refined = d
    }
  }
  return refined
}
