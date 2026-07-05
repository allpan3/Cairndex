import { useEffect, useState, type RefObject } from 'react'

/** Auto-hide viewer chrome after pointer idle; moving the pointer shows it. */
export function useIdleHide(rootRef: RefObject<HTMLElement | null>, delayMs = 2600) {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let timer = window.setTimeout(() => setIdle(true), delayMs)
    const wake = () => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), delayMs)
    }
    root.addEventListener('pointermove', wake)
    root.addEventListener('pointerdown', wake)
    return () => {
      window.clearTimeout(timer)
      root.removeEventListener('pointermove', wake)
      root.removeEventListener('pointerdown', wake)
    }
  }, [delayMs, rootRef])

  return idle
}
