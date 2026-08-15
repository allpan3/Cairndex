/**
 * A marked span on the playhead timeline, and the arithmetic that keeps it
 * valid (plan 1 §10 / M11).
 *
 * Deliberately shared rather than owned by the GIF exporter. Picking a GIF
 * range and looping between two points are the same selection with different
 * consumers — which is why the A-B loop was moved out of M9 into this
 * milestone (owner, 2026-07-11: "it's really the GIF range-picker"). Keeping
 * the span here means loop replay needs a consumer, not a second model.
 *
 * Pure on purpose: every clamp rule is testable without a player, a DOM, or a
 * React tree.
 */

export interface ClipRange {
  start: number
  end: number
}

export type ClipEdge = 'start' | 'end'

/**
 * The shortest span that can be marked, and the floor an edge cannot push the
 * other one past. A GIF of a single frame is legitimate output, but a zero- or
 * negative-length range is a broken selection, and letting one edge cross the
 * other silently swaps their meaning mid-drag.
 */
export const MIN_CLIP_SECONDS = 0.1

/** How long a freshly opened selection is, before the owner adjusts it. */
export const DEFAULT_CLIP_SECONDS = 5

/**
 * One frame, in seconds. Falls back to 30 fps when the file has no probed rate
 * — the same assumption `usePlayer.frameStep` has always made, kept identical
 * so a frame nudge and a frame step move by the same amount.
 */
export function frameSeconds(fps: number | null | undefined): number {
  return 1 / (typeof fps === 'number' && fps > 0 ? fps : 30)
}

/** Trim a time to the media, guarding against an unknown/zero duration. */
function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0
  const limit = Number.isFinite(duration) && duration > 0 ? duration : time
  return Math.max(0, Math.min(time, limit))
}

/** Force a span inside the media and at least `MIN_CLIP_SECONDS` long. */
export function clampRange(range: ClipRange, duration: number): ClipRange {
  const start = clampTime(range.start, duration)
  const end = clampTime(range.end, duration)
  if (end - start >= MIN_CLIP_SECONDS) return { start, end }
  // Too short (or inverted): keep the start and extend forward, unless that
  // would run off the end, in which case back the start off instead. A range
  // is never silently discarded — the owner marked something.
  const limit = Number.isFinite(duration) && duration > 0 ? duration : start + MIN_CLIP_SECONDS
  if (start + MIN_CLIP_SECONDS <= limit) return { start, end: start + MIN_CLIP_SECONDS }
  return { start: Math.max(0, limit - MIN_CLIP_SECONDS), end: limit }
}

/**
 * Put one edge at an absolute time.
 *
 * The moving edge stops `MIN_CLIP_SECONDS` short of the other rather than
 * pushing it: during a handle drag the stationary edge is the reference the
 * owner is measuring against, and dragging it along would move the thing they
 * are aiming at.
 */
export function moveEdge(
  range: ClipRange,
  edge: ClipEdge,
  to: number,
  duration: number,
): ClipRange {
  const at = clampTime(to, duration)
  if (edge === 'start') {
    return { start: Math.min(at, range.end - MIN_CLIP_SECONDS), end: range.end }
  }
  return { start: range.start, end: Math.max(at, range.start + MIN_CLIP_SECONDS) }
}

/** Shift one edge by a signed offset, under the same rules as `moveEdge`. */
export function nudgeEdge(
  range: ClipRange,
  edge: ClipEdge,
  delta: number,
  duration: number,
): ClipRange {
  return moveEdge(range, edge, range[edge] + delta, duration)
}

/**
 * The span a newly opened selection starts as: `DEFAULT_CLIP_SECONDS` from the
 * playhead forward, backed off the end only when there is not that much left.
 * Forward from the playhead rather than centred on it, because "clip from
 * here" is what pressing the button at an interesting moment means.
 */
export function defaultRange(at: number, duration: number): ClipRange {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : at + DEFAULT_CLIP_SECONDS
  const start = clampTime(at, duration)
  if (start + DEFAULT_CLIP_SECONDS <= limit) {
    return { start, end: start + DEFAULT_CLIP_SECONDS }
  }
  return clampRange({ start: Math.max(0, limit - DEFAULT_CLIP_SECONDS), end: limit }, duration)
}

export function rangeDuration(range: ClipRange): number {
  return range.end - range.start
}

/** Padding either side of the selection in the zoomed view, so both handles
 *  have somewhere to move to. */
const WINDOW_PAD_FRACTION = 0.35
const MIN_WINDOW_PAD_SECONDS = 0.5

/**
 * The span the clip bar's magnified timeline covers: the selection plus a
 * margin, clamped to the media. Padding is proportional so the selection
 * always occupies roughly the same share of the track — the magnification
 * adapts to the clip rather than to the file's length.
 */
export function windowFor(range: ClipRange, duration: number): ClipRange {
  const pad = Math.max(rangeDuration(range) * WINDOW_PAD_FRACTION, MIN_WINDOW_PAD_SECONDS)
  const limit = Number.isFinite(duration) && duration > 0 ? duration : range.end + pad
  return {
    start: Math.max(0, range.start - pad),
    end: Math.min(limit, range.end + pad),
  }
}

/**
 * `M:SS.mmm` — the clock the player prints, plus the milliseconds a
 * frame-accurate edge needs to be readable.
 */
export function formatClipTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  // Round to whole milliseconds *before* splitting into fields, so a value
  // that rounds up carries through seconds and minutes on its own. Rounding
  // the fraction separately prints `0:07.1000`, and patching only that case
  // then prints `0:60.000` at the next boundary up.
  const totalMillis = Math.round(safe * 1000)
  const millis = totalMillis % 1000
  const totalSeconds = (totalMillis - millis) / 1000
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const printed = `${String(s).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${printed}` : `${m}:${printed}`
}
