import type { BundleSort } from '../api/client'
import type { BrowsePrefs, LayoutMode } from './types'

interface ToolbarProps {
  title: string
  total: number
  search: string
  onSearch: (value: string) => void
  prefs: BrowsePrefs
  onPrefs: (prefs: BrowsePrefs) => void
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

export function Toolbar({ title, total, search, onSearch, prefs, onPrefs }: ToolbarProps) {
  return (
    <div className="toolbar">
      <span className="toolbar__title">{title}</span>
      <span className="toolbar__count">{total.toLocaleString()} items</span>
      <span className="toolbar__spacer" />

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

      {prefs.layout !== 'list' && (
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
      )}
    </div>
  )
}
