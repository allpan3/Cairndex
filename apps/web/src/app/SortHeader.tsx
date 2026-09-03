import type { SortOrder } from '../api/client'

/**
 * One clickable column header in a list view.
 *
 * Clicking a column sorts by it; clicking the column already sorted by flips
 * the direction. Switching columns keeps the current direction rather than
 * resetting it, so "biggest first" survives a hop from Size to Date (owner,
 * 2026-09-01). Both browsers use this, so the two list views answer a header
 * click the same way.
 */
export function SortHeaderCell<T extends string>({
  label,
  value,
  sort,
  order,
  onSort,
  className,
}: {
  label: string
  /** The sort this column applies. */
  value: T
  /** The sort currently in force (may be another column's, or none of them). */
  sort: T
  order: SortOrder
  onSort: (sort: T, order: SortOrder) => void
  className?: string
}) {
  const active = sort === value
  return (
    <span
      role="columnheader"
      className={className}
      aria-sort={active ? (order === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className={`colhead${active ? ' colhead--on' : ''}`}
        onClick={() => onSort(value, active && order === 'asc' ? 'desc' : active ? 'asc' : order)}
        // The visible text is the column name; the accessible name says what
        // pressing it does, since the direction arrow beside it does not read.
        aria-label={`Sort by ${label}`}
        title={`Sort by ${label}`}
      >
        {label}
        <span className="colhead__dir" aria-hidden="true">
          {active ? (order === 'desc' ? '↓' : '↑') : ''}
        </span>
      </button>
    </span>
  )
}
