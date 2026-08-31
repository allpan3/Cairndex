import { useEffect, useState, type RefObject } from 'react'

/**
 * The chrome this hides, and so the chrome a resting pointer has to protect.
 * Kept in step with the `.media-viewer--idle` rules in the stylesheet: those set
 * `pointer-events: none` as well as `opacity: 0`, which is what makes hiding a
 * control under the cursor worse than cosmetic.
 */
const HOVERED_CHROME = ['.mv-topbar', '.mv-controls', '.mv-resume', '.mv-nav']
  .map((selector) => `${selector}:hover`)
  .join(', ')

/** Auto-hide viewer chrome after pointer idle; moving, pressing or scrolling
 *  the pointer shows it again. */
export function useIdleHide(
  rootRef: RefObject<HTMLElement | null>,
  pinned = false,
  delayMs = 2600,
) {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (pinned) return
    /**
     * Go idle, unless the pointer is resting on a control.
     *
     * Hiding the chrome also makes it `pointer-events: none`, so the click that
     * follows passes straight through to the video and is spent waking the
     * chrome rather than pressing the button that was under the cursor. The
     * owner reported it as the first click on Save Moment doing nothing and the
     * second one working (2026-08-30) — true of every control in the bar, and
     * the same root cause as the wheel-zoom case below.
     *
     * A pointer that has settled on a control is someone reading it before
     * pressing it, which is the opposite of idle. `:hover` is the browser's own
     * answer to "is the pointer there", and it is accurate here because the
     * chrome is still interactive at the moment this runs.
     */
    const sleep = () => {
      if (root.querySelector(HOVERED_CHROME)) {
        timer = window.setTimeout(sleep, delayMs)
        return
      }
      setIdle(true)
    }
    let timer = window.setTimeout(sleep, delayMs)
    const wake = () => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(sleep, delayMs)
    }
    root.addEventListener('pointermove', wake)
    root.addEventListener('pointerdown', wake)
    // A wheel is the owner working the controls just as much as a move is —
    // zooming the range track with the wheel let the chrome idle out from under
    // the pointer mid-adjustment (owner, 2026-08-30). Passive: this only
    // watches, and the zoom's own listener is the one that may preventDefault.
    root.addEventListener('wheel', wake, { passive: true })
    return () => {
      window.clearTimeout(timer)
      root.removeEventListener('pointermove', wake)
      root.removeEventListener('pointerdown', wake)
      root.removeEventListener('wheel', wake)
    }
  }, [delayMs, pinned, rootRef])

  return pinned ? false : idle
}
