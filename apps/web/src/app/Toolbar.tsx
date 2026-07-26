import { useState } from 'react'

import type { BundleSort, SortOrder } from '../api/client'
import { type AdHocFilters, type FacetContext, anyAdHocActive } from './adHocFilters'
import { IconFilter } from './icons'
import { ZOOM_MAX, ZOOM_MIN } from './layout'
import { RatingFilterControl } from './RatingFilterControl'
import { SortControl } from './SortControl'
import { TagFilterControl } from './TagFilterControl'
import type { BrowsePrefs, LayoutMode } from './types'

interface ToolbarProps {
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

const LAYOUTS: { value: LayoutMode; icon: string; label: string }[] = [
  { value: 'grid', icon: '▦', label: 'Grid' },
  { value: 'justified', icon: '▥', label: 'Justified' },
  { value: 'list', icon: '☰', label: 'List' },
]

export function Toolbar({
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

  return (
    <>
      <div className="toolbar" data-tauri-drag-region="deep">
        <span className="toolbar__title">{title}</span>
        <span className="toolbar__count">{total.toLocaleString()} items</span>
        <span className="toolbar__spacer" />

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

        <SortControl
          sort={sort}
          order={order}
          onChange={onSort}
          allowed={allowedSorts}
          perCollection={perCollectionSort}
          onPerCollection={onPerCollectionSort}
        />

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
