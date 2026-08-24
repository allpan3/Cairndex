import { useState, type ReactNode } from 'react'

import type { BundleSort, SortOrder } from '../api/client'
import { type AdHocFilters, type FacetContext, anyAdHocActive } from './adHocFilters'
import { IconFilter } from './icons'
import { ZOOM_MAX, ZOOM_MIN } from './layout'
import { RatingFilterControl } from './RatingFilterControl'
import { SortControl } from './SortControl'
import { TagFilterControl } from './TagFilterControl'
import type { BrowsePrefs, LayoutMode } from './types'

interface ToolbarProps {
  /** Leading controls before the title — the Back/Forward history buttons. */
  leading?: ReactNode
  /**
   * Set in the Random view: adds a Reshuffle button and drops the sort control —
   * explicit sorting would just un-shuffle the one thing the view is for.
   */
  onReshuffle?: () => void
  title: string
  total: number
  search: string
  onSearch: (value: string) => void
  // prefs drives layout + zoom; the sort is passed separately (App resolves it
  // from the global-or-per-collection scope).
  prefs: BrowsePrefs
  onPrefs: (prefs: BrowsePrefs) => void
  sort: BundleSort
  order: SortOrder
  onSort: (sort: BundleSort, order: SortOrder) => void
  /** Restricts which sorts the control offers (the Recent view: date orders). */
  allowedSorts?: BundleSort[]
  perCollectionSort: boolean
  onPerCollectionSort: (value: boolean) => void
  // Ad-hoc toolbar filters (local UI state; see app/adHocFilters.ts).
  adHocFilters: AdHocFilters
  onAdHocFilters: (f: AdHocFilters) => void
  facetContext: FacetContext
}

// "Card" rather than "Grid" (owner, 2026-08-23): both this and Justified are
// grids, and what distinguishes this one is that every item is a card of one
// fixed shape. The stored `LayoutMode` value stays `'grid'` — it is a persisted
// preference and an e2e selector, and renaming it would buy nothing a label
// cannot.
const LAYOUTS: { value: LayoutMode; icon: string; label: string }[] = [
  { value: 'grid', icon: '▦', label: 'Card' },
  { value: 'justified', icon: '▥', label: 'Justified' },
  { value: 'list', icon: '☰', label: 'List' },
]

export function Toolbar({
  leading,
  onReshuffle,
  title,
  total,
  search,
  onSearch,
  prefs,
  onPrefs,
  sort,
  order,
  onSort,
  allowedSorts,
  perCollectionSort,
  onPerCollectionSort,
  adHocFilters,
  onAdHocFilters,
  facetContext,
}: ToolbarProps) {
  const filtersActive = anyAdHocActive(adHocFilters)
  // The second filter row starts open when a filter is already active, so a
  // filtered view doesn't hide its own controls.
  const [filtersOpen, setFiltersOpen] = useState(filtersActive)
  // …and it *reveals itself* when a filter turns on from elsewhere — a tag
  // pill's "Filter Items" lands here with the row closed, and an active filter
  // with no visible controls looks like the library shrank on its own (owner,
  // 2026-07-27). Compared during render, so nothing flashes.
  const [wasActive, setWasActive] = useState(filtersActive)
  if (wasActive !== filtersActive) {
    setWasActive(filtersActive)
    if (filtersActive) setFiltersOpen(true)
  }

  return (
    <>
      <div className="toolbar" data-tauri-drag-region="deep">
        {leading}
        <span className="toolbar__title">{title}</span>
        <span className="toolbar__count">{total.toLocaleString()} items</span>
        <span className="toolbar__spacer" />

        {/* Actions sit left of the resident controls, which is where the File
            Browser and Trash toolbars already put theirs: the residents are
            furniture the owner learns the position of, so an action appearing
            or disappearing between them shifts every one of them (owner,
            2026-08-23). Reshuffle used to occupy the sort control's slot for
            exactly the reason it replaces it — Random has no sort — but that put
            it in the middle of the row. */}
        {onReshuffle && (
          <button
            className="seg toolbar__reshuffle"
            onClick={onReshuffle}
            aria-label="Reshuffle"
            title="Reshuffle"
          >
            ↺ Shuffle
          </button>
        )}

        <button
          className={`seg toolbar__filter-toggle${filtersOpen ? ' is-active' : ''}`}
          onClick={() => setFiltersOpen((o) => !o)}
          aria-label="Filters"
          aria-pressed={filtersOpen}
          title="Filters"
        >
          <IconFilter />
          {filtersActive && <span className="toolbar__filter-dot" />}
        </button>

        <input
          type="search"
          placeholder="Search library…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Search"
          title="Search titles, filenames, tags, and collections across the whole library"
        />

        {/* No sort in Random: explicit sorting would un-shuffle the one thing
            the view is for. The Reshuffle button above stands in its place. */}
        {!onReshuffle && (
          <SortControl
            sort={sort}
            order={order}
            onChange={onSort}
            allowed={allowedSorts}
            perCollection={perCollectionSort}
            onPerCollection={onPerCollectionSort}
          />
        )}

        <div className="seg" role="group" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.value}
              className={prefs.layout === l.value ? 'is-active' : ''}
              onClick={() => onPrefs({ ...prefs, layout: l.value })}
              title={l.label}
              aria-label={l.label}
              aria-pressed={prefs.layout === l.value}
            >
              {l.icon}
            </button>
          ))}
        </div>

        {/* Always shown (even in list view, where it drives row height) so the
            controls to its left don't shift when switching layouts. */}
        <div className="zoom">
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={10}
            value={prefs.zoom}
            onChange={(e) => onPrefs({ ...prefs, zoom: Number(e.target.value) })}
            aria-label="Zoom"
          />
        </div>
      </div>

      {filtersOpen && (
        <div className="filterbar" role="group" aria-label="Filters">
          <span className="filterbar__label">Filter</span>
          <TagFilterControl filters={adHocFilters} onChange={onAdHocFilters} ctx={facetContext} />
          <RatingFilterControl
            filters={adHocFilters}
            onChange={onAdHocFilters}
            ctx={facetContext}
          />
          {filtersActive && (
            <button
              className="filterbar__clear"
              onClick={() =>
                onAdHocFilters({
                  tags: { rule: 'any', includeDescendants: true, include: [], exclude: [] },
                  rating: null,
                })
              }
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </>
  )
}
