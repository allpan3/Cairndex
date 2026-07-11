import { useEffect, useMemo, useRef, useState } from 'react'

import type { PlayableVideo } from '../../../api/client'
import { formatClock } from '../../../lib/format'
import { StoryboardPreview } from './StoryboardPreview'
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

/** Seek bar with buffered ranges, drag scrubbing, trickplay, and chapter ticks */
export function SeekBar({
  player,
  video,
  onDragChange,
}: {
  player: PlayerController
  video: PlayableVideo
  onDragChange?: (dragging: boolean) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null)
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
  const scrub = useRef<{ last: number; pending: number | null; timer: number | null }>({
    last: 0,
    pending: null,
    timer: null,
  })
  useEffect(
    () => () => {
      if (scrub.current.timer != null) clearTimeout(scrub.current.timer)
    },
    [],
  )
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

  const timeFor = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || player.duration <= 0) return 0
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return pct * player.duration
  }
  const pctFor = (time: number) => (player.duration > 0 ? (time / player.duration) * 100 : 0)

  // Seek now, clearing any pending trailing flush.
  const commitSeek = (time: number) => {
    const s = scrub.current
    if (s.timer != null) {
      clearTimeout(s.timer)
      s.timer = null
    }
    s.pending = null
    s.last = performance.now()
    playerRef.current.seek(time)
  }

  // Seek on the leading edge, then coalesce the rest of the window into a single
  // trailing seek at the last requested position.
  const throttledSeek = (time: number) => {
    const s = scrub.current
    const elapsed = performance.now() - s.last
    if (elapsed >= SEEK_THROTTLE_MS) {
      commitSeek(time)
      return
    }
    s.pending = time
    if (s.timer == null) {
      s.timer = window.setTimeout(() => {
        s.timer = null
        if (s.pending != null) commitSeek(s.pending)
      }, SEEK_THROTTLE_MS - elapsed)
    }
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    const track = event.currentTarget as HTMLElement
    track.setPointerCapture(event.pointerId)
    dragging.current = { pointerId: event.pointerId, track }
    onDragChange?.(true)
    const time = timeFor(event.clientX)
    setDragPct(pctFor(time))
    commitSeek(time) // instant response to the click / drag start
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return
      const next = timeFor(moveEvent.clientX)
      setDragPct(pctFor(next))
      throttledSeek(next)
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
      onDragChange?.(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
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
          setHover({ x: event.clientX, time })
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
          </span>
        </div>
      )}
    </div>
  )
}
