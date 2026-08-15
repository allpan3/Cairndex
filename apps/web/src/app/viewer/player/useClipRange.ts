import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  clampRange,
  defaultRange,
  frameSeconds,
  moveEdge,
  nudgeEdge,
  type ClipEdge,
  type ClipRange,
} from './clipRange'
import type { PlayerController } from './usePlayer'

/**
 * The live clip selection: which span is marked, and every way of moving it.
 *
 * One rule runs through all of it — **moving an edge shows you that edge**.
 * Precision is only meaningful if the frame you are landing on is on screen,
 * so a nudge or a handle drag scrubs the video to the edge being moved. That
 * is why this lives next to the player rather than inside a dialog.
 */
export interface ClipRangeController {
  /** Whether the clip bar and the seek-bar band are showing. */
  active: boolean
  range: ClipRange | null
  /** Whether playback repeats the marked span while picking it. */
  loop: boolean
  /** One frame in seconds, for the frame-sized nudge buttons. */
  frame: number
  /** True while a handle is being dragged — suspends the preview loop. */
  adjusting: boolean
  /**
   * The span as it was when the current drag started, or null when no drag is
   * in progress. The zoomed timeline anchors its window to this: a window that
   * kept tracking the live selection would widen under the pointer as the
   * out-point is dragged right, so the handle would trail the cursor and the
   * magnification would change mid-adjustment.
   */
  adjustBase: ClipRange | null
  open: () => void
  close: () => void
  /** `[` / `]`: put an edge exactly where the playhead is. */
  markAtPlayhead: (edge: ClipEdge) => void
  /** Step an edge by a signed offset and scrub to it. */
  nudge: (edge: ClipEdge, delta: number) => void
  /**
   * Put an edge at an absolute time (handle drags).
   *
   * `scrub: false` commits the edge without seeking, so a drag can update the
   * band on every pointer move while the far more expensive seek stays
   * throttled — the same split the scrub path has always used.
   */
  moveTo: (edge: ClipEdge, seconds: number, options?: { scrub?: boolean }) => void
  setLoop: (on: boolean) => void
  setAdjusting: (on: boolean) => void
}

interface UseClipRangeOptions {
  player: PlayerController
  /**
   * The playhead read from the media element, not from React state.
   *
   * `player.currentTime` lags the element by a render and an effect, because it
   * is state fed by `timeupdate`. Marking an edge right after a seek would then
   * record where the playhead *was* — and this feature exists to be exact about
   * that number.
   */
  getCurrentTime: () => number
  duration: number
  fps: number | null | undefined
  /** Identifies the playing file; a change clears the selection. */
  sourceKey: string | null
}

export function useClipRange({
  player,
  getCurrentTime,
  duration,
  fps,
  sourceKey,
}: UseClipRangeOptions): ClipRangeController {
  const [active, setActive] = useState(false)
  const [range, setRange] = useState<ClipRange | null>(null)
  const [loop, setLoop] = useState(false)
  // One piece of state for both facts: a drag is in progress, and this is the
  // span it started from.
  const [adjustBase, setAdjustBase] = useState<ClipRange | null>(null)

  // The player's identity changes on every `timeupdate`, so reading it through
  // a ref keeps these callbacks stable — otherwise every consumer of this
  // controller re-renders four times a second.
  const playerRef = useRef(player)
  const nowRef = useRef(getCurrentTime)
  const durationRef = useRef(duration)
  // Edge moves read the current span from here rather than from a `setRange`
  // updater: they also have to seek, and a side effect inside an updater runs
  // twice under StrictMode.
  const rangeRef = useRef<ClipRange | null>(range)
  useEffect(() => {
    playerRef.current = player
    nowRef.current = getCurrentTime
    durationRef.current = duration
    rangeRef.current = range
  }, [duration, getCurrentTime, player, range])

  // A selection belongs to the file it was marked on. Carrying it to the next
  // file in the playlist would silently point at unrelated footage.
  useEffect(() => {
    rangeRef.current = null
    /* eslint-disable react-hooks/set-state-in-effect */
    setActive(false)
    setRange(null)
    setLoop(false)
    setAdjustBase(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [sourceKey])

  const frame = useMemo(() => frameSeconds(fps), [fps])

  const close = useCallback(() => {
    rangeRef.current = null
    setActive(false)
    setRange(null)
    setLoop(false)
    setAdjustBase(null)
  }, [])

  /**
   * Commit a new span. The ref is written synchronously so a burst of moves
   * within one frame — a fast drag, a held nudge button — each build on the
   * last rather than all reading the same pre-render value.
   */
  const commit = useCallback((next: ClipRange) => {
    rangeRef.current = next
    setRange(next)
  }, [])

  /**
   * Enter or leave a drag. Entering records the span as it stands, which is
   * what the zoomed timeline anchors its window to for the length of the
   * gesture.
   */
  const setAdjusting = useCallback((on: boolean) => {
    setAdjustBase(on ? rangeRef.current : null)
  }, [])

  const open = useCallback(() => {
    setActive(true)
    // Only seed when nothing is marked. `[`/`]` can open the bar by marking an
    // edge first, and opening it again must not discard that.
    if (!rangeRef.current) {
      commit(defaultRange(nowRef.current(), durationRef.current))
    }
  }, [commit])

  const markAtPlayhead = useCallback(
    (edge: ClipEdge) => {
      const at = nowRef.current()
      const limit = durationRef.current
      setActive(true)
      // Marking an edge with nothing selected yet starts a span from the
      // playhead rather than refusing: `]` on a fresh video should mean "end
      // it here", not nothing.
      const previous = rangeRef.current
      commit(
        previous ? moveEdge(previous, edge, at, limit) : clampRange(defaultRange(at, limit), limit),
      )
    },
    [commit],
  )

  const nudge = useCallback(
    (edge: ClipEdge, delta: number) => {
      const previous = rangeRef.current
      if (!previous) return
      // Pausing matches `frameStep`, and a frame-sized adjustment is
      // meaningless against moving video anyway.
      playerRef.current.pause()
      const next = nudgeEdge(previous, edge, delta, durationRef.current)
      commit(next)
      playerRef.current.seek(next[edge])
    },
    [commit],
  )

  const moveTo = useCallback(
    (edge: ClipEdge, seconds: number, options?: { scrub?: boolean }) => {
      const previous = rangeRef.current
      if (!previous) return
      const next = moveEdge(previous, edge, seconds, durationRef.current)
      commit(next)
      if (options?.scrub !== false) playerRef.current.seek(next[edge])
    },
    [commit],
  )

  return useMemo(
    () => ({
      active,
      range,
      loop,
      frame,
      adjusting: adjustBase !== null,
      adjustBase,
      open,
      close,
      markAtPlayhead,
      nudge,
      moveTo,
      setLoop,
      setAdjusting,
    }),
    [
      active,
      adjustBase,
      close,
      frame,
      loop,
      markAtPlayhead,
      moveTo,
      nudge,
      open,
      range,
      setAdjusting,
    ],
  )
}

/**
 * Repeat the marked span while it is being picked.
 *
 * Driven off `requestAnimationFrame` rather than `timeupdate`, which fires as
 * seldom as four times a second — a loop built on it overshoots the out-point
 * by up to 250 ms, which is exactly the precision this whole feature exists to
 * give. The frame callback only runs while the loop is on.
 *
 * This is also the seam A-B loop replay lands on: the same span, enabled from
 * playback settings instead of the clip bar.
 */
export function useClipLoop(
  video: HTMLVideoElement | null,
  range: ClipRange | null,
  enabled: boolean,
) {
  useEffect(() => {
    if (!video || !range || !enabled) return
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      // Never fight a gesture: a drag is already scrubbing the playhead
      // deliberately, and re-entering a seek that has not landed yet thrashes
      // the byte range the same way unthrottled scrubbing does.
      if (video.paused || video.seeking) return
      if (video.currentTime >= range.end) video.currentTime = range.start
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [enabled, range, video])
}
