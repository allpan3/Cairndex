import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Kept between the text and the window's edge, and between the text and its button
const MARGIN = 8
const GAP = 4
// Long enough for the pointer to cross from the button onto the text
const LEAVE_DELAY = 150

/**
 * A longer explanation on demand, so the visible description can stay short
 * (owner, 2026-10-27).
 *
 * Unlike a native `title`, it is reachable from the keyboard: focusing the
 * button shows the text, Escape hides it without closing the dialog around it,
 * and the text is the button's accessible description whether it is shown or
 * not. The pointer can move onto the text without losing it.
 *
 * The text is portalled and `fixed`, like `usePopover`'s panels, so a scrolling
 * dialog body cannot clip it, and it is kept inside the window. It is placed
 * again on every frame while shown, because not everything that moves or hides
 * its button sends an event: content above it can grow, and a dialog can hide
 * the list it sits in. While the button is out of sight, so is the text.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)
  const leaving = useRef<number | undefined>(undefined)
  const [focused, setFocused] = useState(false)
  const [hovered, setHovered] = useState(false)
  // Escape hides the text until the pointer or focus comes back
  const [dismissed, setDismissed] = useState(false)
  const open = (focused || hovered) && !dismissed

  const enter = () => {
    window.clearTimeout(leaving.current)
    setHovered(true)
    setDismissed(false)
  }
  const leave = () => {
    window.clearTimeout(leaving.current)
    leaving.current = window.setTimeout(() => setHovered(false), LEAVE_DELAY)
  }
  useEffect(() => () => window.clearTimeout(leaving.current), [])

  // Before paint, so the text never shows where it was last placed
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const follow = () => {
      if (button.current && bubble.current) place(button.current, bubble.current)
      frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!open) return
    // Captured, as in usePopover, so the dialog behind never sees this Escape.
    // Text out of sight does not claim it: the owner cannot see what it closes.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || bubble.current?.style.visibility === 'hidden') return
      event.preventDefault()
      event.stopPropagation()
      setDismissed(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <>
      <button
        ref={button}
        type="button"
        className="info-tip"
        aria-label={label}
        aria-describedby={id}
        onFocus={() => {
          setFocused(true)
          setDismissed(false)
        }}
        onBlur={() => setFocused(false)}
        // Only ever shows: a click also focuses, and toggling would hide it again
        onClick={() => setDismissed(false)}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        i
      </button>
      {createPortal(
        <span
          ref={bubble}
          id={id}
          role="tooltip"
          className="info-tip__bubble"
          hidden={!open}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {children}
        </span>,
        document.body,
      )}
    </>
  )
}

/** Below the button when the text fits there, else above; always inside the window. */
function place(anchor: HTMLElement, text: HTMLElement) {
  const box = anchor.getBoundingClientRect()
  if (!inSight(anchor, box)) {
    text.style.visibility = 'hidden'
    return
  }
  const { offsetWidth: width, offsetHeight: height } = text
  const below = window.innerHeight - box.bottom - GAP - MARGIN
  const above = box.top - GAP - MARGIN
  const top = below >= height || below >= above ? box.bottom + GAP : box.top - GAP - height
  text.style.top = `${clamp(top, MARGIN, window.innerHeight - height - MARGIN)}px`
  // Starts under the button, moved left only as far as the window needs
  text.style.left = `${clamp(box.left - 6, MARGIN, window.innerWidth - width - MARGIN)}px`
  text.style.visibility = 'visible'
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max))

/** Whether any of the button shows: inside the window and every box that clips it. */
function inSight(anchor: HTMLElement, box: DOMRect): boolean {
  // No box at all: something above it is not rendered
  if (box.width === 0 && box.height === 0) return false
  let top = Math.max(box.top, 0)
  let left = Math.max(box.left, 0)
  let bottom = Math.min(box.bottom, window.innerHeight)
  let right = Math.min(box.right, window.innerWidth)
  for (let node = anchor.parentElement; node; node = node.parentElement) {
    const { overflowX, overflowY, position } = getComputedStyle(node)
    if (overflowX !== 'visible' || overflowY !== 'visible') {
      const clip = node.getBoundingClientRect()
      top = Math.max(top, clip.top)
      left = Math.max(left, clip.left)
      bottom = Math.min(bottom, clip.bottom)
      right = Math.min(right, clip.right)
    }
    // The boxes around a fixed one, such as a dialog's backdrop, do not clip it
    if (position === 'fixed') break
  }
  return top < bottom && left < right
}
