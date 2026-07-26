import { createPortal } from 'react-dom'

import type { BundleSort, SortOrder } from '../api/client'
import { usePopover } from './usePopover'

// Manual first (the default order); the rest mirror the previous toolbar list.
const SORTS: { value: BundleSort; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'date_added', label: 'Date Added' },
  { value: 'date_modified', label: 'Date Modified' },
  { value: 'date_opened', label: 'Date Opened' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Rating' },
  { value: 'size', label: 'Size' },
  { value: 'file_count', label: 'File Count' },
]

interface SortControlProps {
  sort: BundleSort
  order: SortOrder
  onChange: (sort: BundleSort, order: SortOrder) => void
  /** Restricts the offered sorts. The Recent view passes the date orders: what
   *  makes it "recent" is *which* date it ranks by, so Title or Size there would
   *  just be the All view under another name. Omitted = every sort. */
  allowed?: BundleSort[]
  // #8: when true, each collection/view keeps its own last-used sort.
  perCollection: boolean
  onPerCollection: (value: boolean) => void
}

/**
 * The toolbar sort control: a button showing the active sort that opens a pane
 * with the sort field, an ascending/descending toggle, and a "remember per
 * collection" checkbox. Replaces the old inline sort <select> + order button.
 */
export function SortControl({
  sort,
  order,
  onChange,
  allowed,
  perCollection,
  onPerCollection,
}: SortControlProps) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const sorts = allowed ? SORTS.filter((s) => allowed.includes(s.value)) : SORTS
  const label = SORTS.find((s) => s.value === sort)?.label ?? 'Sort'
  // Manual has no direction — the arrangement is the order. Offering ascending/
  // descending over it created two readings of one order, and drag-reorder can
  // only be correct under one of them.
  const directionless = sort === 'manual'

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
            <div className="sortctl__section">
              {sorts.map((s) => (
                <button
                  key={s.value}
                  className={`sortctl__opt${s.value === sort ? ' sortctl__opt--on' : ''}`}
                  onClick={() => onChange(s.value, order)}
                >
                  <span className="sortctl__check">{s.value === sort ? '✓' : ''}</span>
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
                  <span className="sortctl__check">{order === 'asc' ? '✓' : ''}</span>
                  Ascending ↑
                </button>
                <button
                  className={`sortctl__opt${order === 'desc' ? ' sortctl__opt--on' : ''}`}
                  onClick={() => onChange(sort, 'desc')}
                >
                  <span className="sortctl__check">{order === 'desc' ? '✓' : ''}</span>
                  Descending ↓
                </button>
              </div>
            )}
            <div className="sortctl__sep" />
            <label className="sortctl__scope">
              <input
                type="checkbox"
                checked={perCollection}
                onChange={(e) => onPerCollection(e.target.checked)}
              />
              Remember sort per collection
            </label>
          </div>,
          document.body,
        )}
    </div>
  )
}
