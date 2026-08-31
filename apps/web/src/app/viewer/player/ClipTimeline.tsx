import { useEffect, useMemo, useRef, useState } from 'react'

import { formatClipTime, windowFor, type ClipRange } from './clipRange'
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
 *
 * The magnification fits the selection by default, which is right until the
 * selection is a minute long and one pixel is a tenth of a second. So the wheel
 * zooms this track, and Alt+wheel pans it (owner, 2026-08-30). A hand-set window
 * lasts only while it still shows some of the marked span — the moment an edit
 * carries the selection out of view the track snaps back to fitting it, so there
 * is no way to end up zoomed into empty timeline with the handles nowhere.
 */

/** One wheel notch, as a factor on the visible span. */
const ZOOM_STEP = 1.25
/** The closest the track will go. Below this a pixel is a fraction of a frame
 *  and the extra precision is imaginary. */
const MIN_VIEW_SECONDS = 0.2
/** One Alt+wheel notch, as a share of the visible span. */
const PAN_STEP = 0.15

/** Whether a hand-set window still shows any of the marked span. */
function shows(view: ClipRange, range: ClipRange): boolean {
  return view.end > range.start && view.start < range.end
}

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
  // A window the owner set with the wheel, or null for "fit the selection".
  const [manual, setManual] = useState<ClipRange | null>(null)
  const fitted = useMemo(
    () => (anchor ? windowFor(anchor, player.duration) : null),
    [anchor, player.duration],
  )
  // The hand-set window survives only while the selection is still somewhere in
  // it; an edit that carries the span away re-fits rather than stranding the
  // owner on empty timeline.
  const view = manual && anchor && shows(manual, anchor) ? manual : fitted

  const span = view ? view.end - view.start : 0

  const timeFor = (clientX: number) => {
    const rect = trackRect.current ?? ref.current?.getBoundingClientRect()
    if (!rect || !view || span <= 0) return 0
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return view.start + fraction * span
  }

  /**
   * Wheel to zoom, Alt+wheel to pan.
   *
   * A native listener rather than React's `onWheel`, because React attaches
   * wheel *passively* at the root: `preventDefault` there is ignored, and the
   * page would scroll under the zoom. Bound here so it can be non-passive.
   */
  const duration = player.duration
  useEffect(() => {
    const track = ref.current
    if (!track || !view || span <= 0) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // The viewer turns a wheel into volume; over this track the wheel is the
      // zoom and nothing else (owner, 2026-08-30: "priority is given to the
      // range chrome").
      event.stopPropagation()
      const rect = track.getBoundingClientRect()
      if (rect.width <= 0) return
      const limit = Number.isFinite(duration) && duration > 0 ? duration : view.end
      // Where the pointer is, in seconds — the point the zoom keeps still.
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      const at = view.start + fraction * span
      const clamp = (next: ClipRange): ClipRange => {
        const width = Math.min(next.end - next.start, limit)
        const start = Math.max(0, Math.min(next.start, limit - width))
        return { start, end: start + width }
      }
      if (event.altKey) {
        const shift = Math.sign(event.deltaY) * span * PAN_STEP
        setManual(clamp({ start: view.start + shift, end: view.end + shift }))
        return
      }
      const nextSpan = Math.max(
        MIN_VIEW_SECONDS,
        Math.min(limit, span * (event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
      )
      setManual(clamp({ start: at - fraction * nextSpan, end: at + (1 - fraction) * nextSpan }))
    }
    track.addEventListener('wheel', onWheel, { passive: false })
    return () => track.removeEventListener('wheel', onWheel)
  }, [duration, span, view])

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
  // The window is frozen for the length of a gesture (see `adjustBase`), so
  // dragging the *seek bar's* handle can carry an edge outside it. Pin the
  // rendering to the track's ends rather than letting a handle escape into the
  // control bar: the edge is off-screen in this view, and the honest way to say
  // so is that it is somewhere past this end. The window re-fits on release.
  const clampPct = (pct: number) => Math.max(0, Math.min(100, pct))
  const startPct = clampPct(pctFor(range.start))
  const endPct = clampPct(pctFor(range.end))
  const playheadPct = pctFor(player.currentTime)

  return (
    <div className="mv-clip-zoom">
      <span className="mv-clip-zoom__edge">{formatClipTime(view.start)}</span>
      <div
        ref={ref}
        className="mv-clip-zoom__track"
        title="Scroll to zoom, ⌥-scroll to pan"
        // Double-click puts the magnification back to fitting the selection,
        // which is the one thing a zoomed track has no other way back to.
        onDoubleClick={() => setManual(null)}
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
            style={{ left: `${edge === 'start' ? startPct : endPct}%` }}
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
