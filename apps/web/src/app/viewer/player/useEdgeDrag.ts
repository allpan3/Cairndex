import { useEffect, useRef } from 'react'

import {
  createLeadingTrailingThrottle,
  type LeadingTrailingThrottle,
} from '../../../lib/leadingTrailingThrottle'
import type { ClipEdge } from './clipRange'
import type { ClipRangeController } from './useClipRange'

/**
 * Dragging one end of the marked span, shared by the two tracks that offer it:
 * the seek bar (whole file) and the clip bar's zoomed timeline (a few seconds
 * across the same width). They differ only in how a pointer position becomes a
 * time, which is the `timeFor` the caller supplies.
 *
 * Two rules the callers must not diverge on, which is why this is one function:
 *
 * - the edge commits on **every** pointer move, so the band tracks the pointer;
 * - the seek that previews the edge's frame is **throttled**, because each one
 *   cancels the in-flight byte range and opens another (`SeekBar`'s original
 *   reason for the same throttle).
 */
const EDGE_SEEK_THROTTLE_MS = 150

interface UseEdgeDragOptions {
  clip: ClipRangeController | undefined
  /** Map a client X coordinate to a time on this track. */
  timeFor: (clientX: number) => number
  /** Cache track geometry for the length of the gesture, and release it after. */
  onGestureStart?: () => void
  onGestureEnd?: () => void
  onDragChange?: (dragging: boolean) => void
}

export function useEdgeDrag({
  clip,
  timeFor,
  onGestureStart,
  onGestureEnd,
  onDragChange,
}: UseEdgeDragOptions): (edge: ClipEdge) => (event: React.PointerEvent) => void {
  const seek = useRef<LeadingTrailingThrottle<{ edge: ClipEdge; time: number }> | null>(null)
  const cleanup = useRef<(() => void) | null>(null)

  // Live refs: a gesture outlives the render that started it, and a trailing
  // flush must not call into a stale controller.
  const latest = useRef({ clip, timeFor, onGestureStart, onGestureEnd, onDragChange })
  useEffect(() => {
    latest.current = { clip, timeFor, onGestureStart, onGestureEnd, onDragChange }
  })

  useEffect(() => {
    const throttle = createLeadingTrailingThrottle(
      EDGE_SEEK_THROTTLE_MS,
      // Re-committing the same edge at the same time is a no-op on an already
      // clamped range; what this call is actually for is the seek.
      ({ edge, time }: { edge: ClipEdge; time: number }) => {
        latest.current.clip?.moveTo(edge, time)
      },
    )
    seek.current = throttle
    return () => {
      throttle.cancel()
      seek.current = null
      cleanup.current?.()
    }
  }, [])

  return (edge: ClipEdge) => (event: React.PointerEvent) => {
    const { clip: controller } = latest.current
    if (event.button !== 0 || !controller) return
    // The handles sit on top of their track; without this the same press also
    // starts an ordinary scrub, which then fights the edge being dragged.
    event.stopPropagation()
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    latest.current.onGestureStart?.()
    controller.setAdjusting(true)
    latest.current.onDragChange?.(true)

    const apply = (clientX: number, flush: boolean) => {
      const time = latest.current.timeFor(clientX)
      // Commit without seeking so the band is live, then let the throttle own
      // the seek that actually shows the frame.
      latest.current.clip?.moveTo(edge, time, { scrub: false })
      if (flush) seek.current?.flush({ edge, time })
      else seek.current?.schedule({ edge, time })
    }
    apply(event.clientX, true)

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return
      apply(moveEvent.clientX, false)
    }
    const removeListeners = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      latest.current.onGestureEnd?.()
      latest.current.clip?.setAdjusting(false)
      latest.current.onDragChange?.(false)
      cleanup.current = null
    }
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return
      apply(endEvent.clientX, true)
      if (handle.hasPointerCapture?.(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId)
      }
      removeListeners()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    cleanup.current = removeListeners
  }
}
