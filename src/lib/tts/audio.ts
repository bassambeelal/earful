// Small, dependency-free audio helpers shared by the TTS engines and the exporter.
// All WAV output is 16-bit little-endian PCM.

export interface WavInfo {
  /** 1 = integer PCM, 3 = IEEE float. */
  format: number
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Byte offset of the PCM samples inside the file. */
  dataOffset: number
  /** Length in bytes of the PCM samples. */
  dataLength: number
}

function writeHeader(view: DataView, dataLength: number, sampleRate: number, channels: number, bitsPerSample = 16, format = 1) {
  const blockAlign = channels * (bitsPerSample / 8)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, dataLength, true)
}

/**
 * Encode mono float samples (-1..1) as a 16-bit PCM WAV Blob.
 * Pass an array to join several consecutive mono segments into one file.
 */
export function encodeWav(samples: Float32Array | Float32Array[], sampleRate: number): Blob {
  const parts = Array.isArray(samples) ? samples : [samples]
  const count = parts.reduce((n, p) => n + p.length, 0)
  const buffer = new ArrayBuffer(44 + count * 2)
  const view = new DataView(buffer)
  writeHeader(view, count * 2, sampleRate, 1)
  let offset = 44
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const s = part[i]
      // NaN-safe clamp: NaN fails both comparisons and becomes silence.
      const v = s > 1 ? 1 : s < -1 ? -1 : s === s ? s : 0
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Wrap raw signed 16-bit little-endian PCM bytes in a WAV container. */
export function pcm16ToWav(bytes: Uint8Array, sampleRate: number, channels = 1): Blob {
  const length = bytes.length - (bytes.length % (channels * 2))
  const out = new Uint8Array(44 + length)
  writeHeader(new DataView(out.buffer), length, sampleRate, channels)
  out.set(bytes.subarray(0, length), 44)
  return new Blob([out], { type: 'audio/wav' })
}

/** Decode a base64 string (standard or URL-safe alphabet) into bytes. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** True if the bytes start with a RIFF/WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 // WAVE
  )
}

/**
 * Parse a PCM WAV header. Tolerates streaming-style headers whose data size is
 * 0 or 0xFFFFFFFF by using the remaining bytes. Returns null if not a PCM WAV.
 */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (!isWav(bytes)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (!fmt) return null
      const remaining = bytes.length - body
      const dataLength = size === 0 || size > remaining ? remaining : size
      return { ...fmt, dataOffset: body, dataLength }
    }
    offset = body + size + (size % 2)
  }
  return null
}

/** Duration in seconds of a PCM WAV file, or undefined if it can't be parsed. */
export function wavDuration(bytes: Uint8Array): number | undefined {
  const info = parseWav(bytes)
  if (!info || !info.sampleRate || !info.channels || !info.bitsPerSample) return undefined
  return info.dataLength / (info.sampleRate * info.channels * (info.bitsPerSample / 8))
}

/**
 * Join several WAV files that share one format into a single WAV.
 * Returns null if any part is not a WAV or the formats differ.
 */
export function concatWav(parts: Uint8Array[]): Blob | null {
  const infos = parts.map(parseWav)
  const first = infos[0]
  if (!first) return null
  const same = (i: WavInfo | null): i is WavInfo =>
    !!i && i.format === first.format && i.sampleRate === first.sampleRate && i.channels === first.channels && i.bitsPerSample === first.bitsPerSample
  if (!infos.every(same)) return null
  const total = infos.reduce((n, i) => n + (i as WavInfo).dataLength, 0)
  const out = new Uint8Array(44 + total)
  writeHeader(new DataView(out.buffer), total, first.sampleRate, first.channels, first.bitsPerSample, first.format)
  let offset = 44
  parts.forEach((bytes, idx) => {
    const info = infos[idx] as WavInfo
    out.set(bytes.subarray(info.dataOffset, info.dataOffset + info.dataLength), offset)
    offset += info.dataLength
  })
  return new Blob([out], { type: 'audio/wav' })
}
