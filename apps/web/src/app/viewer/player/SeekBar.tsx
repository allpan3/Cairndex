import { useMemo, useRef, useState } from 'react'

import { formatClock } from '../../../lib/format'
import type { PlayerController } from './usePlayer'

/** Seek bar with buffered ranges, drag scrubbing, and an M4 preview hook. */
export function SeekBar({ player }: { player: PlayerController }) {
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
        <div className="mv-seek__fill" style={{ width: `${progress}%` }} />
        <div className="mv-seek__thumb" style={{ left: `${progress}%` }} />
      </div>
      {hover && (
        <div className="mv-seek__tip" style={{ left: hover.x }}>
          {formatClock(hover.time)}
          <span className="mv-seek__preview" data-storyboard-hook="true" />
        </div>
      )}
    </div>
  )
}
