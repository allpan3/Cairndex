import { useEffect, useMemo, useRef, useState } from 'react'

import type { Moment, PlayableVideo } from '../../../api/client'
import { formatClock } from '../../../lib/format'
import {
  createLeadingTrailingThrottle,
  type LeadingTrailingThrottle,
} from '../../../lib/leadingTrailingThrottle'
import { StoryboardPreview } from './StoryboardPreview'
import { formatClipTime } from './clipRange'
import type { ClipRangeController } from './useClipRange'
import { useEdgeDrag } from './useEdgeDrag'
import type { PlayerController } from './usePlayer'

type Chapter = PlayableVideo['chapters'][number]

// Coalesce drag scrubbing: a pointer drag emits dozens of `pointermove`s per
// second, and each `seek()` makes the browser cancel the in-flight byte range
// request and open a new one. Rate-limit the real seek to one per this window
// (leading edge + trailing flush), and always commit the exact final position
// on release. The thumb and storyboard tooltip still track the pointer live, so
// scrubbing stays smooth while the network sees far fewer requests.
const SEEK_THROTTLE_MS = 150

// Find the chapter containing a hovered playback time
function chapterForTime(chapters: Chapter[], time: number): Chapter | null {
  if (!chapters.length || !Number.isFinite(time)) return null
  const current = chapters.find((chapter) => time >= chapter.start && time < chapter.end)
  if (current) return current
  const last = chapters[chapters.length - 1]
  if (last && time >= last.start) return last
  return null
}

/** The saved moment covering a hovered time, if any. A range wins over a frame:
 *  it says more, and a frame inside a range is the less specific answer. */
function momentForTime(moments: Moment[], time: number, frame: number): Moment | null {
  if (!moments.length || !Number.isFinite(time)) return null
  const span = moments.find(
    (moment) => moment.end_s !== null && time >= moment.start_s && time <= moment.end_s,
  )
  if (span) return span
  // A frame occupies no width, so "hovering it" has to mean landing near it —
  // and a pixel of a two-hour film is far wider than a frame.
  return (
    moments.find((moment) => moment.end_s === null && Math.abs(moment.start_s - time) <= frame) ??
    null
  )
}

/** Seek bar with buffered ranges, drag scrubbing, trickplay, and chapter ticks */
export function SeekBar({
  player,
  video,
  onDragChange,
  clip,
  moments = [],
}: {
  player: PlayerController
  video: PlayableVideo
  onDragChange?: (dragging: boolean) => void
  /** Present while clip mode is on: draws the marked band and its handles. */
  clip?: ClipRangeController
  /**
   * Saved moments on this file (plan 7), drawn as ticks and thin bands.
   *
   * Non-interactive on purpose: the track's own `pointerdown` scrubs, and a
   * click target competing with it is a separate design problem. They are a
   * *map* — where the marked things are — and the hover tooltip names them.
   */
  moments?: Moment[]
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  // The track's width travels with the hover so a frame mark's hit tolerance can
  // be one pixel of *this* track: a pixel of a two-hour film is far wider than a
  // frame, and the geometry is only knowable from the gesture that measured it.
  const [hover, setHover] = useState<{ x: number; time: number; width: number } | null>(null)
  // While dragging, drive the fill/thumb from the pointer position (dragPct)
  // rather than currentTime, which the throttle deliberately lags behind.
  const [dragPct, setDragPct] = useState<number | null>(null)
  const dragging = useRef<{ pointerId: number; track: HTMLElement } | null>(null)
  // Keep the latest player in a ref so a trailing-flush timer never seeks a
  // stale controller.
  const playerRef = useRef(player)
  useEffect(() => {
    playerRef.current = player
  }, [player])
  const scrub = useRef<LeadingTrailingThrottle<number> | null>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => {
    const throttle = createLeadingTrailingThrottle(SEEK_THROTTLE_MS, (time: number) => {
      playerRef.current.seek(time)
    })
    scrub.current = throttle
    return () => {
      throttle.cancel()
      scrub.current = null
      dragCleanup.current?.()
    }
  }, [])
  const progress = player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0
  const displayPct = dragPct ?? progress

  const buffered = useMemo(
    () =>
      player.duration > 0
        ? player.buffered.map((range) => ({
            left: (range.start / player.duration) * 100,
            width: ((range.end - range.start) / player.duration) * 100,
          }))
        : [],
    [player.buffered, player.duration],
  )
  const chapters = video.chapters
  const chapterTicks = useMemo(
    () =>
      player.duration > 0
        ? chapters
            .filter((chapter) => chapter.start >= 0 && chapter.start <= player.duration)
            .map((chapter) => ({
              chapter,
              left: (chapter.start / player.duration) * 100,
            }))
        : [],
    [chapters, player.duration],
  )
  const hoverChapter = hover ? chapterForTime(chapters, hover.time) : null
  const momentMarks = useMemo(
    () =>
      player.duration > 0
        ? moments
            .filter((moment) => moment.start_s >= 0 && moment.start_s <= player.duration)
            .map((moment) => ({
              id: moment.id,
              left: (moment.start_s / player.duration) * 100,
              // A frame has no width; a range gets one, clamped so a very short
              // span is still visible rather than a sub-pixel sliver.
              width:
                moment.end_s === null
                  ? null
                  : Math.max(
                      0.4,
                      ((Math.min(moment.end_s, player.duration) - moment.start_s) /
                        player.duration) *
                        100,
                    ),
            }))
        : [],
    [moments, player.duration],
  )
  const hoverMoment = hover
    ? momentForTime(
        moments,
        hover.time,
        hover.width > 0 && player.duration > 0 ? player.duration / hover.width : 0,
      )
    : null
  // Only draw the band once there is a duration to scale it against.
  const clipRange = clip?.active && player.duration > 0 ? clip.range : null

  // The track's geometry, cached for the length of a gesture. Reading it back
  // per `pointermove` forces a synchronous layout of a document whose inline
  // styles the previous commit just rewrote — the classic read-after-write
  // thrash, 60-120x a second while scrubbing.
  const trackRect = useRef<DOMRect | null>(null)
  const timeFor = (clientX: number) => {
    const rect = trackRect.current ?? ref.current?.getBoundingClientRect()
    if (!rect || player.duration <= 0) return 0
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return pct * player.duration
  }
  const pctFor = (time: number) => (player.duration > 0 ? (time / player.duration) * 100 : 0)

  const commitSeek = (time: number) => scrub.current?.flush(time)
  const throttledSeek = (time: number) => scrub.current?.schedule(time)

  const onEdgePointerDown = useEdgeDrag({
    clip,
    timeFor,
    onGestureStart: () => {
      trackRect.current = ref.current?.getBoundingClientRect() ?? null
    },
    onGestureEnd: () => {
      trackRect.current = null
    },
    onDragChange,
  })

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    dragCleanup.current?.()
    const track = event.currentTarget as HTMLElement
    track.setPointerCapture(event.pointerId)
    dragging.current = { pointerId: event.pointerId, track }
    onDragChange?.(true)
    trackRect.current = track.getBoundingClientRect()
    const time = timeFor(event.clientX)
    setDragPct(pctFor(time))
    commitSeek(time) // instant response to the click / drag start
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return
      const next = timeFor(moveEvent.clientX)
      setDragPct(pctFor(next))
      // The throttle deliberately lags the video, and this preview is what
      // covers for it — so it has to track the pointer through the drag, not
      // freeze at wherever the press landed.
      setHover({ x: moveEvent.clientX, time: next, width: trackRect.current?.width ?? 0 })
      throttledSeek(next)
    }
    const removeListeners = () => {
      trackRect.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      onDragChange?.(false)
      dragCleanup.current = null
    }
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return
      commitSeek(timeFor(endEvent.clientX))
      if (track.hasPointerCapture?.(event.pointerId)) {
        track.releasePointerCapture(event.pointerId)
      }
      dragging.current = null
      setDragPct(null)
      setHover(null)
      removeListeners()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    dragCleanup.current = removeListeners
  }

  return (
    <div className="mv-seek">
      <div
        ref={ref}
        className="mv-seek__track"
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(player.duration)}
        aria-valuenow={Math.round(player.currentTime)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => {
          if (dragging.current) return
          const time = timeFor(event.clientX)
          setHover({ x: event.clientX, time, width: event.currentTarget.clientWidth })
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') player.seekBy(-player.seekStep)
          else if (event.key === 'ArrowRight') player.seekBy(player.seekStep)
          else return
          event.preventDefault()
        }}
      >
        {buffered.map((range, index) => (
          <div
            key={index}
            className="mv-seek__buffer"
            style={{ left: `${range.left}%`, width: `${range.width}%` }}
          />
        ))}
        {chapterTicks.map(({ chapter, left }, index) => (
          <div
            key={`${chapter.start}-${index}`}
            className="mv-seek__chapter-tick"
            style={{ left: `${left}%` }}
            aria-hidden="true"
          />
        ))}
        <div className="mv-seek__fill" style={{ width: `${displayPct}%` }} />
        {momentMarks.map((mark) =>
          mark.width === null ? (
            <div
              key={mark.id}
              className="mv-seek__moment-tick"
              style={{ left: `${mark.left}%` }}
              aria-hidden="true"
            />
          ) : (
            <div
              key={mark.id}
              className="mv-seek__moment-band"
              style={{ left: `${mark.left}%`, width: `${mark.width}%` }}
              aria-hidden="true"
            />
          ),
        )}
        {clipRange && (
          <>
            <div
              className="mv-seek__range"
              style={{
                left: `${pctFor(clipRange.start)}%`,
                width: `${pctFor(clipRange.end) - pctFor(clipRange.start)}%`,
              }}
              aria-hidden="true"
            />
            {(['start', 'end'] as const).map((edge) => (
              <div
                key={edge}
                className={`mv-seek__handle mv-seek__handle--${edge}`}
                style={{ left: `${pctFor(clipRange[edge])}%` }}
                role="slider"
                tabIndex={0}
                aria-label={edge === 'start' ? 'Clip start' : 'Clip end'}
                aria-valuemin={0}
                aria-valuemax={Math.round(player.duration)}
                aria-valuenow={Math.round(clipRange[edge])}
                aria-valuetext={formatClipTime(clipRange[edge])}
                onPointerDown={onEdgePointerDown(edge)}
                onKeyDown={(event) => {
                  // A frame per press, a second with Shift — the same pair the
                  // clip bar's nudge buttons offer, for keyboard-only use.
                  const step = event.shiftKey ? 1 : (clip?.frame ?? 1 / 30)
                  if (event.key === 'ArrowLeft') clip?.nudge(edge, -step)
                  else if (event.key === 'ArrowRight') clip?.nudge(edge, step)
                  else return
                  event.preventDefault()
                  event.stopPropagation()
                }}
              />
            ))}
          </>
        )}
        <div className="mv-seek__thumb" style={{ left: `${displayPct}%` }} />
      </div>
      {hover && (
        <div className="mv-seek__tip" style={{ left: hover.x }}>
          <StoryboardPreview storyboardUrl={video.storyboard_url} time={hover.time} />
          <span className="mv-seek__tip-text">
            <span>{formatClock(hover.time)}</span>
            {hoverChapter?.title && (
              <span className="mv-seek__chapter-title">{hoverChapter.title}</span>
            )}
            {hoverMoment && (
              <span className="mv-seek__moment-note">
                ★{hoverMoment.comment ? ` ${hoverMoment.comment}` : ' Moment'}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
