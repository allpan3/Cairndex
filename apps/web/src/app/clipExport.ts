/**
 * Saving a GIF cut from the marked clip range (plan 1 §10 / M11).
 *
 * The server encodes and this drives it: create, poll, fetch the bytes, hand
 * them to the host, then tell the server it can drop the artifact. Kept beside
 * `contactSheetExport` and shaped the same way, so a surface only supplies the
 * file, the range, and somewhere to report progress.
 */

import {
  createClipExport,
  clipExportDownloadUrl,
  deleteClipExport,
  fetchClipExport,
  type ClipExportRead,
} from '../api/client'
import { getHostPlatform, isDesktopHost } from '../platform'

/**
 * The caps the server enforces (`media/exports.py`). Mirrored rather than
 * fetched, the same way the contact sheet mirrors `SHEET_WIDTHS`: they are
 * constants of the format, not configuration, and the clip bar has to know the
 * limit before there is anything to ask about.
 */
export const MAX_CLIP_EXPORT_SECONDS = 30

/** Output widths offered, all inside the server's 120–720 bound. */
export const CLIP_WIDTHS = [240, 320, 480, 720] as const
export const DEFAULT_CLIP_WIDTH = 480

/**
 * Frame rates offered, all inside the server's 5–15 bound.
 *
 * A GIF stores each frame's delay in *centiseconds*, so only rates dividing 100
 * are exact: of these, 10 fps is, and the others land on the nearest whole
 * centisecond — 12 plays back at 12.5, 15 at 16.7 (measured). That is inherent
 * to the format rather than to this pipeline, and the frame *count* is always
 * what was asked for; it is only the playback tempo that rounds.
 */
export const CLIP_FPS_CHOICES = [8, 10, 12, 15] as const
export const DEFAULT_CLIP_FPS = 12

const MIN_SERVER_WIDTH = 120

/**
 * The widths worth offering for one source.
 *
 * Presets above the source's own width are dropped: upscaling a GIF spends
 * bytes on pixels the source never had. Mirrors `qualityOptions`, which filters
 * the resolution menu the same way.
 */
export function clipWidthOptions(sourceWidth: number | null | undefined): number[] {
  if (!sourceWidth || sourceWidth <= 0) return [...CLIP_WIDTHS]
  const fitting = CLIP_WIDTHS.filter((width) => width <= sourceWidth)
  if (fitting.length > 0) return fitting
  // Narrower than every preset: offer the source's own width rather than an
  // empty control, rounded even for `scale=W:-2` and held inside the bound the
  // server enforces.
  const own = Math.max(MIN_SERVER_WIDTH, Math.floor(sourceWidth / 2) * 2)
  return [own]
}

/** The width to start on: the default when it is offered, else the largest. */
export function defaultClipWidth(options: number[]): number {
  return options.includes(DEFAULT_CLIP_WIDTH)
    ? DEFAULT_CLIP_WIDTH
    : (options[options.length - 1] ?? DEFAULT_CLIP_WIDTH)
}

/**
 * The height the export will actually have, following ffmpeg's `scale=W:-2` —
 * the aspect preserved and rounded to an even number of lines. Null when the
 * source has not been probed, since there is then nothing to derive it from.
 */
export function outputHeight(
  width: number,
  sourceWidth: number | null | undefined,
  sourceHeight: number | null | undefined,
): number | null {
  if (!sourceWidth || !sourceHeight || sourceWidth <= 0 || sourceHeight <= 0) return null
  return Math.max(2, Math.round((width * sourceHeight) / sourceWidth / 2) * 2)
}

/** Poll cadence. A GIF takes seconds, not milliseconds. */
const POLL_INTERVAL_MS = 400
/**
 * Give up well after the server's own ffmpeg deadline (300 s), so a stuck
 * export is reported by the server's error rather than by this timer.
 */
const POLL_TIMEOUT_MS = 330_000

export interface ClipExportTarget {
  fileId: string
  title: string
  /** Probed source dimensions, for the offered widths and the output height. */
  sourceWidth?: number | null
  sourceHeight?: number | null
}

export interface ClipExportRange {
  start: number
  end: number
}

export interface ClipExportOptions {
  /** Output width in pixels; the server defaults it when omitted. */
  width?: number
  /** Frames per second; the server defaults it when omitted. */
  fps?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the export settles, or throw with the server's reason. */
async function awaitArtifact(fileId: string, exportId: string): Promise<ClipExportRead> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    const state = await fetchClipExport(fileId, exportId)
    if (state.status === 'done') return state
    if (state.status === 'failed') {
      throw new Error(state.error ?? 'The clip could not be encoded.')
    }
    if (Date.now() > deadline) throw new Error('The clip is taking too long — try a shorter range.')
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * A `.gif` filename from a display title.
 *
 * The title usually still carries the source's extension, so appending
 * naively yields `clip.mp4.gif`. Drop a short trailing suffix — bounded at
 * five characters so a title that merely contains a dot ("Scene 2.5 rework")
 * survives intact. Mirrors `_safe_stem` in `api/v1/exports.py`, which names
 * the same artifact for the Content-Disposition header.
 */
export function clipFileName(title: string): string {
  const withoutExtension = title.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  const cleaned = (withoutExtension || title).replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return `${cleaned || 'clip'}.gif`
}

function downloadInBrowser(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Build and save one GIF.
 *
 * `report` receives a message; one ending in an ellipsis means work is still in
 * flight, which is how the viewer decides whether to leave it on screen.
 */
export async function saveClipGif(
  target: ClipExportTarget,
  range: ClipExportRange,
  options: ClipExportOptions,
  report: (message: string | null) => void,
): Promise<void> {
  report('Building GIF…')
  let exportId: string | null = null
  try {
    const created = await createClipExport(target.fileId, {
      kind: 'gif',
      start_s: range.start,
      end_s: range.end,
      width: options.width ?? null,
      fps: options.fps ?? null,
    })
    exportId = created.export_id
    await awaitArtifact(target.fileId, exportId)

    const response = await fetch(clipExportDownloadUrl(target.fileId, exportId))
    if (!response.ok) throw new Error(`The GIF could not be fetched (HTTP ${response.status}).`)
    const blob = await response.blob()
    const name = clipFileName(target.title)

    if (isDesktopHost()) {
      const saved = await getHostPlatform().saveExport(name, blob)
      report(saved ? 'GIF saved.' : null)
    } else {
      downloadInBrowser(blob, name)
      report('GIF saved.')
    }

    // Only once the bytes are in hand. Deleting on the server's download route
    // instead would strand a half-transferred GIF with no way to ask again.
    await deleteClipExport(target.fileId, exportId).catch(() => undefined)
  } catch (error) {
    // A failed run still leaves an artifact directory the TTL would eventually
    // reap; dropping it now keeps the data dir from carrying dead exports for
    // an hour after a mistake.
    if (exportId) await deleteClipExport(target.fileId, exportId).catch(() => undefined)
    report(error instanceof Error ? error.message : 'The GIF export failed.')
  }
}
