import { useState } from 'react'

/** A row of five clickable stars. Stars 1..`value` render filled; hovering star N
 * previews a fill of 1..N. Picking star N calls `onPick(N)`. Used by the toolbar
 * Rating filter and the Smart Collection editor's rating row. */
export function StarRow({
  value,
  onPick,
  counts,
  ariaLabel = 'Rating',
}: {
  value: number
  onPick: (n: number) => void
  // Optional faceted counts keyed "1".."5" shown under each star.
  counts?: Record<string, number>
  ariaLabel?: string
}) {
  const [hover, setHover] = useState(0)
  // While hovering, fill up to the hovered star; otherwise up to the selected value.
  const filledTo = hover || value
  return (
    <div
      className="stars"
      role="radiogroup"
      aria-label={ariaLabel}
      onMouseLeave={() => setHover(0)}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`star${n <= filledTo ? ' star--on' : ''}`}
          onClick={() => onPick(n)}
          onMouseEnter={() => setHover(n)}
          role="radio"
          aria-checked={n === value}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
        >
          <span className="star__glyph">★</span>
          {counts && <span className="star__count">{counts[String(n)] ?? 0}</span>}
        </button>
      ))}
    </div>
  )
}
