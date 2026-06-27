import type { BundleSort, SortOrder, SystemView } from '../api/client'

export type LayoutMode = 'grid' | 'justified' | 'list'

// The two browsing surfaces: logical (bundle-first) vs. physical (filesystem).
export type AppMode = 'collection' | 'file'

export interface Selection {
  view: SystemView
  collectionId: string | null
  smartCollectionId?: string | null
}

// File View navigation: which storage root + relative directory is open.
export interface FileLocation {
  rootId: string | null
  path: string // '' = the storage root itself
}

export interface BrowsePrefs {
  layout: LayoutMode
  zoom: number // target card width in px (grid/justified)
  sort: BundleSort
  order: SortOrder
}

export const DEFAULT_PREFS: BrowsePrefs = {
  layout: 'grid',
  zoom: 200,
  sort: 'date_added',
  order: 'desc',
}

export interface SystemViewDef {
  view: SystemView
  label: string
  icon: string
}

export const SYSTEM_VIEWS: SystemViewDef[] = [
  { view: 'all', label: 'All', icon: '▦' },
  { view: 'recent', label: 'Recently Added', icon: '🕗' },
  { view: 'uncategorized', label: 'Uncategorized', icon: '◌' },
  { view: 'untagged', label: 'Untagged', icon: '⛉' },
  { view: 'missing', label: 'Missing Files', icon: '⚠' },
]
