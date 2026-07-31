export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  return width && height ? `${width} × ${height}` : '—'
}

// Resolution classes by their *long* side, so a phone video shot at 1080×1920
// reads as 1080p rather than as something between 720p and 4K. Ordered high to
// low; the nearest match within tolerance wins.
const RESOLUTION_CLASSES: Array<[number, string]> = [
  [7680, '8K'],
  [3840, '4K'],
  [2560, '2K'],
  [1920, '1080p'],
  [1280, '720p'],
  [854, '480p'],
  [640, '360p'],
]
// How far from a standard a source may sit and still claim its name. Wide
// enough for the real variants — DCI 4K's 4096, a 1920×800 scope crop — and
// narrow enough that an arbitrary size (a 1000×1000 render) declines to be
// labelled at all and prints its true dimensions instead.
const RESOLUTION_TOLERANCE = 0.1

/**
 * A resolution as the name people use for it, or `null` when it has no name.
 *
 * Returning `null` rather than a nearest-guess matters: the compact rows this
 * feeds fall back to printing real dimensions, and a wrong shorthand is worse
 * than an honest `1000 × 1000`.
 */
export function resolutionClass(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  if (!width || !height || width <= 0 || height <= 0) return null
  const long = Math.max(width, height)
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [standard, name] of RESOLUTION_CLASSES) {
    const distance = Math.abs(long - standard) / standard
    if (distance <= RESOLUTION_TOLERANCE && distance < bestDistance) {
      best = name
      bestDistance = distance
    }
  }
  return best
}

/** The resolution class where one exists, else the exact dimensions. */
export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  return resolutionClass(width, height) ?? formatDimensions(width, height)
}

// Codec names as the formats people recognize, rather than as ffmpeg spells
// them internally. Anything unlisted is upper-cased, which is right far more
// often than it is wrong for a codec name.
const CODEC_NAMES: Record<string, string> = {
  h264: 'H.264',
  avc: 'H.264',
  avc1: 'H.264',
  hevc: 'HEVC',
  h265: 'HEVC',
  hvc1: 'HEVC',
  hev1: 'HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  dts: 'DTS',
  truehd: 'Dolby TrueHD',
  pcm_s16le: 'PCM',
  alac: 'ALAC',
}

/** A codec as a format name — `hevc` → `HEVC`, `ac3` → `Dolby Digital`. */
export function formatCodec(codec: string | null | undefined): string {
  if (!codec) return '—'
  const key = codec.trim().toLowerCase()
  if (!key) return '—'
  return CODEC_NAMES[key] ?? key.toUpperCase()
}

/** Stream bitrate in the units people quote them in — `15.9 Mbps`. */
export function formatBitrate(bitsPerSecond: number | null | undefined): string {
  if (!bitsPerSecond || bitsPerSecond <= 0) return '—'
  // Decimal megabits, not mebibits: bitrates are quoted in powers of ten
  // everywhere they are quoted at all, unlike file sizes above.
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
  if (bitsPerSecond >= 1_000) return `${Math.round(bitsPerSecond / 1_000)} kbps`
  return `${Math.round(bitsPerSecond)} bps`
}

/** Audio sampling frequency in its conventional compact unit. */
export function formatSampleRate(hertz: number | null | undefined): string {
  if (!hertz || hertz <= 0) return '—'
  if (hertz >= 1_000) {
    const kilohertz = hertz / 1_000
    return `${Number.isInteger(kilohertz) ? kilohertz : kilohertz.toFixed(1)} kHz`
  }
  return `${Math.round(hertz)} Hz`
}

/** HDR signalling as a badge — `hdr10` → `HDR10`, `dv` → `Dolby Vision`. */
export function formatHdr(hdr: string | null | undefined): string | null {
  if (!hdr) return null
  const key = hdr.trim().toLowerCase()
  if (key === 'dv') return 'Dolby Vision'
  if (key === 'hdr10') return 'HDR10'
  if (key === 'hlg') return 'HLG'
  return key ? key.toUpperCase() : null
}

/**
 * The video stream in one line: codec, then the qualifiers that change how it
 * looks or whether it plays. Bit depth and HDR are only worth printing when
 * they are not the ordinary case, so 8-bit SDR stays silent and 10-bit HDR does
 * not — the line says something when there is something to say.
 */
export function formatVideoEncoding(
  codec: string | null | undefined,
  options: { bitDepth?: number | null; hdr?: string | null; fps?: number | null } = {},
): string {
  if (!codec) return '—'
  const parts = [formatCodec(codec)]
  if (options.bitDepth && options.bitDepth > 8) parts.push(`${options.bitDepth}-bit`)
  const hdr = formatHdr(options.hdr)
  if (hdr) parts.push(hdr)
  if (options.fps) parts.push(`${Math.round(options.fps * 100) / 100} fps`)
  return parts.join(' · ')
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString()
}

/** Date *and* time (down to the minute) — used where a precise timestamp matters
 * (e.g. the File inspector's Date Added / Date Modified rows). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}

/**
 * What a file *is*, for the one line under its name.
 *
 * The container format, not the media kind. "video" is a category the user can
 * already see from the thumbnail; "MP4" versus "MKV" is the fact that decides
 * whether something plays directly, and it is the word people use for a file's
 * type everywhere else (owner, 2026-07-28). The media kind survives as the
 * fallback for a file with no usable extension, where it is the only thing left
 * to say.
 *
 * Never the in-bundle role: the scanner assigns roles by guessing intent from
 * filenames — the first image becomes `cover`, a second video becomes
 * `alternate_version` — and those guesses are neither reliable nor changeable.
 * Showing a guess as a label invited it to be read as a fact. Which file is the
 * cover stays where it is unambiguous: the starred row.
 */
export function formatFileType(mediaKind: string, filename: string): string {
  const dot = filename.lastIndexOf('.')
  const ext = dot > 0 ? filename.slice(dot + 1) : ''
  // Upper-case reads as a format name ("MP4") rather than a path fragment. The
  // length bound keeps a dot in the middle of a name from becoming the type.
  if (ext.length > 0 && ext.length <= 5) return ext.toUpperCase()
  return mediaKind !== 'other' ? mediaKind : 'file'
}

/**
 * A file's *role* within its bundle, as distinct from its format above.
 *
 * The bundle inspector's rows lead with this, not the container format: the row
 * answers "what is this file to the bundle" — the video, an audio track, a
 * subtitle — and is slated to become a dropdown for manually assigned roles
 * (owner, 2026-07-28), which a format label could never be. Today the media
 * kind stands in for the role; the extension appears only for files the
 * classifier has no kind for, where it is the only thing worth saying.
 */
export function formatFileRole(mediaKind: string, filename: string): string {
  if (mediaKind !== 'other') return mediaKind
  const dot = filename.lastIndexOf('.')
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
  return ext.length > 0 && ext.length <= 5 ? ext : 'file'
}
