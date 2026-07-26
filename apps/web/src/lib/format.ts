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
 * Deliberately the media kind, not the in-bundle role. The scanner assigns roles
 * by guessing intent from filenames — the first image becomes `cover`, a second
 * video becomes `alternate_version` — and those guesses are neither reliable nor
 * changeable: reordering files does not reassign them, and nothing in the UI
 * sets them. Showing a guess as a label invited it to be read as a fact about
 * the file. The media kind is simply true. Which file is the cover stays where
 * it is unambiguous: the starred row.
 *
 * `other` covers everything the server does not classify, so the extension is
 * more informative than the word "other" — a PDF says "pdf".
 */
export function formatFileType(mediaKind: string, filename: string): string {
  if (mediaKind !== 'other') return mediaKind
  const dot = filename.lastIndexOf('.')
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
  return ext.length > 0 && ext.length <= 5 ? ext : 'file'
}
