import { useState } from 'react'

const DRAG_THRESHOLD = 4 // px of mouse movement before a mousedown becomes a marquee drag
const AUTO_SCROLL_EDGE = 32 // px from the top/bottom edge that triggers auto-scroll
const AUTO_SCROLL_SPEED = 12 // px scrolled per animation frame while in the edge zone

export interface MarqueeRect {
  left: number
  top: number
  width: number
  height: number
}

interface DragState {
  originClientX: number
  originClientY: number
  lastClientX: number
  lastClientY: number
  additive: boolean
  base: Set<string>
  dragging: boolean
  raf: number | null
}

export function rectsIntersect(a: MarqueeRect, b: MarqueeRect): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  )
}

interface UseMarqueeSelectOptions {
  // The scrollable element that clips the view and gets auto-scrolled.
  getScrollEl: () => HTMLElement | null
  // The element whose top-left corner is the origin for marquee-rect math
  // (rendered content coordinates, not viewport coordinates — stays correct
  // regardless of scroll position since it's re-measured on every move).
  getWrapperEl: () => HTMLElement | null
  // False for a mousedown that landed on an item (or a header) — that click is
  // left to the item's own handler instead of starting a drag.
  isBackgroundTarget: (target: HTMLElement) => boolean
  // Ids of every selectable item intersecting the given rect.
  hitTest: (rect: MarqueeRect) => string[]
  // The selection to keep when the drag is additive (shift/ctrl/meta-held).
  getBaseSelection: () => Set<string>
  // Fired continuously while dragging (and once more on mouseup) with the
  // full resulting selection — replaces the current selection wholesale.
  onChange: (ids: string[]) => void
}

/**
 * Left-click-drag rectangle (rubber-band) multi-select, shared by the bundle
 * browser and the file view grid/list. A plain click (no drag, no modifier)
 * on empty space clears the selection instead.
 */
export function useMarqueeSelect(opts: UseMarqueeSelectOptions) {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null)

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    if (!opts.isBackgroundTarget(e.target as HTMLElement)) return
    const scrollEl = opts.getScrollEl()
    const wrapperEl = opts.getWrapperEl()
    if (!scrollEl || !wrapperEl) return

    const scrollbarW = scrollEl.offsetWidth - scrollEl.clientWidth
    if (scrollbarW > 0 && e.clientX > scrollEl.getBoundingClientRect().right - scrollbarW) return

    const additive = e.metaKey || e.ctrlKey || e.shiftKey
    const state: DragState = {
      originClientX: e.clientX,
      originClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      additive,
      base: additive ? new Set(opts.getBaseSelection()) : new Set<string>(),
      dragging: false,
      raf: null,
    }

    // The wrapper's true content size, measured once before any marquee overlay
    // exists. The overlay is an absolutely-positioned child of this element, so
    // if its rect were allowed to grow past this size, `scrollEl`'s scrollable
    // overflow would grow to fit it — inflating the scroll area with empty
    // space, and (since that lets auto-scroll advance further, which in turn
    // lets the rect grow further) runs away without bound. Clamping every
    // content-space point to this fixed size keeps the overlay inside the real
    // content no matter how far the cursor drags beyond it.
    const maxX = wrapperEl.scrollWidth
    const maxY = wrapperEl.scrollHeight

    const toContentPoint = (clientX: number, clientY: number) => {
      const rect = wrapperEl.getBoundingClientRect()
      return {
        x: Math.min(maxX, Math.max(0, clientX - rect.left)),
        y: Math.min(maxY, Math.max(0, clientY - rect.top)),
      }
    }

    const applySelection = () => {
      const start = toContentPoint(state.originClientX, state.originClientY)
      const cur = toContentPoint(state.lastClientX, state.lastClientY)
      const rect: MarqueeRect = {
        left: Math.min(start.x, cur.x),
        top: Math.min(start.y, cur.y),
        width: Math.abs(cur.x - start.x),
        height: Math.abs(cur.y - start.y),
      }
      setMarqueeRect(rect)
      const hitIds = opts.hitTest(rect)
      const finalIds = state.additive ? new Set([...state.base, ...hitIds]) : new Set(hitIds)
      opts.onChange([...finalIds])
    }

    const maybeAutoScroll = () => {
      if (!state.dragging) {
        state.raf = null
        return
      }
      const elRect = scrollEl.getBoundingClientRect()
      let dy = 0
      if (state.lastClientY < elRect.top + AUTO_SCROLL_EDGE) dy = -AUTO_SCROLL_SPEED
      else if (state.lastClientY > elRect.bottom - AUTO_SCROLL_EDGE) dy = AUTO_SCROLL_SPEED
      if (dy !== 0) {
        const before = scrollEl.scrollTop
        scrollEl.scrollTop = Math.max(0, before + dy)
        if (scrollEl.scrollTop !== before) applySelection()
      }
      state.raf = requestAnimationFrame(maybeAutoScroll)
    }

    const onMove = (ev: MouseEvent) => {
      state.lastClientX = ev.clientX
      state.lastClientY = ev.clientY
      if (!state.dragging) {
        const dx = ev.clientX - state.originClientX
        const dy = ev.clientY - state.originClientY
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        state.dragging = true
        state.raf = requestAnimationFrame(maybeAutoScroll)
      }
      ev.preventDefault()
      applySelection()
    }

    // Tear everything down. `fromDrag` = a native HTML5 drag took over (dragging
    // a card/row to move it): it swallows the mouseup that would normally end the
    // marquee, so without this the selection box would stick on screen. In that
    // case we just abandon the marquee (no empty-click deselect).
    const finish = (fromDrag: boolean) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('dragstart', onNativeDrag)
      if (state.raf) cancelAnimationFrame(state.raf)
      if (!fromDrag && !state.dragging && !additive) opts.onChange([])
      setMarqueeRect(null)
    }
    const onUp = () => finish(false)
    const onNativeDrag = () => finish(true)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('dragstart', onNativeDrag)
  }

  return { marqueeRect, onMouseDown }
}
