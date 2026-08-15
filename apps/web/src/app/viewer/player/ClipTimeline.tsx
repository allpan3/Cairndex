import { useMemo, useRef } from 'react'

import { formatClipTime, windowFor } from './clipRange'
import type { ClipRangeController } from './useClipRange'
import { useEdgeDrag } from './useEdgeDrag'
import type { PlayerController } from './usePlayer'

/**
 * The zoomed half of the range picker: the marked span blown up to the full
 * width of the control bar, so the same pointer movement that covered minutes
 * on the seek bar now covers frames.
 *
 * The seek bar stays the overview — it keeps the band in the context of the
 * whole file — and this is the magnified view of just the selection. Two rows
 * rather than one zoomable track, because a track that is sometimes the file
 * and sometimes six seconds of it has no stable meaning while you drag.
 */

export function ClipTimeline({
  clip,
  player,
}: {
  clip: ClipRangeController
  player: PlayerController
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const trackRect = useRef<DOMRect | null>(null)
  const range = clip.range

  // While a handle is down the window is anchored to the span the gesture
  // started from (`adjustBase`). A window that kept tracking the live selection
  // would widen under the pointer as the out-point is dragged right, so the
  // handle would trail the cursor and the magnification would change
  // mid-adjustment — the opposite of precise.
  const anchor = clip.adjustBase ?? range
  const view = useMemo(
    () => (anchor ? windowFor(anchor, player.duration) : null),
    [anchor, player.duration],
  )

  const span = view ? view.end - view.start : 0

  const timeFor = (clientX: number) => {
    const rect = trackRect.current ?? ref.current?.getBoundingClientRect()
    if (!rect || !view || span <= 0) return 0
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return view.start + fraction * span
  }

  const onEdgePointerDown = useEdgeDrag({
    clip,
    timeFor,
    onGestureStart: () => {
      trackRect.current = ref.current?.getBoundingClientRect() ?? null
    },
    onGestureEnd: () => {
      trackRect.current = null
    },
  })

  if (!range || !view || span <= 0) return null

  const pctFor = (time: number) => ((time - view.start) / span) * 100
  const startPct = pctFor(range.start)
  const endPct = pctFor(range.end)
  const playheadPct = pctFor(player.currentTime)

  return (
    <div className="mv-clip-zoom">
      <span className="mv-clip-zoom__edge">{formatClipTime(view.start)}</span>
      <div
        ref={ref}
        className="mv-clip-zoom__track"
        onPointerDown={(event) => {
          // A press on the magnified track seeks within it, matching the seek
          // bar. Handles stop propagation, so this only fires on bare track.
          if (event.button !== 0) return
          trackRect.current = ref.current?.getBoundingClientRect() ?? null
          player.seek(timeFor(event.clientX))
          trackRect.current = null
        }}
      >
        <div
          className="mv-clip-zoom__band"
          style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          aria-hidden="true"
        />
        {playheadPct >= 0 && playheadPct <= 100 && (
          <div
            className="mv-clip-zoom__playhead"
            style={{ left: `${playheadPct}%` }}
            aria-hidden="true"
          />
        )}
        {(['start', 'end'] as const).map((edge) => (
          <div
            key={edge}
            className={`mv-clip-zoom__handle mv-clip-zoom__handle--${edge}`}
            style={{ left: `${pctFor(range[edge])}%` }}
            role="slider"
            tabIndex={0}
            aria-label={edge === 'start' ? 'Clip start (fine)' : 'Clip end (fine)'}
            aria-valuemin={0}
            aria-valuemax={Math.round(player.duration)}
            aria-valuenow={Math.round(range[edge])}
            aria-valuetext={formatClipTime(range[edge])}
            onPointerDown={onEdgePointerDown(edge)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 1 : clip.frame
              if (event.key === 'ArrowLeft') clip.nudge(edge, -step)
              else if (event.key === 'ArrowRight') clip.nudge(edge, step)
              else return
              event.preventDefault()
              event.stopPropagation()
            }}
          />
        ))}
      </div>
      <span className="mv-clip-zoom__edge">{formatClipTime(view.end)}</span>
    </div>
  )
}
