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

// File Browser navigation: which storage root + relative directory is open.
export interface FileLocation {
  rootId: string | null
  path: string // '' = the storage root itself
}

export interface SortPref {
  sort: BundleSort
  order: SortOrder
}

/** The orders the Recent view offers. Recent is the All view ranked by a date;
 *  which date is the only choice it has to make, so these are the only sorts
 *  that keep the view's name true. */
export const RECENT_SORTS: BundleSort[] = ['date_added', 'date_modified', 'date_opened']

export const PLAYER_SEEK_STEPS = [2, 5, 10, 30] as const
export type PlayerSeekStep = (typeof PLAYER_SEEK_STEPS)[number]

export interface PlayerPrefs {
  volume: number
  muted: boolean
  rate: number
  subtitlesOn: boolean
  seekStep: PlayerSeekStep
  preservesPitch: boolean
}

export interface BrowsePrefs {
  layout: LayoutMode
  zoom: number // target card width in px (grid/justified)
  sidebarVisible: boolean
  inspectorVisible: boolean
  // The global sort (used when sortScope==='global', and as the fallback for a
  // collection with no remembered sort yet).
  sort: BundleSort
  order: SortOrder
  // When 'collection', each collection/view remembers its own last-used sort in
  // collectionSorts (keyed by collectionSortKey); when 'global', one sort applies
  // everywhere.
  sortScope: 'global' | 'collection'
  collectionSorts: Record<string, SortPref>
  player: PlayerPrefs
}

export const DEFAULT_PLAYER_PREFS: PlayerPrefs = {
  volume: 0.85,
  muted: false,
  rate: 1,
  subtitlesOn: true,
  seekStep: 5,
  preservesPitch: true,
}

export const DEFAULT_PREFS: BrowsePrefs = {
  layout: 'grid',
  zoom: 200,
  sidebarVisible: true,
  inspectorVisible: true,
  // Manual is the default order; the persisted pref remembers any later choice.
  sort: 'manual',
  order: 'asc',
  sortScope: 'global',
  collectionSorts: {},
  player: DEFAULT_PLAYER_PREFS,
}

export interface SystemViewDef {
  view: SystemView
  label: string
  icon: string
}

export const SYSTEM_VIEWS: SystemViewDef[] = [
  { view: 'all', label: 'All', icon: '▦' },
  { view: 'recent', label: 'Recent', icon: '🕗' },
  { view: 'uncategorized', label: 'Uncategorized', icon: '◌' },
  { view: 'untagged', label: 'Untagged', icon: '⛉' },
  // The file-first "to-bundle queue" (its count is highlighted) sits with the
  // other attention queues, just above Missing Files.
  { view: 'unbundled', label: 'Unbundled', icon: '⚟' },
  { view: 'missing', label: 'Missing Files', icon: '⚠' },
]
