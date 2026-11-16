import { createPortal } from 'react-dom'

import type { SortOrder } from '../api/client'
import type { SortOption } from './types'
import { usePopover } from './usePopover'

interface SortControlProps<T extends string> {
  sort: T
  order: SortOrder
  onChange: (sort: T, order: SortOrder) => void
  /** The sorts this surface offers, in menu order. */
  options: SortOption<T>[]
  // #8: when set, this surface's scope keeps its own last-used sort — a
  // collection in the Bundle Browser, a directory in the File Browser. Omitted
  // where there is no scope to remember against (the unbundled queue).
  perCollection?: boolean
  onPerCollection?: (value: boolean) => void
  /** Wording for that checkbox; the scope has a different name per surface. */
  scopeLabel?: string
}

/**
 * The toolbar sort control: a button showing the active sort that opens a pane
 * with the sort field, an ascending/descending toggle, and (where the surface
 * has collections) a "remember sort per collection" checkbox.
 *
 * Shared by both browsers, which is the point: the File Browser used a bare
 * `<select>` plus a separate arrow button, so the two toolbars neither looked
 * nor behaved alike (owner, 2026-09-01).
 */
export function SortControl<T extends string>({
  sort,
  order,
  onChange,
  options,
  perCollection,
  onPerCollection,
  scopeLabel = 'Remember sort per collection',
}: SortControlProps<T>) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const active = options.find((s) => s.value === sort)
  const label = active?.label ?? 'Sort'
  // Manual has no direction — the arrangement is the order. Offering ascending/
  // descending over it created two readings of one order, and drag-reorder can
  // only be correct under one of them.
  const directionless = active?.directionless === true

  return (
    <div className="picker" ref={ref}>
      <button
        className="seg sortctl__btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Sort"
        title="Sort"
      >
        {label}
        {!directionless && (
          <span className="sortctl__dir" aria-hidden="true">
            {order === 'desc' ? '↓' : '↑'}
          </span>
        )}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel sortctl__panel"
            ref={panelRef}
            style={{ top: pos.top, right: pos.right, bottom: pos.bottom, maxHeight: pos.maxHeight }}
          >
            <SortFields
              sort={sort}
              order={order}
              onChange={onChange}
              options={options}
              perCollection={perCollection}
              onPerCollection={onPerCollection}
              scopeLabel={scopeLabel}
            />
          </div>,
          document.body,
        )}
    </div>
  )
}

/** Sort fields also live inside the combined view-options panel. */
export function SortFields<T extends string>({
  sort,
  order,
  onChange,
  options,
  perCollection,
  onPerCollection,
  scopeLabel = 'Remember sort per collection',
}: SortControlProps<T>) {
  const directionless = options.find((option) => option.value === sort)?.directionless === true
  const scoped = perCollection !== undefined && onPerCollection !== undefined
  return (
    <div role="group" aria-label="Sort">
      <div className="sortctl__section">
        {options.map((s) => (
          <button
            key={s.value}
            aria-pressed={s.value === sort}
            className={`sortctl__opt${s.value === sort ? ' sortctl__opt--on' : ''}`}
            onClick={() => onChange(s.value, order)}
          >
            <span className="sortctl__check" aria-hidden="true">
              {s.value === sort ? '✓' : ''}
            </span>
            {s.label}
          </button>
        ))}
      </div>
      {!directionless && <div className="sortctl__sep" />}
      {!directionless && (
        <div className="sortctl__section sortctl__dirrow" role="group" aria-label="Direction">
          <button
            className={`sortctl__opt${order === 'asc' ? ' sortctl__opt--on' : ''}`}
            onClick={() => onChange(sort, 'asc')}
          >
            <span className="sortctl__check" aria-hidden="true">
              {order === 'asc' ? '✓' : ''}
            </span>
            Ascending ↑
          </button>
          <button
            className={`sortctl__opt${order === 'desc' ? ' sortctl__opt--on' : ''}`}
            onClick={() => onChange(sort, 'desc')}
          >
            <span className="sortctl__check" aria-hidden="true">
              {order === 'desc' ? '✓' : ''}
            </span>
            Descending ↓
          </button>
        </div>
      )}
      {scoped && <div className="sortctl__sep" />}
      {scoped && (
        <label className="sortctl__scope">
          <input
            type="checkbox"
            checked={perCollection}
            onChange={(e) => onPerCollection(e.target.checked)}
          />
          {scopeLabel}
        </label>
      )}
    </div>
  )
}
