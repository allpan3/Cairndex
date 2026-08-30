import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { scrollTopForDrag, thumbGeometry } from './scrollThumb'

/**
 * A scrollbar that lies over its panel instead of beside it.
 *
 * Rendered as the **first child** of the element it scrolls, and it takes that
 * element from its own `parentElement` rather than a ref, so a panel opts in by
 * adding one line and nothing has to be threaded through the tree.
 *
 * Why this exists at all: a native scrollbar paints in the gutter, *outside* the
 * content box, so it always costs width — 16px here. Reserving that permanently
 * (`scrollbar-gutter: stable`) trades a jump for a constant loss, and the owner
 * wanted neither (2026-08-29). `overflow: overlay` would have done it in one
 * line but has been removed from Chromium. So: hide the engine's bar, and draw
 * one that costs nothing.
 *
 * The thumb hangs off a zero-height `position: sticky` anchor, which pins it to
 * the top of the *visible* area of the scroller — an absolutely positioned child
 * would scroll away with the content, since a scroller's containing block is its
 * full scroll height rather than its viewport.
 */
export function OverlayScrollbar() {
  const anchor = useRef<HTMLDivElement>(null)
  const [thumb, setThumb] = useState<{ height: number; offset: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useLayoutEffect(() => {
    const scroller = anchor.current?.parentElement
    if (!scroller) return
    let frame = 0
    const measure = () =>
      setThumb(thumbGeometry(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight))
    // Coalesced: scroll and mutation both fire in bursts, and the thumb only
    // has to be right once per frame.
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    scroller.addEventListener('scroll', schedule, { passive: true })
    // The panel's own box, for a window or splitter resize…
    const resize = new ResizeObserver(schedule)
    resize.observe(scroller)
    // …and its contents, which change height without changing the panel's box:
    // opening a folder row is exactly that.
    const mutate = new MutationObserver(schedule)
    mutate.observe(scroller, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      resize.disconnect()
      mutate.disconnect()
    }
  }, [])

  // Dragging the thumb, because a bar you cannot drag is a worse scrollbar than
  // the one it replaced.
  useEffect(() => {
    if (!dragging) return
    const scroller = anchor.current?.parentElement
    if (!scroller) return
    const onMove = (event: PointerEvent) => {
      const { top, height } = scroller.getBoundingClientRect()
      const geometry = thumbGeometry(
        scroller.scrollTop,
        scroller.scrollHeight,
        scroller.clientHeight,
      )
      if (!geometry) return
      scroller.scrollTop = scrollTopForDrag(
        event.clientY,
        top,
        height,
        geometry.height,
        scroller.scrollHeight,
      )
    }
    const stop = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [dragging])

  return (
    <div ref={anchor} className="oscroll" aria-hidden="true">
      {thumb && (
        <div
          className={`oscroll__thumb${dragging ? ' oscroll__thumb--dragging' : ''}`}
          style={{ height: `${thumb.height}px`, transform: `translateY(${thumb.offset}px)` }}
          onPointerDown={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
        />
      )}
    </div>
  )
}
