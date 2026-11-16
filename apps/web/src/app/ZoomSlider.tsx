import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The item-size slider. With `onPreview`, a pointer drag reports each value
 * there and commits once, on release, so a large grid lays itself out once per
 * gesture instead of once per step. Keyboard steps and a click without a drag
 * commit at once, as without `onPreview`.
 */
export function ZoomSlider({
  value,
  min,
  max,
  label = 'Zoom',
  onPreview,
  onCommit,
}: {
  value: number
  min: number
  max: number
  label?: string
  /** A dragged value, then null once the drag ends (before any commit) */
  onPreview?: (value: number | null) => void
  onCommit: (value: number) => void
}) {
  const [live, setLive] = useState<number | null>(null)
  // The drag's state lives outside React: a release must commit the value the
  // last input event carried, even before React has rendered it
  const drag = useRef<{ active: boolean; value: number | null }>({ active: false, value: null })
  const latest = useRef({ value, onPreview, onCommit })
  useLayoutEffect(() => {
    latest.current = { value, onPreview, onCommit }
  })
  // A drag can end anywhere in the window, or by the window losing focus
  useEffect(() => {
    const end = () => {
      if (!drag.current.active) return
      const next = drag.current.value
      drag.current = { active: false, value: null }
      setLive(null)
      const { value: current, onPreview: preview, onCommit: done } = latest.current
      preview?.(null)
      if (next !== null && next !== current) done(next)
    }
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      window.removeEventListener('blur', end)
    }
  }, [])
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={10}
      value={live ?? value}
      aria-label={label}
      onPointerDown={() => {
        if (onPreview) drag.current = { active: true, value: null }
      }}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (drag.current.active) {
          drag.current.value = next
          setLive(next)
          onPreview?.(next)
        } else onCommit(next)
      }}
    />
  )
}
