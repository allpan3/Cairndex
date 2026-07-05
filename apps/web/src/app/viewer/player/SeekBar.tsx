import { useMemo, useRef, useState } from 'react'

import type { PlayableVideo } from '../../../api/client'
import { formatClock } from '../../../lib/format'
import { StoryboardPreview } from './StoryboardPreview'
import type { PlayerController } from './usePlayer'

type Chapter = PlayableVideo['chapters'][number]

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
export function SeekBar({ player, video }: { player: PlayerController; video: PlayableVideo }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null)
  const progress = player.duration > 0 ? (player.currentTime / player.duration) * 100 : 0

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

  const scrub = (clientX: number) => player.seek(timeFor(clientX))

  const onPointerDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    scrub(event.clientX)
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
          const time = timeFor(event.clientX)
          if (event.buttons === 1) scrub(event.clientX)
          setHover({ x: event.clientX, time })
        }}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') player.seekBy(-5)
          else if (event.key === 'ArrowRight') player.seekBy(5)
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
        <div className="mv-seek__fill" style={{ width: `${progress}%` }} />
        <div className="mv-seek__thumb" style={{ left: `${progress}%` }} />
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
