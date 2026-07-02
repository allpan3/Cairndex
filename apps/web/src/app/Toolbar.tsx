import { useState } from 'react'

import type { BundleSort } from '../api/client'
import { type AdHocFilters, type FacetContext, anyAdHocActive } from './adHocFilters'
import { IconFilter } from './icons'
import { RatingFilterControl } from './RatingFilterControl'
import { TagFilterControl } from './TagFilterControl'
import type { BrowsePrefs, LayoutMode } from './types'

interface ToolbarProps {
  title: string
  total: number
  search: string
  onSearch: (value: string) => void
  prefs: BrowsePrefs
  onPrefs: (prefs: BrowsePrefs) => void
  // Ad-hoc toolbar filters (local UI state; see app/adHocFilters.ts).
  adHocFilters: AdHocFilters
  onAdHocFilters: (f: AdHocFilters) => void
  facetContext: FacetContext
}

const SORTS: { value: BundleSort; label: string }[] = [
  { value: 'date_added', label: 'Date Added' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Rating' },
  { value: 'size', label: 'Size' },
  { value: 'file_count', label: 'File Count' },
]

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
      <div className="toolbar">
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

        <select
          value={prefs.sort}
          onChange={(e) => onPrefs({ ...prefs, sort: e.target.value as BundleSort })}
          aria-label="Sort by"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          className="seg"
          style={{ padding: '5px 8px', cursor: 'pointer' }}
          onClick={() => onPrefs({ ...prefs, order: prefs.order === 'desc' ? 'asc' : 'desc' })}
          aria-label="Toggle sort order"
          title="Toggle sort order"
        >
          {prefs.order === 'desc' ? '↓' : '↑'}
        </button>

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
            min={120}
            max={360}
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
