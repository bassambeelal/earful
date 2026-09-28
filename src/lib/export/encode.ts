// Streaming encoders for exported audio: mono 16-bit WAV, or MP3 via lamejs.
import { nextTask, throwIfAborted } from '../player/util'

export interface AudioSink {
  /** Append mono samples (-1..1) at the sink's sample rate. */
  write(samples: Float32Array, signal?: AbortSignal): Promise<void>
  finish(): Promise<Blob>
}

/** Keep each uninterrupted stretch of encoding work under this many ms. */
const SLICE_MS = 12

export function floatToInt16(samples: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    out[i] = s <= -1 ? -32768 : s >= 1 ? 32767 : Math.round(s * (s < 0 ? 32768 : 32767))
  }
  return out
}

/** 44-byte RIFF/WAVE header for 16-bit PCM. */
export function wavHeader(dataBytes: number, sampleRate: number, channels = 1): ArrayBuffer {
  const buf = new ArrayBuffer(44)
  const v = new DataView(buf)
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i))
  }
  const blockAlign = channels * 2
  text(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * blockAlign, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, 16, true)
  text(36, 'data')
  v.setUint32(40, dataBytes, true)
  return buf
}

export function createWavSink(sampleRate: number): AudioSink {
  const parts: Int16Array<ArrayBuffer>[] = []
  let bytes = 0
  return {
    async write(samples, signal) {
      throwIfAborted(signal)
      const pcm = floatToInt16(samples)
      parts.push(pcm)
      bytes += pcm.byteLength
    },
    async finish() {
      return new Blob([wavHeader(bytes, sampleRate), ...parts], { type: 'audio/wav' })
    },
  }
}

/** Mono MP3 at `kbps`. lamejs is loaded on first use; encoding yields to the UI regularly. */
export async function createMp3Sink(sampleRate: number, kbps: number): Promise<AudioSink> {
  const { Mp3Encoder } = await import('@breezystack/lamejs')
  const encoder = new Mp3Encoder(1, sampleRate, kbps)
  const parts: Uint8Array<ArrayBuffer>[] = []
  const BLOCK = 1152 * 8
  // lamejs returns fresh Int8Array copies (typed as Uint8Array): reinterpret the bytes.
  const keep = (out: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number }) => {
    if (out.byteLength) parts.push(new Uint8Array(out.buffer as ArrayBuffer, out.byteOffset, out.byteLength))
  }
  return {
    async write(samples, signal) {
      throwIfAborted(signal)
      const pcm = floatToInt16(samples)
      let sliceStart = performance.now()
      for (let i = 0; i < pcm.length; i += BLOCK) {
        keep(encoder.encodeBuffer(pcm.subarray(i, i + BLOCK)))
        if (performance.now() - sliceStart > SLICE_MS) {
          await nextTask()
          throwIfAborted(signal)
          sliceStart = performance.now()
        }
      }
    },
    async finish() {
      keep(encoder.flush())
      return new Blob(parts, { type: 'audio/mpeg' })
    },
  }
}
