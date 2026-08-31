import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  clampRange,
  defaultRange,
  frameSeconds,
  moveEdge,
  nudgeEdge,
  setEdgeAtPlayhead,
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
  /**
   * Whether the **range loop is armed** on this span (plan 7).
   *
   * Armed is a mode, not a preference and not a session: while it is on, any
   * playback is confined to the span and repeats at the out-point, and a pause
   * does not end it — pressing Space again resumes inside the span. That is the
   * one thing the 2026-08-16 decision ruled out for a *quiet* mode, and the
   * distinction is that this one is visible: the clip bar is open, the control
   * is lit, and the band is drawn on both tracks.
   *
   * Turning it on starts it, because "loop this span" is an action rather than a
   * preference about some later press. Turning it off leaves playback running,
   * simply no longer confined.
   */
  loop: boolean
  /**
   * Whether the span is playing *as a span* right now.
   *
   * The span is something you play, not a mode that quietly redefines the play
   * button (owner, 2026-08-16). Space is ordinary playback and ignores the
   * marks entirely; only this session confines playback to them, and any pause
   * ends it — so resuming with Space is unconfined, as it should be.
   */
  playingRange: boolean
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
  /**
   * Play the span: jump to the in-point and run to the out-point.
   *
   * Repeats instead of stopping when `loop` is on. Pressing it again restarts
   * from the in-point, which is what checking a mark actually needs — nudge,
   * press, watch, repeat.
   */
  playRange: () => void
  /** Arm or disarm the range loop on the current span. Arming starts it. */
  setLoop: (on: boolean) => void
  /**
   * Adopt a span and arm the loop on it in one step — a saved moment's
   * loop button (plan 7).
   *
   * The clip bar opens with the span in it, so an armed loop is always
   * accompanied by the marks that define it and the control that ends it.
   */
  armLoop: (range: ClipRange) => void
  /**
   * Give up confining playback to the span.
   *
   * Called by `useClipPlayback` when the element pauses or ends, which is the
   * one place that can see it happen — including the pause it performs itself
   * at the out-point, so both endings run through the same door.
   */
  endRangePlayback: () => void
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
  const [loop, setLoopState] = useState(false)
  const [playingRange, setPlayingRange] = useState(false)
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
    setLoopState(false)
    setPlayingRange(false)
    setAdjustBase(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [sourceKey])

  const frame = useMemo(() => frameSeconds(fps), [fps])

  const close = useCallback(() => {
    rangeRef.current = null
    setActive(false)
    setRange(null)
    // Closing the picker disarms: an armed loop with no visible span and no
    // control to end it is exactly the quiet mode this design refuses.
    setLoopState(false)
    setPlayingRange(false)
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
        previous
          ? setEdgeAtPlayhead(previous, edge, at, limit)
          : clampRange(defaultRange(at, limit), limit),
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

  /** Start the span from its in-point — what arming and Play Range share. */
  const startSpan = useCallback((from: ClipRange) => {
    // Seek before play, so the frame that arrives is the in-point rather than a
    // moment of wherever the playhead happened to be.
    playerRef.current.seek(from.start)
    playerRef.current.play()
  }, [])

  const setLoop = useCallback(
    (on: boolean) => {
      setLoopState(on)
      // Disarming leaves playback alone: it stops being confined, it does not
      // stop.
      if (!on) return
      const current = rangeRef.current
      if (!current) return
      setActive(true)
      startSpan(current)
    },
    [startSpan],
  )

  const armLoop = useCallback(
    (next: ClipRange) => {
      const clamped = clampRange(next, durationRef.current)
      commit(clamped)
      setActive(true)
      setLoopState(true)
      startSpan(clamped)
    },
    [commit, startSpan],
  )

  const playRange = useCallback(() => {
    const current = rangeRef.current
    // Nothing marked means nothing to play — the shortcut is then simply not
    // this window's to handle.
    if (!current) return
    startSpan(current)
    setPlayingRange(true)
  }, [startSpan])

  const endRangePlayback = useCallback(() => setPlayingRange(false), [])

  return useMemo(
    () => ({
      active,
      range,
      loop,
      playingRange,
      frame,
      adjusting: adjustBase !== null,
      adjustBase,
      open,
      close,
      markAtPlayhead,
      nudge,
      moveTo,
      playRange,
      setLoop,
      armLoop,
      endRangePlayback,
      setAdjusting,
    }),
    [
      active,
      adjustBase,
      armLoop,
      close,
      endRangePlayback,
      frame,
      loop,
      markAtPlayhead,
      moveTo,
      nudge,
      open,
      playRange,
      playingRange,
      range,
      setAdjusting,
      setLoop,
    ],
  )
}

/**
 * How, if at all, playback is confined to the marked span.
 *
 * - `off` — not at all. Space is ordinary playback and the marks are only marks.
 * - `session` — one run of the span: it stops at the out-point, and **any** pause
 *   ends the session, so resuming with Space is unconfined again. What Play
 *   Range starts.
 * - `armed` — the range loop: playback repeats at the out-point and a pause does
 *   not end it, so Space resumes *inside* the span. Stays until disarmed.
 *
 * The two are one mechanism with two endings rather than a flag apiece, because
 * "confine, but do not repeat, and survive a pause" is not a state that means
 * anything.
 */
export type ClipPlaybackMode = 'off' | 'session' | 'armed'

/**
 * Confine playback to the marked span (plan 1 §10 / M11; armed mode from plan 7).
 *
 * **A session or a mode, and the difference is only what a pause means.** Playing
 * the span used to be a standing setting that silently redefined the play button,
 * so Space meant one thing with a clip marked and another without (owner,
 * 2026-08-16). `session` is the answer to that: every way out is a pause, so
 * Space is always ordinary playback afterwards. `armed` is the range loop the owner
 * asked for on top of it, and it survives a pause deliberately — which is only
 * defensible because arming is visible and one click undoes it.
 *
 * Driven off `requestAnimationFrame` rather than `timeupdate`, which fires as
 * seldom as four times a second — an out-point enforced on it overshoots by up
 * to 250 ms, which is exactly the precision this whole feature exists to give.
 */
export function useClipPlayback(
  video: HTMLVideoElement | null,
  range: ClipRange | null,
  { mode, onEnd }: { mode: ClipPlaybackMode; onEnd: () => void },
) {
  useEffect(() => {
    if (!video || !range || mode === 'off') return
    const armed = mode === 'armed'
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      // Never fight a gesture: a drag is already scrubbing the playhead
      // deliberately, and re-entering a seek that has not landed yet thrashes
      // the byte range the same way unthrottled scrubbing does.
      if (video.paused || video.seeking) return
      // Only the out-point is enforced. A playhead *before* the in-point is left
      // alone on purpose: watching the run-up into a marked span is a real thing
      // to want, and yanking it forward would make seeking inside an armed loop
      // impossible (plan 7 §2).
      if (video.currentTime < range.end) return
      if (armed) video.currentTime = range.start
      // A session stops on the out-point and lets the pause below close it, so
      // there is one ending rather than two that can disagree.
      else video.pause()
    }
    // `pause` and `ended` get distinct owners, because a span whose out-point is
    // the *file's* own end finishes through both — and the spec fires `pause`
    // first. Treating that pause as an ordinary one tore the session down before
    // the loop could come round, and the tick above cannot help: by then the
    // element has paused itself, so its first guard returns. Marking an in-point
    // late in a video is enough to get there, since `setEdgeAtPlayhead` keeps the
    // span's length and clamps the out-point to the duration (owner-reported,
    // 2026-08-16: the playhead parked at the far right and Loop never returned).
    const onPause = () => {
      // The media pausing itself at its own end is `ended`'s business.
      if (video.ended) return
      // An armed loop is a mode: the owner pausing it is a pause, not a
      // disarm, and Space picks up inside the span again.
      if (armed) return
      onEnd()
    }
    const onEnded = () => {
      if (armed) {
        video.currentTime = range.start
        void video.play()
        return
      }
      // A session parks at the in-point rather than at the file's end, so the
      // next press replays the span instead of restarting the whole file — a
      // browser resets an ended element's playhead before `play` fires, which is
      // why leaving it at the end silently lost the selection.
      video.currentTime = range.start
      onEnd()
    }
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
    }
  }, [mode, onEnd, range, video])
}
