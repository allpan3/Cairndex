/**
 * Client-side composition of a contact sheet: the server supplies the frame
 * grid (`/files/{id}/contact-sheet`), and the three-row metadata header is drawn
 * here on a canvas. The split keeps font rendering out of the server (ffmpeg
 * `drawtext` needs font discovery and a freetype build) while the browser draws
 * text natively.
 */

import { drawWatermark } from '../watermark'

const HEADER_BACKGROUND = '#070809'
const HEADER_TEXT = '#e8eaed'

export interface ContactSheetRow {
  label: string
  value: string
}

export interface ContactSheetSource {
  sheetUrl: string
  metadataRows: readonly ContactSheetRow[]
  /** Grid shape, so each cell can be found and labelled. */
  cols: number
  rows: number
  /**
   * The owner's watermark, or null for none.
   *
   * Passed in rather than read from the preference store here, so composing a
   * sheet stays a function of its arguments; the caller that knows it is acting
   * on the owner's behalf (`contactSheetExport`) is the one that reads it.
   */
  watermark?: string | null
}

/** `H:MM:SS` / `M:SS`, matching the clock the player shows. */
function stamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Read the sampled instants the server reported for this grid. */
function reportedTimes(response: Response): number[] {
  const header = response.headers.get('X-Contact-Sheet-Times')
  if (!header) return []
  return header
    .split(',')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
}

/** Fetch the grid, compose the header above it, return a JPEG blob. */
export async function composeContactSheet(source: ContactSheetSource): Promise<Blob> {
  const response = await fetch(source.sheetUrl)
  if (!response.ok) {
    // Surface the server's own reason when it sent one. A bare 404 means the
    // route is not there at all — almost always a server still running a build
    // from before contact sheets existed — which is worth saying outright
    // rather than leaving as a status code.
    const detail = await response
      .clone()
      .json()
      .then((body: { message?: string; detail?: string }) => body.message ?? body.detail ?? null)
      .catch(() => null)
    if (response.status === 503) {
      throw new Error('The server could not extract frames from this video.')
    }
    if (response.status === 404 && (detail === null || detail === 'Not Found')) {
      throw new Error('This server does not support contact sheets yet — restart it to update.')
    }
    throw new Error(detail ?? `The contact sheet could not be generated (HTTP ${response.status}).`)
  }
  const times = reportedTimes(response)
  const grid = await createImageBitmap(await response.blob())

  const canvas = document.createElement('canvas')
  const fontSize = Math.max(14, Math.round(grid.width / 95))
  const lineHeight = Math.round(fontSize * 1.35)
  const margin = Math.round(fontSize * 1.15)
  const headerHeight = margin * 2 + lineHeight * source.metadataRows.length
  canvas.width = grid.width
  canvas.height = grid.height + headerHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot compose images.')

  ctx.fillStyle = HEADER_BACKGROUND
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.textBaseline = 'alphabetic'

  // The owner's mark, where the fixed "EXPORTED FROM / CAIRNDEX" block used to
  // be. Drawn before the metadata rows because what it occupies is what they
  // have to avoid; with no mark it returns zero and they get the whole width.
  const markWidth = drawWatermark(ctx, source.watermark ?? null, {
    left: 0,
    top: 0,
    width: canvas.width,
    height: headerHeight,
    corner: 'top-right',
  })

  ctx.fillStyle = HEADER_TEXT
  ctx.font = `400 ${fontSize}px system-ui, sans-serif`
  ctx.textAlign = 'left'
  const rowWidth = canvas.width - markWidth - margin * 2
  for (const [index, row] of source.metadataRows.entries()) {
    ctx.fillText(
      `${row.label}: ${row.value}`,
      margin,
      margin + fontSize + index * lineHeight,
      rowWidth,
    )
  }
  ctx.drawImage(grid, 0, headerHeight)

  // Label each cell with the instant it was taken from. The grid divides
  // exactly into `cols x rows` because the server keeps every gutter inside a
  // cell, so the arithmetic here is a plain division — and the instants come
  // from the server rather than being re-derived, so a label can never drift
  // from the frame above it.
  if (times.length > 0) {
    const cellWidth = grid.width / source.cols
    const cellHeight = grid.height / source.rows
    ctx.font = '600 13px system-ui, sans-serif'
    ctx.textBaseline = 'alphabetic'
    for (let index = 0; index < times.length; index += 1) {
      const at = times[index]
      if (at === undefined) continue
      const label = stamp(at)
      const col = index % source.cols
      const row = Math.floor(index / source.cols)
      const right = (col + 1) * cellWidth - 6
      const bottom = headerHeight + (row + 1) * cellHeight - 7
      const width = ctx.measureText(label).width
      // A dark plate under the text: a timestamp over a bright frame is
      // otherwise unreadable, and these frames are arbitrary.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.66)'
      ctx.fillRect(right - width - 5, bottom - 14, width + 10, 19)
      ctx.fillStyle = '#f2f4f8'
      ctx.fillText(label, right - width, bottom)
    }
  }
  grid.close()

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The sheet could not be encoded.'))),
      'image/jpeg',
      0.92,
    )
  })
}
