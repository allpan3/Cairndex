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

/** A sort and its direction. Defaults to the bundle sorts, since that is most
 *  of its use; the File Browser parameterizes it with its own field set. */
export interface SortPref<T extends string = BundleSort> {
  sort: T
  order: SortOrder
}

/** One entry in a surface's sort menu (`SortControl`, and the list views'
 *  clickable column headers). `directionless` marks a sort with no ascending/
 *  descending reading — Manual, where the arrangement *is* the order. */
export interface SortOption<T extends string> {
  value: T
  label: string
  directionless?: boolean
}

/** The bundle browser's sorts, in menu order. Manual first: it is the default,
 *  and it is the order new bundles arrive at the front of. */
export const BUNDLE_SORTS: SortOption<BundleSort>[] = [
  { value: 'manual', label: 'Manual', directionless: true },
  { value: 'date_added', label: 'Date Added' },
  { value: 'date_modified', label: 'Date Modified' },
  { value: 'date_opened', label: 'Date Opened' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Rating' },
  { value: 'size', label: 'Size' },
  { value: 'file_count', label: 'File Count' },
]

/** The orders the Recent view offers. Recent is the All view ranked by a date;
 *  which date is the only choice it has to make, so these are the only sorts
 *  that keep the view's name true. */
export const RECENT_SORTS: BundleSort[] = ['date_added', 'date_modified', 'date_opened']

/** What every other view offers — the date orders are Recent's whole reason to
 *  exist, so repeating them elsewhere just gives two ways to reach one result.
 *  Manual is the default, and newly added bundles arrive at its front. */
export const STANDARD_SORTS: BundleSort[] = ['manual', 'title', 'rating', 'size', 'file_count']

export const PLAYER_SEEK_STEPS = [2, 5, 10, 30] as const
export type PlayerSeekStep = (typeof PLAYER_SEEK_STEPS)[number]

export interface PlayerPrefs {
  volume: number
  muted: boolean
  rate: number
  subtitlesOn: boolean
  seekStep: PlayerSeekStep
  preservesPitch: boolean
  // Whether the viewer's media-info panel (metadata + playlist) is open.
  // Persisted like the rest, so it stays where it was left across files.
  infoOpen: boolean
  // Whether the viewer's bundle-inspector rail is expanded — the same inspector
  // as the main shell, on its own toggle (owner, 2026-07-27: the two are
  // different things and each wants its own control).
  inspectorOpen: boolean
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
  infoOpen: false,
  inspectorOpen: false,
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
  // Every bundle in a seeded shuffle — browse-by-serendipity (owner, 2026-07-27).
  { view: 'random', label: 'Random', icon: '🔀' },
  { view: 'uncategorized', label: 'Uncategorized', icon: '◌' },
  { view: 'untagged', label: 'Untagged', icon: '⛉' },
  // The file-first "to-bundle queue" (its count is highlighted) sits with the
  // other attention queues, just above Missing Files.
  { view: 'unbundled', label: 'Unbundled', icon: '⚟' },
  { view: 'missing', label: 'Missing Files', icon: '⚠' },
]
