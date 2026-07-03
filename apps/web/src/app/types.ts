import type { BundleSort, SortOrder, SystemView } from '../api/client'

export type LayoutMode = 'grid' | 'justified' | 'list'

// The browsing/management surfaces: logical (bundle-first), physical
// (filesystem), and the All Tags management page.
export type AppMode = 'collection' | 'file' | 'tags'

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

export interface SortPref {
  sort: BundleSort
  order: SortOrder
}

export interface BrowsePrefs {
  layout: LayoutMode
  zoom: number // target card width in px (grid/justified)
  // The global sort (used when sortScope==='global', and as the fallback for a
  // collection with no remembered sort yet).
  sort: BundleSort
  order: SortOrder
  // When 'collection', each collection/view remembers its own last-used sort in
  // collectionSorts (keyed by collectionSortKey); when 'global', one sort applies
  // everywhere.
  sortScope: 'global' | 'collection'
  collectionSorts: Record<string, SortPref>
}

export const DEFAULT_PREFS: BrowsePrefs = {
  layout: 'grid',
  zoom: 200,
  // Manual is the default order; the persisted pref remembers any later choice.
  sort: 'manual',
  order: 'asc',
  sortScope: 'global',
  collectionSorts: {},
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
  // The file-first "to-bundle queue" (its count is highlighted) sits with the
  // other attention queues, just above Missing Files.
  { view: 'unbundled', label: 'Unbundled', icon: '⚟' },
  { view: 'missing', label: 'Missing Files', icon: '⚠' },
]
