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
import { exportFileName } from './exportNaming'
import type { WheelOption } from './WheelPicker'

/**
 * The caps the server enforces (`media/exports.py`). Mirrored rather than
 * fetched, the same way the contact sheet mirrors `SHEET_WIDTHS`: they are
 * constants of the format, not configuration, and the clip bar has to know the
 * limit before there is anything to ask about.
 */
export const MAX_CLIP_EXPORT_SECONDS = 30

/**
 * Output widths offered on the wheel.
 *
 * A long ladder is the point of the wheel: a segmented row could hold three or
 * four, so the choice was coarse. Nothing here upscales — the list is filtered
 * against the source — and the source's own width joins it when it is not
 * already a rung, which is how a clip is exported at native size now that
 * there is no separate "Original" button (owner, 2026-08-15).
 */
export const CLIP_WIDTHS = [
  160, 240, 320, 400, 480, 560, 640, 720, 854, 960, 1080, 1280, 1440, 1600, 1920,
] as const
export const DEFAULT_CLIP_WIDTH = 480

/**
 * Frame rates offered — **only rates a GIF can actually hold**.
 *
 * The format stores each frame's delay as a whole number of centiseconds, so
 * the only representable rates are `100/n`. Everything else has its delay
 * rounded and plays at a speed nobody asked for: 12 fps becomes 12.5, 15
 * becomes 14.29, 24 becomes 25, 30 becomes 33.33 — all measured off the frame
 * control blocks of real output.
 *
 * Offering those anyway would be offering a lie, so the ladder is the exact
 * ones. 50 is the top: its delay is 2cs, and 1cs is the value historic viewers
 * reinterpret as 10cs.
 */
export const CLIP_FPS_CHOICES = [5, 10, 20, 25, 50] as const
/**
 * A GIF's conventional rate is 10–15, and 10 is the one in that range the
 * format can hold exactly. It is also the cheap one: measured at the default
 * 480px over five seconds of real footage, 20 fps costs 1.77x the bytes and
 * 25 fps 2.08x. Both are one rung away for a clip that earns them.
 */
export const DEFAULT_CLIP_FPS = 10

/**
 * How far above the source's own rate a rung may still sit.
 *
 * Not zero, because none of the exact rates lands on 24 fps — the commonest
 * source rate there is. Cut off at the source, a 24 fps clip tops out at 20 and
 * loses 17% of its motion, while 25 fps duplicates two frames in forty-eight
 * (4%) and is otherwise one for one. Both measured. Ten per cent lets 24 reach
 * 25 and 48 reach 50, while still refusing 30→50 (+67% duplicates for nothing,
 * and a fifth more bytes to store them).
 */
const FPS_OVERSHOOT = 0.1

/**
 * The rates worth offering for one source.
 *
 * Asking for substantially more frames a second than the source has produces
 * duplicates, not smoother motion — measured: a 25 fps source encoded at 50
 * gained 50 frames and 1 KB, because a repeated frame costs almost nothing to
 * store and shows nothing new.
 */
export function clipFpsOptions(sourceFps: number | null | undefined): WheelOption<number>[] {
  if (!sourceFps || sourceFps <= 0) {
    return CLIP_FPS_CHOICES.map((value) => ({ value, label: `${value} fps` }))
  }
  const ceiling = sourceFps * (1 + FPS_OVERSHOOT)
  const rates = CLIP_FPS_CHOICES.filter((value) => value <= ceiling)
  // A source slower than every rung still needs one choice.
  const values = rates.length > 0 ? rates : [CLIP_FPS_CHOICES[0]]
  const native = Math.round(sourceFps)
  return values.map((value) => ({
    value,
    label: `${value} fps`,
    // Only when the format can actually match the source. For 24 and 30 fps
    // nothing can, and saying nothing is the honest version of that.
    note: value === native ? 'native' : undefined,
  }))
}

/** The rate to start on: the default when offered, else the fastest that is. */
export function defaultClipFps(options: WheelOption<number>[]): number {
  const preferred = options.find((option) => option.value === DEFAULT_CLIP_FPS)
  return preferred?.value ?? options[options.length - 1]?.value ?? DEFAULT_CLIP_FPS
}

/** `media/exports.py` bounds, mirrored (see `MAX_CLIP_EXPORT_SECONDS`). */
const MIN_SERVER_WIDTH = 120
const MAX_SERVER_WIDTH = 1920

/**
 * The widths worth offering for one source: every rung the source can fill,
 * plus the source's own width when it falls between rungs.
 *
 * Nothing upscales, and the native width is included rather than rounded away
 * — that is how a clip is exported at its own size now that there is no
 * separate "Original" button. An odd source like 854×480 gets an 854 rung of
 * its own rather than having to settle for 720.
 */
export function clipWidthOptions(sourceWidth: number | null | undefined): WheelOption<number>[] {
  // Unprobed: nothing to filter against and no native width to add.
  if (!sourceWidth || sourceWidth <= 0) {
    return CLIP_WIDTHS.map((value) => ({ value, label: `${value}px` }))
  }

  // Even, for ffmpeg's `scale=W:-2`, and inside the bounds the server enforces.
  const native = Math.min(
    MAX_SERVER_WIDTH,
    Math.max(MIN_SERVER_WIDTH, Math.floor(sourceWidth / 2) * 2),
  )
  const values: number[] = CLIP_WIDTHS.filter((value) => value <= native)
  if (!values.includes(native)) values.push(native)
  return values
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      label: `${value}px`,
      // Worth marking: the one choice that resamples nothing.
      note: value === native ? 'native' : undefined,
    }))
}

/** Whether the source is larger than anything the exporter will produce. */
export function isWidthCapped(sourceWidth: number | null | undefined): boolean {
  return Boolean(sourceWidth && sourceWidth > MAX_SERVER_WIDTH)
}

/** The width to start on: the default when it is offered, else the largest. */
export function defaultClipWidth(options: WheelOption<number>[]): number {
  const preferred = options.find((option) => option.value === DEFAULT_CLIP_WIDTH)
  return preferred?.value ?? options[options.length - 1]?.value ?? DEFAULT_CLIP_WIDTH
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
  /** Probed source frame rate, so no rate above it is offered. */
  sourceFps?: number | null
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
 * A `.gif` filename from a display title. Mirrors `_safe_stem` in
 * `api/v1/exports.py`, which names the same artifact for Content-Disposition.
 */
export function clipFileName(title: string): string {
  return exportFileName(title, 'gif', 'clip')
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
