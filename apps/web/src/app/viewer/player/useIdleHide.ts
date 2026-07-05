import { useEffect, useState } from 'react'

/** Auto-hide viewer chrome after pointer idle; moving the pointer shows it. */
export function useIdleHide(active: boolean, delayMs = 1800) {
  const [idle, setIdle] = useState(false)

  useEffect(() => {
    if (!active) return
    let timer = window.setTimeout(() => setIdle(true), delayMs)
    const wake = () => {
      setIdle(false)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setIdle(true), delayMs)
    }
    window.addEventListener('mousemove', wake)
    window.addEventListener('mousedown', wake)
    window.addEventListener('keydown', wake)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', wake)
      window.removeEventListener('mousedown', wake)
      window.removeEventListener('keydown', wake)
    }
  }, [active, delayMs])

  return active && idle
}
