import { createPortal } from 'react-dom'

import type { BundleSort, SortOrder } from '../api/client'
import { usePopover } from './usePopover'

// Manual first (the default order); the rest mirror the previous toolbar list.
const SORTS: { value: BundleSort; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'date_added', label: 'Date Added' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Rating' },
  { value: 'size', label: 'Size' },
  { value: 'file_count', label: 'File Count' },
]

interface SortControlProps {
  sort: BundleSort
  order: SortOrder
  onChange: (sort: BundleSort, order: SortOrder) => void
  /** Set when the view *is* its sort (Recently Added). The control stays visible
   *  but does not open, and says why: a control that vanishes reads as a feature
   *  that broke, where a disabled one reads as a rule. */
  lockedReason?: string
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
  lockedReason,
  perCollection,
  onPerCollection,
}: SortControlProps) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const label = SORTS.find((s) => s.value === sort)?.label ?? 'Sort'

  return (
    <div className="picker" ref={ref}>
      <button
        className="seg sortctl__btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Sort"
        disabled={lockedReason !== undefined}
        title={lockedReason ?? 'Sort'}
      >
        {label}
        <span className="sortctl__dir" aria-hidden="true">
          {order === 'desc' ? '↓' : '↑'}
        </span>
      </button>
      {open &&
        lockedReason === undefined &&
        pos &&
        createPortal(
          <div
            className="picker__panel sortctl__panel"
            ref={panelRef}
            style={{ top: pos.top, right: pos.right, bottom: pos.bottom, maxHeight: pos.maxHeight }}
          >
            <div className="sortctl__section">
              {SORTS.map((s) => (
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
            <div className="sortctl__sep" />
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
