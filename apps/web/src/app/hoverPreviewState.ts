import {
  canDirectPlayVideo,
  getClientCapabilities,
  type ClientCapabilities,
} from './viewer/player/caps'

export const HOVER_PREVIEW_DWELL_MS = 500
export const HOVER_PREVIEW_PREFETCH_MS = 150
export const HOVER_PREVIEW_REST_MS = 250

export interface HoverPreviewSource {
  fileId: string
  mimeType?: string | null
  relativePath?: string | null
  container?: string | null
  videoCodec: string | null
  audioCodec: string | null
  duration: number
  startTime?: number | null
}

export type HoverPreviewMode = 'direct' | 'storyboard' | 'none'
export type HoverPreviewPhase = 'skimming' | 'transitioning' | 'playing'

// Classify a video source without contacting playback-decision or HLS routes
export function hoverPreviewMode(
  source: HoverPreviewSource | null,
  capabilities: ClientCapabilities = getClientCapabilities(),
): HoverPreviewMode {
  if (!source || !source.fileId || !Number.isFinite(source.duration) || source.duration <= 0) {
    return 'none'
  }
  return canDirectPlayVideo(
    {
      mimeType: source.mimeType,
      relativePath: source.relativePath,
      container: source.container,
      videoCodec: source.videoCodec,
      audioCodec: source.audioCodec,
    },
    capabilities,
  )
    ? 'direct'
    : 'storyboard'
}

// Map one horizontal pointer position into a clamped media timestamp
export function hoverTimeForPointer(clientX: number, rect: DOMRect, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || rect.width <= 0) return 0
  const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return fraction * duration
}

// Clamp optional incomplete watch progress into a safe hover start time
export function hoverStartTime(source: HoverPreviewSource | null): number {
  if (!source || !Number.isFinite(source.duration) || source.duration <= 0) return 0
  const startTime = source.startTime ?? 0
  if (!Number.isFinite(startTime) || startTime <= 0) return 0
  return Math.min(startTime, source.duration)
}
