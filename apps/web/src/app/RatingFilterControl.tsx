import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { useFacets } from '../api/hooks'
import {
  type AdHocFilters,
  type FacetContext,
  type RatingFilter,
  type RatingOp,
  adHocFiltersToExpression,
  combineFilters,
  ratingFilterActive,
  withoutCategory,
} from './adHocFilters'
import { StarRow } from './Stars'
import { usePopover } from './usePopover'

const OPS: { value: RatingOp; label: string; title: string }[] = [
  { value: 'eq', label: '=', title: 'Exactly this rating' },
  { value: 'gte', label: '≥', title: 'This rating or higher' },
  { value: 'lte', label: '≤', title: 'This rating or lower' },
]

const OP_GLYPH: Record<RatingOp, string> = { eq: '=', gte: '≥', lte: '≤' }

function chipLabel(r: RatingFilter | null): string | null {
  if (r === null) return null
  if (r.mode === 'unrated') return 'Unrated'
  return `${OP_GLYPH[r.op]}${r.value}`
}

/**
 * Eagle-style Rating filter: a star row + operator (=, ≥, ≤) and an Unrated row.
 * Clicking the already-selected star (or Unrated again) clears the filter.
 */
export function RatingFilterControl({
  filters,
  onChange,
  ctx,
}: {
  filters: AdHocFilters
  onChange: (f: AdHocFilters) => void
  ctx: FacetContext
}) {
  const rating = filters.rating
  const active = ratingFilterActive(rating)
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const label = chipLabel(rating)

  return (
    <div className="picker" ref={ref}>
      <button
        className={`filter-chip${active ? ' filter-chip--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Filter by rating"
      >
        <span className="filter-chip__icon">★</span>
        Rating
        {label && <span className="filter-chip__badge filter-chip__badge--text">{label}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel rating-filter"
            ref={panelRef}
            style={{ top: pos.top, right: pos.right, bottom: pos.bottom, maxHeight: pos.maxHeight }}
          >
            <RatingFilterPanel filters={filters} onChange={onChange} ctx={ctx} />
          </div>,
          document.body,
        )}
    </div>
  )
}

function RatingFilterPanel({
  filters,
  onChange,
  ctx,
}: {
  filters: AdHocFilters
  onChange: (f: AdHocFilters) => void
  ctx: FacetContext
}) {
  const rating = filters.rating
  const [op, setOp] = useState<RatingOp>(rating?.op ?? 'eq')

  const baseFilter = useMemo(
    () =>
      combineFilters(ctx.smartFilter, adHocFiltersToExpression(withoutCategory(filters, 'rating'))),
    [ctx.smartFilter, filters],
  )
  const facets = useFacets({
    view: ctx.view,
    collectionId: ctx.collectionId,
    includeDescendants: ctx.includeDescendants,
    q: ctx.q,
    filter: baseFilter,
    facets: ['ratings'],
  })
  const counts = facets.data?.ratings ?? {}

  const setRating = (r: RatingFilter | null) => onChange({ ...filters, rating: r })

  const changeOp = (next: RatingOp) => {
    setOp(next)
    if (rating && rating.mode === 'value') setRating({ ...rating, op: next })
  }

  const clickStar = (n: number) => {
    // Clicking the already-selected star clears the filter; otherwise overwrite.
    if (rating && rating.mode === 'value' && rating.value === n) setRating(null)
    else setRating({ mode: 'value', op, value: n })
  }

  const clickUnrated = () => {
    if (rating && rating.mode === 'unrated') setRating(null)
    else setRating({ mode: 'unrated', op, value: rating?.value ?? 0 })
  }

  const starValue = rating && rating.mode === 'value' ? rating.value : 0

  return (
    <>
      <div className="rating-filter__head">
        <span className="rating-filter__title">Rating</span>
        <div className="seg rating-filter__ops" role="group" aria-label="Rating operator">
          {OPS.map((o) => (
            <button
              key={o.value}
              className={op === o.value ? 'is-active' : ''}
              onClick={() => changeOp(o.value)}
              title={o.title}
              aria-pressed={op === o.value}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <StarRow value={starValue} onPick={clickStar} counts={counts} ariaLabel="Rating value" />

      <button
        className={`rating-filter__unrated${rating?.mode === 'unrated' ? ' is-active' : ''}`}
        onClick={clickUnrated}
        aria-pressed={rating?.mode === 'unrated'}
      >
        <span className="pick-row__box">{rating?.mode === 'unrated' ? '✓' : ''}</span>
        Unrated
        <span className="pick-row__count">{counts.unrated ?? 0}</span>
      </button>

      {ratingFilterActive(rating) && (
        <div className="tag-filter__foot">
          <span className="tag-filter__hint">Click the selected star again to clear</span>
          <button
            className="add-btn"
            onClick={() => setRating(null)}
            aria-label="Clear rating filter"
          >
            Clear
          </button>
        </div>
      )}
    </>
  )
}
