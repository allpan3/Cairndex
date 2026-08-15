/**
 * Saving the frame on screen as a PNG.
 *
 * Client-side: the stream is same-origin, so the canvas stays untainted and no
 * server round trip is needed (plan 1 §2). Lifted out of the viewer on
 * 2026-08-15 when a size choice arrived — `S` still saves at the source's own
 * resolution with no prompt, and "Snapshot As…" asks first.
 */

import { getHostPlatform, isDesktopHost } from '../platform'
import { exportFileName } from './exportNaming'
import type { WheelOption } from './WheelPicker'

/**
 * Widths offered when a snapshot is scaled down.
 *
 * No ceiling of its own: this is a canvas draw, not an encode, so the source's
 * own size is always the top of the list and there is nothing to cap. Sizes at
 * or above the source are dropped, because scaling a still up adds nothing.
 */
export const SNAPSHOT_WIDTHS = [320, 480, 640, 854, 960, 1280, 1600, 1920, 2560, 3840] as const

/** The width to offer first: near the middle of what the source can fill. */
export function defaultSnapshotWidth(options: WheelOption<number>[]): number {
  // The native width is the last rung; the one before it is a sensible middle
  // for "smaller than the original, but not tiny".
  return options[Math.max(0, options.length - 2)]?.value ?? options[0]?.value ?? 0
}

/** Every width worth offering for a source, ending at its own. */
export function snapshotWidthOptions(sourceWidth: number): WheelOption<number>[] {
  const native = Math.max(1, Math.round(sourceWidth))
  const values: number[] = SNAPSHOT_WIDTHS.filter((value) => value < native)
  values.push(native)
  return values.map((value) => ({
    value,
    label: `${value}px`,
    note: value === native ? 'native' : undefined,
  }))
}

/** The height a scaled snapshot will have, keeping the source's aspect. */
export function snapshotHeight(width: number, sourceWidth: number, sourceHeight: number): number {
  if (sourceWidth <= 0 || sourceHeight <= 0) return 0
  return Math.max(1, Math.round((width * sourceHeight) / sourceWidth))
}

/** `<title>.png`, sharing the GIF path's naming so neither drifts. */
export function snapshotFileName(title: string): string {
  return exportFileName(title, 'png', 'snapshot')
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
 * Draw the current frame and save it.
 *
 * `width` scales the output, keeping the aspect; omitted, the frame is saved at
 * the source's own resolution — which is what plain `S` does.
 */
export function saveSnapshot(
  video: HTMLVideoElement,
  title: string,
  options: { width?: number } = {},
): void {
  const nativeWidth = Math.max(1, video.videoWidth || 1280)
  const nativeHeight = Math.max(1, video.videoHeight || 720)
  const width = Math.max(1, Math.round(options.width ?? nativeWidth))
  const height = snapshotHeight(width, nativeWidth, nativeHeight)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  try {
    // Scaling happens in this one draw; the browser's own resampling is what a
    // still image wants, and it costs nothing extra.
    ctx.drawImage(video, 0, 0, width, height)
  } catch {
    ctx.fillStyle = '#050609'
    ctx.fillRect(0, 0, width, height)
  }

  canvas.toBlob((blob) => {
    if (!blob) return
    const name = snapshotFileName(title)
    // Desktop: through the shell, which saves into the configured export folder
    // (Settings → Exports) or asks via the native dialog. A browser can only
    // download, so it keeps the anchor.
    if (isDesktopHost()) {
      void getHostPlatform()
        .saveExport(name, blob)
        .catch(() => {
          // Fall back to a plain download rather than losing the frame.
          downloadInBrowser(blob, name)
        })
      return
    }
    downloadInBrowser(blob, name)
  }, 'image/png')
}
