/** A row of five clickable stars. Stars 1..`value` render filled; picking star
 * N calls `onPick(N)`. Used by the toolbar Rating filter and the Smart
 * Collection editor's rating row so both share one star affordance. */
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
  return (
    <div className="stars" role="radiogroup" aria-label={ariaLabel}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`star${n <= value ? ' star--on' : ''}`}
          onClick={() => onPick(n)}
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
