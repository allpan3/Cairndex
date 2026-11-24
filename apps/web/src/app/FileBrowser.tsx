import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { catalog } from '../api/catalog'
import { replicaRequest } from '../api/replicas'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { useLocalContactSheet } from './useLocalContactSheet'
import type { components } from '../api/schema'
import { ReplicaViewer } from './viewer/ReplicaViewer'
import { ViewOptions } from './ViewOptions'
import { libraryStateKey } from '../state/useBundleDraft'
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { FileBrowserEntry, SortOrder, UnbundledFilesParams } from '../api/client'
import { fileBrowserPreviewUrl, fileThumbnailUrl } from '../api/client'
import { useFileBrowser, useUnbundledFiles } from '../api/hooks'
import { formatBytes, formatDate, formatDuration, formatFileType } from '../lib/format'
import type { HostLabels } from '../platform'
import { displayName, useDisplayPrefs } from '../state/displayPrefs'
import { useDesktopMenu, useDesktopNewFolderAvailability } from '../desktop/useDesktopMenu'
import { usePersistentState } from '../state/usePersistentState'
import { ContextMenu } from './ContextMenu'
import { type FileDragProps, fileDragProps } from './dragOut'
import { markHtmlFileDropHandled } from './htmlFileDrop'
import { FileEntryViewer } from './FileEntryViewer'
import { fileEntryKey, useFileSelection } from './useFileSelection'
import { contactSheetMenuItem, type ContactSheetTarget } from './contactSheetExport'
import { ContactSheetDialog } from './ContactSheetDialog'
import { useFileWriteActions } from './fileWriteActions'
import { newFolderError } from './sourceActions'
import { observeCover } from './coverViewport'
import { acquireCoverBlobUrl, canCacheCoverBlobs, getCachedCoverBlobUrl } from './coverMemoryCache'
import { ConflictDialog, DeleteDialog, DirectoryPicker, NameEditor } from './FileWriteDialogs'
import { hostFileMenuEntries } from './hostActions'
import { HoverPreview } from './HoverPreview'
import type { HoverPreviewSource } from './hoverPreviewState'
import {
  IconCaptions,
  IconFile,
  IconFilm,
  IconFolder,
  IconImage,
  IconLayoutCard,
  IconLayoutList,
  IconMusic,
} from './icons'
import { FILE_ZOOM_MAX, FILE_ZOOM_MIN, listRowHeight } from './layout'
import { SortControl } from './SortControl'
import { SortHeaderCell } from './SortHeader'
import { usePinyinSearch } from './pinyin'
import {
  focusListing,
  listingOwnsKey,
  selectionRange,
  selectionTargets,
  type SelectionModifiers,
} from './selection'
import { SelectionCount } from './SelectionCount'
import {
  readUnbundledKeys,
  SelectAllAborted,
  type SelectAllProgress,
} from '../api/catalogSelectAll'
import { unbundledEntry, useUnbundledWindow } from './useUnbundledWindow'
import { navTargetsFrom, rowStep } from './spatialNav'
import { type MenuEntry, useContextMenu } from './useContextMenu'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'
import type { LocatedFile, PlayerPrefs, SortOption, SortPref } from './types'

// File Browser mirrors the bundle browser's toolbar, but with file-appropriate
// sort fields (bundles' rating/file-count/date-added don't apply) and only
// grid/list layouts (justified needs image aspect ratios files don't carry).
type FileSort = NonNullable<UnbundledFilesParams['sort']>
type FileLayout = 'list' | 'grid'

interface FilePrefs {
  layout: FileLayout
  zoom: number // target card width in px (grid only)
  sort: FileSort
  order: SortOrder
  /** 'folder' keeps a sort per directory (in `folderSorts`, keyed by the
   *  library-relative path, '' being the root); 'global' uses one sort
   *  everywhere. Optional so prefs stored before this existed still read. */
  sortScope?: 'global' | 'folder'
  folderSorts?: Record<string, SortPref<FileSort>>
}

const DEFAULT_FILE_PREFS: FilePrefs = {
  layout: 'list',
  zoom: 200,
  sort: 'name',
  order: 'asc',
  sortScope: 'global',
  folderSorts: {},
}

const FILE_SORTS: SortOption<FileSort>[] = [
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'size', label: 'Size' },
  { value: 'added', label: 'Date Added' },
  { value: 'modified', label: 'Date Modified' },
]

interface FileBrowserProps {
  catalogLibrary?: string
  /** The server can privately prepare unlinked selections (`browse_version: 13`). */
  catalogPathBundling?: boolean
  /** Leading header controls — the sidebar toggle and Back/Forward buttons. */
  headerLeading?: ReactNode
  /** Trailing toolbar controls — the inspector toggle. */
  headerTrailing?: ReactNode
  libraryName: string
  // 'browse' = the directory tree; 'unbundled' = the flat "to-bundle queue".
  scope: 'browse' | 'unbundled'
  path: string
  selectedPath: string | null
  onNavigate: (path: string) => void
  onSelectEntry: (entry: FileBrowserEntry | null) => void
  // Manual bundling actions on selected file paths (unlinked ones auto-linked),
  // with the indexed files' ids for a portable library, which bundles by id
  onAddToBundle: (relativePaths: string[], fileIds: string[]) => void
  onCreateBundle: (relativePaths: string[], fileIds: string[]) => void
  hostLabels: HostLabels
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onRevealFile?: (relativePath: string) => void
  onOpenFile?: (relativePath: string) => void
  // Jump to this file's owning confirmed bundle in Bundle Browser
  /** Locate the owning bundle, opened on this file when it has a catalog id */
  onLocateBundle?: (bundleId: string, file: LocatedFile | null) => void
  /** Make a collection out of this folder (its bundles, under a chosen parent). */
  onCollectionFromFolder?: (directory: string) => void
  // Drag file(s) out to Finder/other apps (plan 3 §6); undefined disables it.
  onStartFileDrag?: (relativePaths: string[]) => void
  // Whether guarded write operations are permitted for this library right now
  // (ADR-0013: the per-library opt-in *and* the deployment switch). False keeps
  // the browser exactly as it was before write mode existed.
  writeMode?: boolean
  /** Portable Rename runs a journaled source operation instead of a legacy write. */
  onRename?: (relativePath: string, newName: string) => void | Promise<void>
  /** Portable directory creation uses the current library source journal. */
  onNewFolder?: (parent: string, name: string) => void | Promise<void>
  /** Portable Copy to…, Move to… and Move to Trash, in place of the legacy writes. */
  onSourceAction?: (action: 'copy' | 'move' | 'trash', relativePaths: string[]) => void
  /** Changing it starts a new, empty file selection, such as after files were bundled. */
  selectionGeneration?: number
  /** Library paths a running Move or Trash is taking out of their folder; hidden at once. */
  leavingPaths?: ReadonlySet<string>
  /** Folders a running New Folder is creating; listed at once and inert until created. */
  arrivingFolders?: ReadonlySet<string>
  // Transient message, with an Undo action when the operation has an inverse.
  onFlash?: (message: string, undo?: () => void) => void
  // App-owned so an upload survives navigation and reports in the sidebar
  onImportFiles?: (files: File[], destDir: string) => void
}

/** Breadcrumb segments for a library-root-relative POSIX path. */
function crumbs(path: string): { label: string; path: string }[] {
  if (!path) return []
  const parts = path.split('/')
  return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }))
}

/**
 * The folder trail. A trail longer than its share of the row scrolls to its end,
 * so the current folder stays in view and the root scrolls out first; the auto
 * margin that right-aligns a short trail does nothing once it overflows.
 */
function Breadcrumbs({
  libraryName,
  path,
  onNavigate,
}: {
  libraryName: string
  path: string
  onNavigate: (path: string) => void
}) {
  const trail = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = trail.current
    if (!element) return
    const end = () => {
      element.scrollLeft = element.scrollWidth
    }
    end()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(end)
    observer.observe(element)
    return () => observer.disconnect()
  }, [path])
  return (
    <nav ref={trail} className="file-browser__crumbs" aria-label="Breadcrumb">
      <button className="crumb" onClick={() => onNavigate('')} disabled={!path}>
        {libraryName}
      </button>
      {crumbs(path).map((crumb) => (
        <span key={crumb.path}>
          <span className="crumb__sep">/</span>
          <button className="crumb" onClick={() => onNavigate(crumb.path)}>
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  )
}

/**
 * The still image to show on a file card at rest, or null to fall back to its
 * media-kind icon.
 *
 * Two different sources, because a File Browser row may or may not be indexed.
 * An *indexed* file — which is every row in the Unbundled queue, since those live
 * in provisional bundles — has a per-file thumbnail the server generates on
 * demand, video frames included. An *unindexed* image has no file row to hang one
 * on, but its bytes are still readable by path, so the path-scoped preview
 * derivative stands in. Everything else (unindexed video, audio, subtitles,
 * directories) has neither and keeps its icon.
 */
function thumbnailFor(entry: FileBrowserEntry): string | null {
  // A portable entry carries `local_state`; one this device cannot read has no image
  if (entry.kind === 'directory' || entry.local_state === 'unavailable') return null
  if (entry.file_id && entry.bundle_id)
    return fileThumbnailUrl(
      entry.bundle_id,
      entry.file_id,
      `${entry.size_bytes}:${entry.modified_at}`,
    )
  // Older portable servers mark bare paths unsupported and have no path preview.
  if ((entry.local_state == null || entry.supported) && entry.media_kind === 'image')
    return fileBrowserPreviewUrl(entry.relative_path, 640)
  return null
}

/**
 * One entry's still image, falling back to `fallback` when it has none or the
 * server cannot produce one — an unprobed or undecodable file answers 503, and
 * the icon is a better answer than a broken image.
 *
 * **Requested through the shared cover queue.** The file grid and list are
 * virtualized, and their thumbnail responses are `no-store`, so a plain `<img>`
 * re-fetched every thumbnail over SMB each time its row scrolled back into view, with
 * no limit on how many ran at once. Like bundle covers, a thumbnail now waits for its
 * row to be near the viewport, joins the bounded queue that keeps video and JSON
 * requests moving (owner: "videos take longer to load", 2026-07-27), and is kept in
 * the session's memory cache, so returning to a row shows it at once.
 *
 * Without blob support (jsdom), the row requests its image directly once visible:
 * `loading="lazy"` stayed unloaded inside the listing's own scroll container.
 */
function EntryThumb({
  entry,
  className,
  holderClassName,
  fallback,
}: {
  entry: FileBrowserEntry
  className: string
  /** The observed wrapper. Must carry a real layout box in its surface —
   *  `display: contents` has none, and an unboxed target never intersects. */
  holderClassName: string
  fallback: ReactNode
}) {
  const src = thumbnailFor(entry)
  // Latched per-source, not per-component: rows are keyed by path, so an entry
  // whose source later changes (fast-add links it, giving it a real thumbnail
  // URL) reuses this instance — a boolean would keep it stuck on the icon.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ src: string; url: string } | null>(null)
  const holderRef = useRef<HTMLSpanElement | null>(null)
  const useBlobs = canCacheCoverBlobs()
  const warm = src && useBlobs ? getCachedCoverBlobUrl(src) : undefined

  useEffect(() => {
    const node = holderRef.current
    if (!node || !src || warm || failedSrc === src || loaded?.src === src) return
    let handle: ReturnType<typeof acquireCoverBlobUrl> | undefined
    const stop = observeCover(node, (visibility) => {
      if (visibility === 'outside') {
        handle?.release()
        handle = undefined
        return
      }
      const visible = visibility === 'visible'
      if (!useBlobs) {
        if (visible) setLoaded({ src, url: src })
        return
      }
      if (handle) return handle.setVisible(visible)
      const request = acquireCoverBlobUrl(src, visible)
      handle = request
      void request.promise.then((url) => {
        if (handle !== request) return
        if (url) setLoaded({ src, url })
        else setFailedSrc(src)
      })
    })
    return () => {
      stop()
      handle?.release()
    }
  }, [src, warm, useBlobs, failedSrc, loaded?.src])

  if (!src || failedSrc === src) return <>{fallback}</>
  const url = warm ?? (loaded?.src === src ? loaded.url : undefined)
  return (
    <span ref={holderRef} className={holderClassName}>
      {url ? (
        <img
          className={className}
          src={url}
          alt=""
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        fallback
      )}
    </span>
  )
}

// Inline SVG icons (no font dependency, monochrome via currentColor) chosen by
// directory/media kind.
/**
 * The listing plus the folders New Folder is creating directly inside `folder`,
 * until the listing itself contains them.
 */
function withArrivingFolders(
  entries: FileBrowserEntry[],
  arriving: ReadonlySet<string> | undefined,
  folder: string,
): FileBrowserEntry[] {
  if (!arriving?.size) return entries
  const listed = new Set(entries.map((entry) => entry.relative_path))
  const added: FileBrowserEntry[] = []
  for (const path of arriving) {
    const cut = path.lastIndexOf('/')
    if ((cut < 0 ? '' : path.slice(0, cut)) !== folder || listed.has(path)) continue
    added.push({
      name: path.slice(cut + 1),
      relative_path: path,
      kind: 'directory',
      linked: false,
      unbundled: false,
      supported: false,
      bundle_id: null,
      file_id: null,
      media_kind: null,
      mime_type: null,
      extension: null,
      container: null,
      size_bytes: null,
      duration: null,
      audio_codec: null,
      video_codec: null,
      video_codec_tag: null,
      created_at: null,
      modified_at: null,
      resume_position: null,
    })
  }
  return added.length ? [...entries, ...added] : entries
}

function entryIcon(entry: FileBrowserEntry) {
  if (entry.kind === 'directory') return <IconFolder />
  switch (entry.media_kind) {
    case 'video':
      return <IconFilm />
    case 'image':
      return <IconImage />
    case 'audio':
      return <IconMusic />
    case 'subtitle':
      return <IconCaptions />
    default:
      return <IconFile />
  }
}

/** Compare two entries by the active sort field (nulls sort last-ish via
 * empty-string / zero fallbacks); direction is applied by the caller. */
function compareEntries(a: FileBrowserEntry, b: FileBrowserEntry, sort: FileSort): number {
  switch (sort) {
    case 'name':
      return a.name.localeCompare(b.name)
    case 'type':
      return (a.extension ?? '').localeCompare(b.extension ?? '') || a.name.localeCompare(b.name)
    case 'size':
      return (a.size_bytes ?? 0) - (b.size_bytes ?? 0) || a.name.localeCompare(b.name)
    case 'added':
      return (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.name.localeCompare(b.name)
    case 'modified':
      return (
        (a.modified_at ?? '').localeCompare(b.modified_at ?? '') || a.name.localeCompare(b.name)
      )
  }
}

/**
 * The physical, library-scoped file browser (ADR-0008). The visible items are
 * real directories and files under the active library's root — not bundle cards.
 * Two scopes: `browse` navigates the directory tree; `unbundled` shows a flat,
 * library-wide list of files awaiting bundling. Files can be right-clicked to
 * add them to / create a bundle (metadata-only; no move/rename/delete on disk).
 */
export function FileBrowser(props: FileBrowserProps) {
  return <FileBrowserControls key={libraryStateKey(props.scope)} {...props} />
}

interface FileControls {
  prefs: FilePrefs
  setPrefs: Dispatch<SetStateAction<FilePrefs>>
  search: string
  setSearch: (value: string) => void
}
type FileScopeProps = FileBrowserProps & FileControls

/** Keep query criteria above the request so each server page has the intended order */
function FileBrowserControls(props: FileBrowserProps) {
  const [prefs, setPrefs] = usePersistentState<FilePrefs>(
    libraryStateKey('cairndex.filePrefs'),
    DEFAULT_FILE_PREFS,
  )
  const [criteria, setCriteria] = useState({ path: props.path, search: '' })
  if (criteria.path !== props.path) setCriteria({ path: props.path, search: '' })
  const controls = {
    prefs,
    setPrefs,
    search: criteria.search,
    setSearch: (search: string) => setCriteria({ path: props.path, search }),
  }
  return props.catalogLibrary ? (
    props.scope === 'unbundled' ? (
      <CatalogUnbundledScope {...props} {...controls} />
    ) : (
      <CatalogBrowseScope {...props} {...controls} />
    )
  ) : props.scope === 'unbundled' ? (
    <UnbundledScope {...props} {...controls} />
  ) : (
    <BrowseScope {...props} {...controls} />
  )
}

function CatalogBrowseScope(props: FileScopeProps) {
  const query = useQuery({
    queryKey: ['catalog-local-directory', props.catalogLibrary, props.path],
    queryFn: () =>
      replicaRequest<components['schemas']['FileBrowserListingRead']>(
        props.catalogLibrary!,
        `/media/directory?path=${encodeURIComponent(props.path)}`,
      ),
    refetchInterval: 4000,
  })
  // A Move or Trash takes its items out of view as soon as it starts, as a file
  // manager does; a failed step shows them again
  const { leavingPaths } = props
  const listed = query.data?.entries
  const entries = useMemo(
    () =>
      leavingPaths?.size
        ? (listed ?? []).filter((entry) => !leavingPaths.has(entry.relative_path))
        : (listed ?? []),
    [listed, leavingPaths],
  )
  return (
    <div className="file-browser">
      <FileList
        {...props}
        key={`${props.catalogLibrary}/${props.path}`}
        header={
          <>
            {props.headerLeading}
            <Breadcrumbs
              libraryName={props.libraryName}
              path={props.path}
              onNavigate={props.onNavigate}
            />
          </>
        }
        entries={entries}
        isLoading={query.isLoading}
        isError={query.isError}
        complete={!!query.data && !query.isFetching && !query.isError}
        onRetry={() => void query.refetch()}
        errorText={query.error?.message}
        emptyText={
          query.data?.local_state === 'unavailable'
            ? 'This folder is unavailable on this device.'
            : 'This folder is empty.'
        }
        // An unreadable folder still lists its cataloged entries; say so once
        notice={
          query.data?.local_state === 'unavailable'
            ? 'This folder is unavailable on this device.'
            : undefined
        }
      />
    </div>
  )
}

/** Retained staging and fresh private discoveries share the ordinary file queue. */
function CatalogUnbundledScope(props: FileScopeProps) {
  const library = props.catalogLibrary!
  const q = props.search.trim()
  const status = useReplicaStatus(library).data
  // The server orders the whole matching queue before each page (browse 17)
  const sortable = (status?.browse_version ?? 0) >= 17
  const sort = sortable ? props.prefs.sort : undefined
  const direction = sortable ? props.prefs.order : undefined
  const query = useMemo(
    () => ({ q, ...(sort ? { sort, order: direction } : {}) }),
    [q, sort, direction],
  )
  const [range, setRange] = useState({ start: 0, end: 0 })
  const listing = useUnbundledWindow(library, query, range)
  // Select All and Shift ranges read keys of rows not yet fetched (`selection_version: 6`)
  const keyed = (status?.selection_version ?? 0) >= 6
  const listingWindow: ListingWindow = {
    identity: JSON.stringify(query),
    count: listing.count,
    at: listing.at,
    slotOf: listing.slotOf,
    onRange: (start, end) =>
      setRange((previous) =>
        previous.start === start && previous.end === end ? previous : { start, end },
      ),
    readAll: keyed
      ? (onProgress, signal) =>
          readUnbundledKeys(library, query, onProgress, signal).then((items) =>
            items.map(unbundledEntry),
          )
      : undefined,
    readRange: keyed
      ? async (first, last) => {
          const found: FileBrowserEntry[] = []
          for (let offset = first; offset <= last; offset += 1000) {
            const page = await catalog<components['schemas']['CatalogUnbundledKeyPage']>(
              library,
              '/files/unbundled/ids',
              'POST',
              { ...query, offset, limit: Math.min(1000, last - offset + 1) },
            )
            found.push(...page.items.map(unbundledEntry))
          }
          return found
        }
      : undefined,
  }
  return (
    <div className="file-browser">
      <FileList
        {...props}
        key={`${props.catalogLibrary}/unbundled`}
        header={
          <>
            {props.headerLeading}
            <span className="toolbar__title">Unbundled</span>
          </>
        }
        entries={listing.entries}
        window={listingWindow}
        isLoading={listing.isLoading}
        isError={listing.isError}
        complete={listing.complete && !listing.isError}
        onRetry={listing.refetch}
        errorText={listing.error?.message}
        emptyText={
          q
            ? `No files match “${props.search}”.`
            : 'Nothing to bundle — every file is already in a bundle.'
        }
      />
    </div>
  )
}

function BrowseScope(props: FileScopeProps) {
  const { headerLeading, libraryName, path, onNavigate } = props
  const qc = useQueryClient()
  // `keepPrevious`: hold the current folder's rows while the next one loads,
  // instead of replacing the whole listing with "Loading…" on every step into a
  // folder (owner, 2026-08-26). `stale` is true for exactly that window, and
  // everything row-based is inert while it is — see the guards below.
  const query = useFileBrowser(path, true, true)
  const stale = query.isPlaceholderData
  const entries = query.data?.entries ?? []
  const missingFilesUpdated = query.data?.missing_files_updated ?? 0

  // A directory read can persist missing links, so refresh bundle-based views
  useEffect(() => {
    if (missingFilesUpdated === 0) return
    qc.invalidateQueries({ queryKey: ['view-counts'] })
    qc.invalidateQueries({ queryKey: ['browse'] })
    qc.invalidateQueries({ queryKey: ['bundle-files'] })
  }, [missingFilesUpdated, qc, query.dataUpdatedAt])

  const header = (
    <>
      {headerLeading}
      <Breadcrumbs libraryName={libraryName} path={path} onNavigate={onNavigate} />
    </>
  )

  return (
    <div className="file-browser">
      <FileList
        key={libraryStateKey(`browse:${path}`)}
        header={header}
        entries={entries}
        isLoading={query.isLoading}
        isError={query.isError}
        complete={!!query.data && !query.isFetching && !query.isError && !stale}
        onRetry={() => void query.refetch()}
        errorText={query.error instanceof Error ? query.error.message : undefined}
        emptyText="This folder is empty."
        stale={stale}
        {...props}
      />
    </div>
  )
}

function UnbundledScope(props: FileScopeProps) {
  const params = { q: props.search.trim(), sort: props.prefs.sort, order: props.prefs.order }
  const query = useUnbundledFiles(params)
  const entries = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data])

  return (
    <div className="file-browser">
      <FileList
        key={libraryStateKey('unbundled')}
        header={
          <>
            {props.headerLeading}
            <span className="toolbar__title">Unbundled</span>
          </>
        }
        entries={entries}
        isLoading={query.isLoading}
        isError={query.isError}
        complete={!!query.data && !query.isFetching && !query.isError && !query.hasNextPage}
        onRetry={() => void query.refetch()}
        errorText={query.error instanceof Error ? query.error.message : undefined}
        emptyText={
          props.search.trim()
            ? `No files match “${props.search}”.`
            : 'No indexed files awaiting bundling.'
        }
        hasMore={query.hasNextPage}
        isFetchingMore={query.isFetchingNextPage}
        onLoadMore={() => query.fetchNextPage()}
        {...props}
      />
    </div>
  )
}

interface FileListProps extends FileScopeProps {
  header: ReactNode
  entries: FileBrowserEntry[]
  isLoading: boolean
  isError: boolean
  complete: boolean
  onRetry: () => void
  errorText?: string
  emptyText: string
  /** One plain line for a listing-wide exception that rows do not repeat. */
  notice?: string
  /**
   * The rows on screen are the previous folder's, held while the next one loads.
   * They must not be interacted with: the breadcrumb already reads the new
   * folder, so a click would select — and Rename/Move/Trash would then act on —
   * a file from the one just left.
   */
  stale?: boolean
  hasMore?: boolean
  isFetchingMore?: boolean
  onLoadMore?: () => void
  /** A window over a long list: sized from its total, rows fetched as they come into view. */
  window?: ListingWindow
}

/** A long flat list rendered as a window: only rows on screen are fetched and drawn. */
interface ListingWindow {
  /** Changes with the query (search or sort); the list then returns to its top. */
  identity: string
  count: number
  at: (slot: number) => FileBrowserEntry | undefined
  slotOf: (path: string) => number
  /** The rows the virtual list shows, so their pages can be fetched. */
  onRange: (start: number, end: number) => void
  /** Keys of rows `first`..`last` in list order, including rows not fetched. */
  readRange?: (first: number, last: number) => Promise<FileBrowserEntry[]>
  /** Keys of every row, for Select All. */
  readAll?: (
    onProgress: (progress: SelectAllProgress) => void,
    signal: AbortSignal,
  ) => Promise<FileBrowserEntry[]>
}

/** The most files a bundle can be made from or added to in one step, the server's bound. */
const BUNDLE_LIMIT = 100
/**
 * The most items one Copy, Move or Trash or one drag-out takes from a windowed list.
 * Each item is its own journaled operation in one task, so a larger selection
 * would run for hours and hold its whole task in the window.
 */
const SOURCE_LIMIT = 1000
const NO_ENTRIES = new Map<string, FileBrowserEntry>()
const GRID_GAP = 12

/** The selectable, right-clickable table/grid of file/dir entries shared by
 * both scopes, with a bundle-browser-style toolbar (search / sort / layout /
 * zoom). Local selection + search are reset by remount (the caller keys it by
 * scope/path); layout/sort/zoom persist. Single click selects (drives the
 * inspector); double click navigates into a folder or opens a file. Only files
 * participate in the bundling context menu and drag-select. */
function FileList({
  catalogLibrary,
  catalogPathBundling = false,
  prefs,
  setPrefs,
  search,
  setSearch,
  header,
  headerTrailing,
  entries: listedEntries,
  arrivingFolders,
  stale = false,
  isLoading,
  isError,
  complete,
  onRetry,
  errorText,
  emptyText,
  notice,
  hasMore,
  isFetchingMore,
  onLoadMore,
  window: listing,
  selectionGeneration = 0,
  selectedPath,
  onNavigate,
  onSelectEntry,
  onAddToBundle,
  onCreateBundle,
  hostLabels,
  onRevealFile,
  onOpenFile,
  onLocateBundle,
  onCollectionFromFolder,
  onStartFileDrag,
  scope,
  path: currentPath,
  writeMode = false,
  onRename,
  onNewFolder,
  onSourceAction,
  onFlash,
  onImportFiles,
  libraryName,
  playerPrefs,
  onPlayerPrefs,
}: FileListProps) {
  const entries = useMemo(
    () => withArrivingFolders(listedEntries, arrivingFolders, currentPath),
    [listedEntries, arrivingFolders, currentPath],
  )
  // A folder still being created has no directory to open, rename or move yet
  const arriving = (entry: FileBrowserEntry) =>
    Boolean(arrivingFolders?.has(entry.relative_path)) &&
    !listedEntries.some((listed) => listed.relative_path === entry.relative_path)
  // Opening a folder still being created goes in once the listing has it
  const openWhenCreated = useRef<string | null>(null)
  useEffect(() => {
    const path = openWhenCreated.current
    if (!path) return
    if (listedEntries.some((listed) => listed.relative_path === path)) {
      openWhenCreated.current = null
      onNavigate(path)
    } else if (!arrivingFolders?.has(path)) openWhenCreated.current = null
  }, [listedEntries, arrivingFolders, onNavigate])
  const menu = useContextMenu()
  // The file whose contact-sheet options are open, if any.
  const [sheetTarget, setSheetTarget] = useState<ContactSheetTarget | null>(null)
  // A portable entry is observed on this device before its sheet dialog opens
  const replicaStatus = useReplicaStatus(catalogLibrary).data
  const catalogExports = replicaStatus?.export_version === 1
  const localSheet = useLocalContactSheet(catalogLibrary, (message) => onFlash?.(message))
  const write = useFileWriteActions({
    currentPath,
    onFlash: onFlash ?? (() => undefined),
    onImportFiles,
  })
  // New Folder needs a directory to create *in*, which the flat unbundled queue
  // does not have. Renaming works in both scopes — a path is a path.
  const canCreateFolder = (Boolean(onNewFolder) || writeMode) && scope === 'browse'
  if (!canCreateFolder && write.creatingFolder) write.cancelNewFolder()
  const startNewFolder = () => {
    if (canCreateFolder) write.startNewFolder()
  }
  // A refused portable New Folder reopens its name field with the reason
  const [refusedFolder, setRefusedFolder] = useState<{ name: string; error: string } | null>(null)
  const submitNewFolder = (name: string) => {
    const trimmed = name.trim()
    if (onNewFolder) {
      // The folder is listed as soon as its task starts, as a file manager
      // does; the journaled creation finishes in the background.
      const created = onNewFolder(currentPath, trimmed)
      setRefusedFolder(null)
      write.cancelNewFolder()
      void Promise.resolve(created).catch((reason: Error) => {
        setRefusedFolder({ name: trimmed, error: reason.message })
        write.startNewFolder()
      })
    } else if (writeMode) write.submitNewFolder(name)
  }
  const cancelNewFolder = () => {
    setRefusedFolder(null)
    write.cancelNewFolder()
  }
  // An occupied name is caught here at once; the server still refuses a race
  const validateNewFolder = (name: string) =>
    newFolderError(name) ??
    (entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())
      ? 'This name is already in use.'
      : null)
  const canRename = Boolean(onRename) || writeMode
  if (!canRename && write.renamingPath) write.cancelRename()
  const submitRename = async (path: string, name: string) => {
    if (onRename) {
      await onRename(path, name)
      write.cancelRename()
    } else if (writeMode) write.submitRename(path, name)
  }
  /**
   * The sort in force here, and how changing it is stored.
   *
   * With "Remember sort per folder" on, each directory keeps its own — the
   * Bundle Browser's per-collection scope, for the surface where the scope is a
   * folder (owner, 2026-09-01). A folder with none yet inherits the global sort,
   * so turning the switch on never changes what is currently on screen. The flat
   * unbundled queue is not a folder and has no scope to remember against, so it
   * always uses the global sort and is not offered the choice.
   */
  const folderKey = scope === 'browse' ? currentPath : null
  // An older portable server pages its queue in path order only
  const fixedOrder =
    Boolean(catalogLibrary) && scope === 'unbundled' && (replicaStatus?.browse_version ?? 0) < 17
  const folderScoped = prefs.sortScope === 'folder' && folderKey !== null
  const activeSort: SortPref<FileSort> = folderScoped
    ? (prefs.folderSorts?.[folderKey] ?? { sort: prefs.sort, order: prefs.order })
    : { sort: prefs.sort, order: prefs.order }
  const setActiveSort = (sort: FileSort, order: SortOrder) => {
    if (folderScoped) {
      setPrefs({
        ...prefs,
        folderSorts: { ...(prefs.folderSorts ?? {}), [folderKey]: { sort, order } },
      })
    } else {
      setPrefs({ ...prefs, sort, order })
    }
  }
  const [displayPrefs] = useDisplayPrefs()
  // The *displayed* name only. Renaming, search and every operation keep using
  // `entry.name`, so hiding extensions can never change what an action does.
  const labelFor = (entry: FileBrowserEntry) =>
    displayName(entry.name, entry.kind === 'directory', displayPrefs.hideFileExtensions)
  // A windowed list selects rows it has not fetched, by keys read from the server
  const selectionScope = JSON.stringify([scope, currentPath, search, selectionGeneration])
  const [extra, setExtra] = useState({ scope: selectionScope, map: NO_ENTRIES })
  const known = extra.scope === selectionScope ? extra.map : NO_ENTRIES
  const remember = (found: FileBrowserEntry[]) => {
    const map = new Map(known)
    for (const entry of found) map.set(entry.relative_path, entry)
    setExtra({ scope: selectionScope, map })
  }
  // Once every row is fetched, the rows themselves decide what is still selectable
  const selectionEntries = useMemo(() => {
    if (!listing || complete || known.size === 0) return entries
    const listed = new Set(entries.map((entry) => entry.relative_path))
    return [...entries, ...[...known.values()].filter((entry) => !listed.has(entry.relative_path))]
  }, [listing, complete, known, entries])
  const { selected, setSelected, anchor, setAnchor, focusedPath, setFocusedPath, selectedEntry } =
    useFileSelection(
      libraryStateKey(`cairndex.fileSelection:${selectionScope}`),
      selectionEntries,
      complete,
      selectedPath,
    )
  const [selectingAll, setSelectingAll] = useState<{
    progress: SelectAllProgress
    abort: AbortController
  } | null>(null)
  // Keep the inspector and host actions on the refreshed path of the selected indexed file
  const refreshSelectedEntry = useEffectEvent((entry: FileBrowserEntry | null) => {
    if (catalogLibrary || selectedPath !== entry?.relative_path) onSelectEntry(entry)
  })
  useEffect(() => {
    if (selectedEntry && !stale) refreshSelectedEntry(selectedEntry)
    else if (
      complete &&
      selectedPath &&
      !entries.some((entry) => entry.relative_path === selectedPath)
    )
      refreshSelectedEntry(null)
  }, [selectedEntry, stale, complete, selectedPath, entries])
  const matchSearch = usePinyinSearch(search)

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Whether an OS drag is currently over the listing, for the drop cue.
  const [dropActive, setDropActive] = useState(false)

  // Client-side filter (by name) + sort. Directories stay grouped ahead of
  // files (file-manager convention; folders are the navigational containers,
  // analogous to collections). Whole-library / recursive file search is a
  // future backend enhancement — see docs/STATUS.md.
  const visible = useMemo(() => {
    if (scope === 'unbundled' || listing) return entries
    const q = search.trim()
    const filtered = q ? entries.filter((e) => matchSearch(e.name)) : entries
    const dir = activeSort.order === 'asc' ? 1 : -1
    const cmp = (a: FileBrowserEntry, b: FileBrowserEntry) =>
      compareEntries(a, b, activeSort.sort) * dir
    const dirs = filtered.filter((e) => e.kind === 'directory').sort(cmp)
    const files = filtered.filter((e) => e.kind !== 'directory').sort(cmp)
    return [...dirs, ...files]
  }, [entries, listing, scope, search, activeSort.sort, activeSort.order, matchSearch])
  // Each selected path's entry: a visible row, or in a windowed list a key read for it
  const entryByPath = useMemo(
    () =>
      new Map((listing ? selectionEntries : visible).map((entry) => [entry.relative_path, entry])),
    [listing, selectionEntries, visible],
  )

  const openable = useMemo(() => visible.filter((e) => e.kind === 'file' && e.supported), [visible])
  const [openKey, setOpenKey] = useState<string | null>(null)
  const openIndex =
    openKey === null ? -1 : openable.findIndex((entry) => fileEntryKey(entry) === openKey)
  if (complete && openKey !== null && !entries.some((entry) => fileEntryKey(entry) === openKey))
    setOpenKey(null)
  // The viewer's heading names where the playlist came from: the folder being
  // browsed (the library root has no path segment), or the flat queue.
  const viewerTitle =
    scope === 'unbundled'
      ? 'Unbundled'
      : currentPath
        ? (currentPath.split('/').pop() ?? libraryName)
        : libraryName

  // Single click selects (for the inspector); Cmd/Ctrl toggles the entry, Shift
  // selects the inclusive range from the anchor. Both directories and files take
  // part (bundling later filters to files). Navigation/opening is double-click.
  const clickEntry = (entry: FileBrowserEntry, e: SelectionModifiers) => {
    if (arriving(entry)) return
    // Belt and braces with the `listing--inert` style: CSS alone would leave the
    // guard dependent on a stylesheet having loaded, and what it is guarding is
    // Rename/Move to…/Move to Trash resolving against the previous folder.
    if (stale) return
    setFocusedPath(entry.relative_path)
    if (listing && e.shiftKey && anchor) {
      const from = listing.slotOf(anchor)
      const to = listing.slotOf(entry.relative_path)
      if (from !== -1 && to !== -1) {
        selectSlots(Math.min(from, to), Math.max(from, to), e.metaKey || e.ctrlKey)
        onSelectEntry(entry)
        return
      }
    }
    if (e.shiftKey && anchor) {
      const ids = visible.map((v) => v.relative_path)
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(entry.relative_path)
      if (a !== -1 && b !== -1) {
        setSelected((previous) =>
          selectionRange(
            ids,
            anchor,
            entry.relative_path,
            e.metaKey || e.ctrlKey ? previous : undefined,
          ),
        )
        onSelectEntry(entry)
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(entry.relative_path)) next.delete(entry.relative_path)
        else next.add(entry.relative_path)
        return next
      })
    } else {
      setSelected(new Set([entry.relative_path]))
    }
    setAnchor(entry.relative_path)
    onSelectEntry(entry)
  }

  /**
   * Select rows `first`..`last` of a windowed list. Rows not fetched yet are named
   * by keys read from the server; without that read the range cannot be complete,
   * so it is refused rather than cut short.
   */
  const selectSlots = (first: number, last: number, additive: boolean) => {
    if (!listing) return
    const rows: FileBrowserEntry[] = []
    for (let slot = first; slot <= last; slot++) {
      const row = listing.at(slot)
      if (!row) break
      rows.push(row)
    }
    const apply = (found: FileBrowserEntry[]) => {
      remember(found)
      const paths = found.map((row) => row.relative_path)
      setSelected((previous) => new Set(additive ? [...previous, ...paths] : paths), found)
    }
    if (rows.length === last - first + 1) return apply(rows)
    if (!listing.readRange) {
      onFlash?.('Scroll through the rows first; this server cannot select rows it has not shown.')
      return
    }
    void listing
      .readRange(first, last)
      .then(apply)
      .catch((reason: Error) => onFlash?.(reason.message))
  }

  /** Select every row; a windowed list reads the keys of rows it has not fetched. */
  const selectAll = () => {
    const first = focusedPath ?? visible[0]?.relative_path ?? null
    const finish = (paths: string[], found: FileBrowserEntry[] = []) => {
      setSelected(new Set(paths), found)
      setFocusedPath(first)
      setAnchor(first)
      onSelectEntry(visible.find((entry) => entry.relative_path === first) ?? null)
    }
    if (!listing?.readAll || visible.length >= listing.count) {
      finish(visible.map((entry) => entry.relative_path))
      return
    }
    if (selectingAll) return
    const abort = new AbortController()
    setSelectingAll({ progress: { done: 0, total: listing.count }, abort })
    void listing
      .readAll(
        (progress) =>
          setSelectingAll((current) =>
            current?.abort === abort ? { ...current, progress } : current,
          ),
        abort.signal,
      )
      .then((found) => {
        if (abort.signal.aborted) return
        remember(found)
        finish(
          found.map((entry) => entry.relative_path),
          found,
        )
      })
      .catch((reason: Error) => {
        if (!abort.signal.aborted && !(reason instanceof SelectAllAborted))
          onFlash?.(reason.message)
      })
      .finally(() => setSelectingAll((current) => (current?.abort === abort ? null : current)))
  }

  const openEntry = (entry: FileBrowserEntry) => {
    if (stale) return
    if (arriving(entry)) {
      openWhenCreated.current = entry.relative_path
      return
    }
    if (entry.kind === 'directory') {
      onNavigate(entry.relative_path)
      return
    }
    if (entry.supported) {
      setOpenKey(fileEntryKey(entry))
    }
  }

  // Rename is the one action a directory has, so a directory's context menu now
  // exists at all — it used to return early because bundling acts on files only.
  const contextDirectory = (entry: FileBrowserEntry, e: React.MouseEvent, pending = false) => {
    if (!pending) {
      setSelected(new Set([entry.relative_path]))
      onSelectEntry(entry)
    }
    const items: MenuEntry[] = [
      { label: 'Copy Path', onClick: () => copyPath(entry.relative_path) },
    ]
    // A collection made from this folder: its bundles, under a parent you pick.
    // Metadata-only, so it is offered whether or not write mode is on — which is
    // why a folder's menu opens at all now, rather than only when writing is
    // permitted (it previously held nothing else that worked read-only).
    if (onCollectionFromFolder) {
      items.push(null, {
        label: 'New Collection from Folder…',
        onClick: () => onCollectionFromFolder(entry.relative_path),
      })
    }
    if (canRename) {
      items.push(null, { label: 'Rename…', onClick: () => write.startRename(entry.relative_path) })
    }
    if (onSourceAction) {
      const paths = [entry.relative_path]
      items.push(
        { label: 'Copy to…', onClick: () => onSourceAction('copy', paths) },
        { label: 'Move to…', onClick: () => onSourceAction('move', paths) },
        { label: 'Move to Trash', onClick: () => onSourceAction('trash', paths) },
      )
    } else if (writeMode) {
      items.push(
        { label: 'Move to…', onClick: () => write.askToMove([entry.relative_path]) },
        // A folder's own delete takes everything inside it, in one operation.
        { label: 'Move to Trash', onClick: () => write.askToDelete([entry.relative_path], 0) },
      )
    }
    if (canCreateFolder) items.push({ label: 'New Folder', onClick: startNewFolder })
    // A folder still being created offers its menu, but only its path works yet
    menu.open(
      e,
      pending
        ? items.map((item) => item && { ...item, disabled: item.label !== 'Copy Path' })
        : items,
    )
  }

  const contextRow = (entry: FileBrowserEntry, e: React.MouseEvent) => {
    if (stale) return
    if (entry.kind === 'directory') {
      // Not write-mode-gated any more: a folder's menu now carries Copy Path and
      // New Collection from Folder…, both metadata-only. The entries that do
      // touch the filesystem are gated inside.
      contextDirectory(entry, e, arriving(entry))
      return // bundling acts on files only
    }
    const inSelection = selected.has(entry.relative_path)
    // The selection can now include directories (drag/shift-select), so restrict
    // the bundling targets to files.
    const targets = selectionTargets(entry.relative_path, selected).filter(
      (path) => entryByPath.get(path)?.kind === 'file',
    )
    if (!inSelection) {
      setSelected(new Set([entry.relative_path]))
      onSelectEntry(entry)
    }
    const n = targets.length
    const count = n.toLocaleString()
    const items: MenuEntry[] = []
    if (n === 1) {
      const hostItems = hostFileMenuEntries(
        hostLabels,
        { onOpenFile, onRevealFile },
        targets[0] as string,
      )
      if (hostItems.length > 0) items.push(...hostItems)
    }
    if (canRename || writeMode || onSourceAction) {
      const writeItems: MenuEntry[] = []
      // Rename acts on one entry; a multi-selection has no single new name.
      if (canRename && n === 1)
        writeItems.push({
          label: 'Rename…',
          onClick: () => write.startRename(targets[0] as string),
        })
      // Move takes the whole selection, directories included — unlike bundling,
      // which is a files-only action.
      const moveTargets = selectionTargets(entry.relative_path, selected)
      if (onSourceAction) {
        const many = moveTargets.length > 1
        const moving = moveTargets.length.toLocaleString()
        // A windowed list can select far more items than one task can carry
        const tooMany = Boolean(listing) && moveTargets.length > SOURCE_LIMIT
        const limit = tooMany
          ? {
              disabled: true,
              detail: `Select up to ${SOURCE_LIMIT.toLocaleString()} items to copy, move or trash them.`,
            }
          : {}
        writeItems.push(
          {
            label: many ? `Copy ${moving} Items to…` : 'Copy to…',
            onClick: () => onSourceAction('copy', moveTargets),
            ...limit,
          },
          {
            label: many ? `Move ${moving} Items to…` : 'Move to…',
            onClick: () => onSourceAction('move', moveTargets),
            ...limit,
          },
          {
            label: many ? `Move ${moving} Items to Trash` : 'Move to Trash',
            onClick: () => onSourceAction('trash', moveTargets),
            ...limit,
          },
        )
      } else if (writeMode) {
        writeItems.push({
          label: moveTargets.length > 1 ? `Move ${moveTargets.length} Items…` : 'Move to…',
          onClick: () => write.askToMove(moveTargets),
        })
        writeItems.push({
          label: n > 1 ? `Move ${n} Files to Trash` : 'Move to Trash',
          onClick: () => write.askToDelete(targets, linkedCount(targets)),
        })
      }
      if (canCreateFolder) writeItems.push({ label: 'New Folder', onClick: startNewFolder })
      if (writeItems.length > 0) {
        if (items.length > 0) items.push(null)
        items.push(...writeItems)
      }
    }
    if (items.length > 0) items.push(null)
    const selectedEntries = targets.flatMap((path) => entryByPath.get(path) ?? [])
    const eligiblePaths =
      catalogPathBundling && selectedEntries.every((item) => !item.linked || item.unbundled)
    if (!catalogLibrary || scope === 'unbundled' || eligiblePaths) {
      const ids = selectedEntries.flatMap((item) => item.file_id ?? [])
      const paths = catalogLibrary
        ? selectedEntries.filter((item) => !item.file_id).map((item) => item.relative_path)
        : targets
      // A portable bundle takes 1 to 100 files per step; a larger selection is
      // refused here rather than cut short
      const limit =
        catalogLibrary && n > BUNDLE_LIMIT
          ? { disabled: true, detail: `Select up to ${BUNDLE_LIMIT} files to bundle them.` }
          : {}
      items.push(
        {
          label: n > 1 ? `Create Bundle from ${count} Files…` : 'Create Bundle…',
          onClick: () => onCreateBundle(paths, ids),
          ...limit,
        },
        {
          label: n > 1 ? `Add ${count} Files to Bundle…` : 'Add to Bundle…',
          onClick: () => onAddToBundle(paths, ids),
          ...limit,
        },
      )
    }
    if (n === 1) {
      const owningBundleId = entry.bundle_id
      if (onLocateBundle && owningBundleId && !entry.unbundled) {
        items.push({
          label: 'Locate in Bundle Browser',
          onClick: () =>
            onLocateBundle(
              owningBundleId,
              entry.file_id ? { id: entry.file_id, path: entry.relative_path } : null,
            ),
        })
      }
    }
    items.push(null, {
      label: 'Copy Path',
      disabled: n > 1,
      onClick: () => copyPath(entry.relative_path),
    })
    // An unindexed video has no file row for the server to cut a sheet from
    if (!catalogLibrary && n === 1 && entry.media_kind === 'video' && entry.file_id) {
      items.push(
        null,
        contactSheetMenuItem(
          {
            fileId: entry.file_id,
            title: entry.name,
            sizeBytes: entry.size_bytes,
            duration: entry.duration,
            mimeType: entry.mime_type,
            width: entry.width,
            height: entry.height,
            fps: entry.fps,
            videoCodec: entry.video_codec,
            audioCodec: entry.audio_codec,
            videoBitrate: entry.video_bitrate,
            audioBitrate: entry.audio_bitrate,
            audioSampleRate: entry.audio_sample_rate,
          },
          setSheetTarget,
        ),
      )
    }
    if (catalogExports && n === 1 && entry.media_kind === 'video' && entry.file_id) {
      const fileId = entry.file_id
      items.push(null, { label: 'Save Contact Sheet…', onClick: () => localSheet.open(fileId) })
    }
    menu.open(e, items)
  }

  // Right-clicking empty space is where New Folder is expected to live.
  const contextBackground = (e: React.MouseEvent) => {
    if (!canCreateFolder) return
    if ((e.target as HTMLElement).closest('[data-relpath]')) return // a row handles its own
    e.preventDefault()
    menu.open(e, [{ label: 'New Folder', onClick: startNewFolder }])
  }

  // Dropping files from the desktop copies them into the folder being browsed.
  // Only *files* — `dataTransfer.items` cannot expand a dropped folder without
  // recursion, which the server has no batch endpoint for yet.
  const onDragOverFiles = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault() // required, or the browser opens the file instead
    e.dataTransfer.dropEffect = 'copy'
    setDropActive(true)
  }

  const onDropFiles = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    markHtmlFileDropHandled()
    setDropActive(false)
    write.importFiles([...e.dataTransfer.files])
  }

  // Copy the library-relative path — the inspector no longer prints it (it is the
  // longest value there and rarely read), so this is how it is retrieved.
  const copyPath = (relativePath: string) => {
    void navigator.clipboard
      ?.writeText(relativePath)
      .then(() => onFlash?.(`Copied “${relativePath}”.`))
      .catch(() => onFlash?.('The path could not be copied.'))
  }

  // How many of these paths a bundle is built on — the part of a delete worth
  // pausing over, and the one thing the confirmation can say that a file
  // manager's could not.
  const linkedCount = (paths: string[]): number =>
    paths.filter((path) => entryByPath.get(path)?.linked).length

  /** Move the selection one step through the listing (arrow keys). */
  const moveSelection = (
    direction: 'up' | 'down' | 'left' | 'right' | 'home' | 'end',
    event: SelectionModifiers,
  ) => {
    if (visible.length === 0) return
    // The anchor is where the last deliberate click landed; `selectedPath` keeps
    // a Locate-in-File-Browser arrival navigable without a click first.
    const from = focusedPath ?? selectedPath ?? [...selected].at(-1)
    if (listing) {
      // A windowed list moves by position: the row above or below may not be drawn
      const slot = from ? listing.slotOf(from) : -1
      const step = { up: -columns, down: columns, left: -1, right: 1 } as const
      const target =
        direction === 'home'
          ? 0
          : direction === 'end'
            ? listing.count - 1
            : slot < 0
              ? 0
              : slot + step[direction]
      if (target < 0 || target >= listing.count) return
      reveal(target)
      const row = listing.at(target)
      pendingMove.current = null
      if (row) moveTo(row, event)
      else
        pendingMove.current = {
          slot: target,
          event: { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        }
      return
    }
    const index = visible.findIndex((entry) => entry.relative_path === from)
    // Up/Down move by row — in the card layout that is a row of cards, in the
    // list layout the next row is the next entry anyway. Left/Right step one
    // place along, which wraps a card row the way a file manager does.
    let nextPath: string | null = null
    if (direction === 'home' || direction === 'end') {
      nextPath = (direction === 'home' ? visible[0] : visible.at(-1))?.relative_path ?? null
    } else if (direction === 'up' || direction === 'down') {
      const targets = navTargetsFrom(
        wrapperRef.current ?? document,
        '[data-relpath]',
        (el) => el.dataset.relpath,
      )
      nextPath = rowStep(targets, from ?? null, direction)
    }
    if (nextPath === null) {
      const delta = direction === 'down' || direction === 'right' ? 1 : -1
      nextPath =
        visible[Math.max(0, Math.min(visible.length - 1, index < 0 ? 0 : index + delta))]
          ?.relative_path ?? null
    }
    const target = visible.find((entry) => entry.relative_path === nextPath)
    if (!target) return
    setFocusedPath(target.relative_path)
    if (event.shiftKey || (!event.metaKey && !event.ctrlKey)) clickEntry(target, event)
    scrollEl?.focus({ preventScroll: true })
    const item = wrapperRef.current?.querySelector(
      `[data-relpath="${CSS.escape(target.relative_path)}"]`,
    )
    item?.scrollIntoView({ block: 'nearest' })
    // Sticky headers occlude rows that scrollIntoView considers inside the viewport
    const stickyHeader = wrapperRef.current?.querySelector('.file-table__head')
    if (item && stickyHeader && scrollEl) {
      const overlap = stickyHeader.getBoundingClientRect().bottom - item.getBoundingClientRect().top
      if (overlap > 0) scrollEl.scrollBy({ top: -overlap, behavior: 'instant' })
    }
  }

  // Keyboard focus that lands on a row still being fetched moves there once it arrives
  const pendingMove = useRef<{ slot: number; event: SelectionModifiers } | null>(null)
  const moveTo = (row: FileBrowserEntry, event: SelectionModifiers) => {
    setFocusedPath(row.relative_path)
    if (event.shiftKey || (!event.metaKey && !event.ctrlKey)) clickEntry(row, event)
    scrollEl?.focus({ preventScroll: true })
  }
  useEffect(() => {
    const pending = pendingMove.current
    const row = pending ? listing?.at(pending.slot) : undefined
    if (!pending || !row) return
    pendingMove.current = null
    moveTo(row, pending.event)
  })

  // The focused listing owns selection keys while editors and overlays keep their commands
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!listingOwnsKey(event, scrollEl) || stale || openKey !== null || menu.state) return
      if (
        write.renamingPath ||
        write.creatingFolder ||
        write.conflict ||
        write.pendingDelete ||
        write.pendingMove ||
        sheetTarget
      )
        return
      const command = event.metaKey || event.ctrlKey
      if (command && !event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        selectAll()
        return
      }
      if (event.altKey) return
      const directions = {
        ArrowRight: 'right',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowUp: 'up',
        Home: 'home',
        End: 'end',
      } as const
      const direction = directions[event.key as keyof typeof directions]
      if (direction) {
        event.preventDefault()
        moveSelection(direction, event)
      } else if (catalogLibrary && event.key === 'Enter' && !command) {
        const entry = visible.find((item) => item.relative_path === focusedPath)
        if (entry) {
          event.preventDefault()
          openEntry(entry)
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        selectingAll?.abort.abort()
        setSelected(new Set())
        setFocusedPath(null)
        setAnchor(null)
        onSelectEntry(null)
      } else if (event.key === ' ' && command) {
        const entry = visible.find((item) => item.relative_path === focusedPath)
        if (entry) {
          event.preventDefault()
          clickEntry(entry, { metaKey: true, ctrlKey: false, shiftKey: false })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The focus ring follows navigation independently of the selected range
  useEffect(() => {
    wrapperRef.current?.querySelectorAll<HTMLElement>('[data-relpath]').forEach((element) => {
      element.dataset.focused = String(element.dataset.relpath === focusedPath)
    })
  })

  // Item size and New Folder come from the View and File menus in the desktop
  // shell. Handled here rather than in the shell root because this listing owns
  // both the zoom preference and the directory a folder would be created in.
  useDesktopMenu((action) => {
    if (action === 'zoom-in' || action === 'zoom-out') {
      const step = action === 'zoom-in' ? 10 : -10
      setPrefs((previous) => ({
        ...previous,
        zoom: Math.max(FILE_ZOOM_MIN, Math.min(FILE_ZOOM_MAX, previous.zoom + step)),
      }))
    } else if (action === 'new-folder' && canCreateFolder && !write.busy) {
      startNewFolder()
    }
  })
  useDesktopNewFolderAvailability(canCreateFolder && !stale)

  // F2 (and Enter, the macOS convention) renames the single selected entry;
  // Delete / ⌘⌫ moves the selection to the trash.
  const listKeyDown = (e: React.KeyboardEvent) => {
    if (write.renamingPath || write.creatingFolder) return
    if (canRename && (e.key === 'F2' || e.key === 'Enter')) {
      const only = selected.size === 1 ? [...selected][0] : null
      if (!only) return
      e.preventDefault()
      write.startRename(only)
      return
    }
    if (
      (writeMode || onSourceAction) &&
      (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)))
    ) {
      if (selected.size === 0) return
      e.preventDefault()
      const paths = [...selected]
      if (listing && paths.length > SOURCE_LIMIT) {
        onFlash?.(`Select up to ${SOURCE_LIMIT.toLocaleString()} items to move them to the Trash.`)
        return
      }
      if (onSourceAction) onSourceAction('trash', paths)
      else write.askToDelete(paths, linkedCount(paths))
    }
  }

  // Drag-out targets: the whole file selection when dragging a selected file in a
  // multi-selection, else just this file. Directories are never drag sources, and
  // any selected directory is filtered out (mirrors the context-menu rule).
  const dragTargets = (entry: FileBrowserEntry): string[] => {
    const targets = selectionTargets(entry.relative_path, selected).filter(
      (path) => entryByPath.get(path)?.kind === 'file',
    )
    if (listing && targets.length > SOURCE_LIMIT) {
      onFlash?.(`Drag up to ${SOURCE_LIMIT.toLocaleString()} files at a time.`)
      return []
    }
    return targets
  }
  const entryDragProps = (entry: FileBrowserEntry): FileDragProps => {
    // Directories are never drag sources. In list layout a row also starts the
    // rubber-band marquee (rows fill the width), so only an *already-selected* row
    // is a drag-out source there — a press-drag on an unselected row keeps starting
    // the marquee (selection-first, P0-2). Grid cards never start the marquee, so
    // they always drag.
    const canDrag =
      entry.kind === 'file' && (prefs.layout !== 'list' || selected.has(entry.relative_path))
    return fileDragProps(canDrag ? onStartFileDrag : undefined, () => dragTargets(entry))
  }

  // Rectangle-intersect against the live DOM rects of every selectable entry
  // (only files carry `data-relpath`) — simpler than Browser.tsx's row-math
  // since the file list/grid isn't virtualized, so every node is mounted.
  const hitTest = (rect: MarqueeRect): string[] => {
    if (listing) return windowHits(rect)
    const wrapperEl = wrapperRef.current
    if (!wrapperEl) return []
    const wrapperRect = wrapperEl.getBoundingClientRect()
    const ids: string[] = []
    for (const el of wrapperEl.querySelectorAll<HTMLElement>('[data-relpath]')) {
      const r = el.getBoundingClientRect()
      const cardRect: MarqueeRect = {
        left: r.left - wrapperRect.left,
        top: r.top - wrapperRect.top,
        width: r.width,
        height: r.height,
      }
      if (rectsIntersect(rect, cardRect)) ids.push(el.dataset.relpath as string)
    }
    return ids
  }

  const { marqueeRect, onMouseDown: onBackgroundMouseDown } = useMarqueeSelect({
    getScrollEl: () => scrollEl,
    getWrapperEl: () => wrapperRef.current,
    // Only true empty space starts a band; a tile or row is never a band origin.
    isBackgroundTarget: (target) =>
      !target.closest('.file-table__head') && !target.closest('[data-relpath]'),
    rubberBand: prefs.layout !== 'list',
    hitTest,
    getBaseSelection: () => selected,
    onChange: (ids) => {
      setSelected(new Set(ids))
      setFocusedPath(ids.at(-1) ?? null)
      setAnchor(ids.at(-1) ?? null)
      const lastId = ids.at(-1)
      const lastEntry = lastId ? (visible.find((e) => e.relative_path === lastId) ?? null) : null
      onSelectEntry(lastEntry)
    },
  })

  // A windowed list draws only the rows on screen; its size comes from the total
  const [geometry, setGeometry] = useState({ width: 0, margin: 0, head: 0, rowsTop: 0 })
  const rowsRef = useRef<HTMLDivElement | null>(null)
  const columns =
    listing && prefs.layout === 'grid'
      ? Math.max(1, Math.floor((geometry.width - GRID_GAP) / (prefs.zoom + GRID_GAP)))
      : 1
  const rowHeight =
    prefs.layout === 'grid' ? Math.round(prefs.zoom * 0.78) + GRID_GAP : listRowHeight(prefs.zoom)
  const rowCount = listing ? Math.ceil(listing.count / columns) : 0
  const windowed = listing !== undefined
  useLayoutEffect(() => {
    if (!windowed || !scrollEl) return
    const measure = () => {
      const rows = rowsRef.current
      const box = scrollEl.getBoundingClientRect()
      const top = rows ? rows.getBoundingClientRect().top : box.top
      const wrapper = wrapperRef.current?.getBoundingClientRect().top ?? top
      const head = wrapperRef.current?.querySelector('.file-table__head')
      const next = {
        width: scrollEl.clientWidth,
        margin: top - box.top + scrollEl.scrollTop,
        head: head ? head.getBoundingClientRect().height : 0,
        rowsTop: top - wrapper,
      }
      setGeometry((previous) =>
        previous.width === next.width &&
        previous.margin === next.margin &&
        previous.head === next.head &&
        previous.rowsTop === next.rowsTop
          ? previous
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scrollEl)
    if (rowsRef.current) observer.observe(rowsRef.current)
    return () => observer.disconnect()
    // Anything drawn above the rows moves them: the header, a notice or an error
  }, [windowed, scrollEl, prefs.layout, prefs.zoom, isError, isLoading, notice])
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns non-memoizable fns; safe here
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
    overscan: 6,
    scrollMargin: geometry.margin,
    // The list's sticky header covers the top of the viewport
    scrollPaddingStart: prefs.layout === 'list' ? geometry.head : 0,
  })
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, columns, virtualizer])
  const virtualRows = listing ? virtualizer.getVirtualItems() : []
  const firstRow = virtualRows[0]?.index ?? 0
  const lastRow = virtualRows.at(-1)?.index ?? 0
  const reportRange = useEffectEvent((first: number, last: number) => listing?.onRange(first, last))
  useEffect(() => {
    reportRange(firstRow * columns, (lastRow + 1) * columns - 1)
  }, [firstRow, lastRow, columns])
  // A new search or sort starts at the top of its list
  const listingIdentity = listing?.identity
  useLayoutEffect(() => {
    if (listingIdentity !== undefined && scrollEl) scrollEl.scrollTop = 0
  }, [listingIdentity, scrollEl])
  const reveal = (slot: number) =>
    virtualizer.scrollToIndex(Math.floor(slot / columns), { align: 'auto' })
  // Marquee hits by position, so rows scrolled out of the drawn window still count
  const windowHits = (rect: MarqueeRect): string[] => {
    if (!listing) return []
    const top = rect.top - geometry.rowsTop
    const first = Math.max(0, Math.floor(top / rowHeight))
    const last = Math.min(rowCount - 1, Math.floor((top + rect.height) / rowHeight))
    const cell = (geometry.width - GRID_GAP * (columns + 1)) / columns
    const hits: string[] = []
    for (let row = first; row <= last; row++)
      for (let column = 0; column < columns; column++) {
        const slot = row * columns + column
        const entry = listing.at(slot)
        if (!entry) continue
        const box: MarqueeRect =
          prefs.layout === 'grid'
            ? {
                left: GRID_GAP + column * (cell + GRID_GAP),
                top: geometry.rowsTop + row * rowHeight + GRID_GAP,
                width: cell,
                height: rowHeight - GRID_GAP,
              }
            : {
                left: 0,
                top: geometry.rowsTop + row * rowHeight,
                width: geometry.width,
                height: rowHeight,
              }
        if (rectsIntersect(rect, box)) hits.push(entry.relative_path)
      }
    return hits
  }

  const listed = listing ? listing.count : entries.length
  const gridStyle =
    prefs.layout === 'grid'
      ? {
          gridTemplateColumns: `repeat(auto-fill, minmax(${prefs.zoom}px, 1fr))`,
          gridAutoRows: `${Math.round(prefs.zoom * 0.78)}px`,
        }
      : undefined

  return (
    <>
      {/* Its own query container: a portable File Browser sits beside its inspector,
          outside `.center`, and the viewer and dialogs below are not portaled, so the
          whole browser cannot be one (containment would trap their fixed layout) */}
      <div className="file-browser__bar">
        <div className="toolbar" data-tauri-drag-region="deep">
          {header}
          <SelectionCount
            total={listing ? listing.count : visible.length}
            selected={selected.size}
            loaded={visible.length}
            more={listing ? visible.length < listing.count : hasMore === true}
            everything={Boolean(listing?.readAll)}
            selecting={selectingAll?.progress ?? null}
            noun="entries"
          />
          <span className="toolbar__spacer" />

          {/* Portable writes use callbacks; do not enable the retired upload routes. */}
          {onNewFolder && canCreateFolder && (
            <button className="btn btn--sm" onClick={startNewFolder} disabled={stale}>
              New Folder
            </button>
          )}
          {writeMode && scope === 'browse' && (
            <>
              <button
                className="btn btn--sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={write.busy}
                title="Copy files from this computer into this folder"
              >
                Add Files Here
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                aria-hidden="true"
                onChange={(event) => {
                  write.importFiles([...(event.target.files ?? [])])
                  // Reset, so choosing the same file twice in a row still fires.
                  event.target.value = ''
                }}
              />
            </>
          )}

          <input
            type="search"
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search files"
            title="Filter files in this view by name"
          />

          {/* Ahead of the buttons rather than among them (owner, 2026-09-01).
            Always shown — it drives card size in the grid and row height in the
            list — so the controls beside it don't shift with the layout. */}
          <div className="zoom">
            <input
              type="range"
              min={FILE_ZOOM_MIN}
              max={FILE_ZOOM_MAX}
              step={10}
              value={prefs.zoom}
              onChange={(e) => setPrefs({ ...prefs, zoom: Number(e.target.value) })}
              aria-label="Zoom"
            />
          </div>

          {/* The same control the Bundle Browser uses, so the two toolbars are one
            row of controls at one size — this was a bare select plus a separate
            arrow button (owner, 2026-09-01). */}
          {!fixedOrder && (
            <SortControl
              sort={activeSort.sort}
              order={activeSort.order}
              options={FILE_SORTS}
              onChange={setActiveSort}
              perCollection={folderKey === null ? undefined : prefs.sortScope === 'folder'}
              onPerCollection={
                folderKey === null
                  ? undefined
                  : (value) => setPrefs({ ...prefs, sortScope: value ? 'folder' : 'global' })
              }
              scopeLabel="Remember sort per folder"
            />
          )}

          <div className="seg toolbar__layouts" role="group" aria-label="Layout">
            <button
              className={prefs.layout === 'grid' ? 'is-active' : ''}
              onClick={() => setPrefs({ ...prefs, layout: 'grid' })}
              title="Card"
              aria-label="Card"
              aria-pressed={prefs.layout === 'grid'}
            >
              <IconLayoutCard />
            </button>
            <button
              className={prefs.layout === 'list' ? 'is-active' : ''}
              onClick={() => setPrefs({ ...prefs, layout: 'list' })}
              title="List"
              aria-label="List"
              aria-pressed={prefs.layout === 'list'}
            >
              <IconLayoutList />
            </button>
          </div>

          <ViewOptions
            onAddFiles={
              writeMode && scope === 'browse' ? () => fileInputRef.current?.click() : undefined
            }
            addFilesDisabled={write.busy}
            layout={prefs.layout}
            layouts={[
              { value: 'grid', label: 'Card' },
              { value: 'list', label: 'List' },
            ]}
            onLayout={(layout) => setPrefs({ ...prefs, layout })}
            zoom={prefs.zoom}
            min={FILE_ZOOM_MIN}
            max={FILE_ZOOM_MAX}
            onZoom={(zoom) => setPrefs({ ...prefs, zoom })}
          />
          {headerTrailing}
        </div>
      </div>

      <div
        className={`file-browser__body${marqueeRect ? ' file-browser__body--dragging' : ''}${
          dropActive ? ' file-browser__body--dropping' : ''
        }`}
        ref={setScrollEl}
        onMouseDownCapture={focusListing}
        // Row-based interaction is suspended while the listing is stale: a band
        // select or an arrow key would resolve against the previous folder's
        // entries. Path-based affordances below (drop, New Folder, the
        // background menu) stay live — they key off `path`, which is already the
        // folder being navigated to, so they are correct throughout.
        onMouseDown={stale || openKey !== null ? undefined : onBackgroundMouseDown}
        onContextMenu={contextBackground}
        onKeyDown={stale ? undefined : listKeyDown}
        onDragOver={writeMode && scope === 'browse' ? onDragOverFiles : undefined}
        onDragLeave={writeMode && scope === 'browse' ? () => setDropActive(false) : undefined}
        onDrop={writeMode && scope === 'browse' ? onDropFiles : undefined}
        // Focusable so F2/Enter reach the list without stealing the tab order
        // from the toolbar controls above it.
        tabIndex={0}
        role={prefs.layout === 'list' ? 'grid' : 'listbox'}
        // A windowed list draws a few rows of many; the count says how many there are
        aria-rowcount={listing && prefs.layout === 'list' ? listing.count + 1 : undefined}
        aria-label="Files"
        aria-activedescendant={
          focusedPath ? `file-option-${encodeURIComponent(focusedPath)}` : undefined
        }
        aria-multiselectable="true"
      >
        {/* Above the listing rather than inside it: the new folder has no
            position in the current sort until it has a name. */}
        {write.creatingFolder && (
          <div
            className="file-newfolder"
            role={prefs.layout === 'list' ? 'row' : 'option'}
            aria-selected="true"
          >
            <div
              className="file-newfolder__name"
              role={prefs.layout === 'list' ? 'gridcell' : undefined}
            >
              <span className="file-row__icon">
                <IconFolder />
              </span>
              <NameEditor
                initial={refusedFolder?.name ?? 'Untitled'}
                initialError={refusedFolder?.error}
                label="New folder name"
                validate={validateNewFolder}
                onSubmit={submitNewFolder}
                onCancel={cancelNewFolder}
              />
            </div>
          </div>
        )}
        {isError && (
          <div className="empty empty--error" role="alert">
            {errorText ?? 'Could not load files.'}{' '}
            {entries.length > 0 ? 'Showing cached files. ' : ''}
            <button className="btn" onClick={onRetry}>
              Retry files
            </button>
          </div>
        )}
        {notice && entries.length > 0 && (
          <div className="empty" role="status">
            {notice}
          </div>
        )}
        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : isError && listed === 0 ? null : listed === 0 ? (
          !write.creatingFolder && (
            <div className="empty">
              {emptyText}
              {search ? (
                <button className="btn" onClick={() => setSearch('')}>
                  Clear search
                </button>
              ) : canCreateFolder ? (
                <button className="btn" disabled={stale} onClick={startNewFolder}>
                  Create folder
                </button>
              ) : (
                <button className="btn" onClick={onRetry}>
                  Refresh files
                </button>
              )}
            </div>
          )
        ) : visible.length === 0 && !listing ? (
          <div className="empty">
            No files match “{search}”.{' '}
            <button className="btn" onClick={() => setSearch('')}>
              Clear search
            </button>
          </div>
        ) : (
          <>
            <div
              className={`file-browser__wrapper${stale ? ' listing--stale listing--inert' : ''}`}
              ref={wrapperRef}
              aria-busy={stale}
            >
              {marqueeRect && (
                <div
                  className="marquee"
                  style={{
                    position: 'absolute',
                    left: marqueeRect.left,
                    top: marqueeRect.top,
                    width: marqueeRect.width,
                    height: marqueeRect.height,
                    pointerEvents: 'none',
                  }}
                />
              )}
              {prefs.layout === 'list' ? (
                <div
                  className="file-table"
                  style={{ ['--file-row-h' as string]: `${listRowHeight(prefs.zoom)}px` }}
                >
                  {/* Clicking a header sorts by that column, the way every file
                      manager's list view does (owner, 2026-09-01); the toolbar
                      control and these are one preference. */}
                  <div className="file-table__head" role="row">
                    {FILE_SORTS.map((column) =>
                      fixedOrder ? (
                        <span
                          key={column.value}
                          role="columnheader"
                          className={column.value === 'size' ? 'file-table__num' : undefined}
                        >
                          <span className="colhead">{column.label}</span>
                        </span>
                      ) : (
                        <SortHeaderCell
                          key={column.value}
                          label={column.label}
                          value={column.value}
                          sort={activeSort.sort}
                          order={activeSort.order}
                          onSort={setActiveSort}
                          className={column.value === 'size' ? 'file-table__num' : undefined}
                        />
                      ),
                    )}
                  </div>
                  {listing ? (
                    <div
                      ref={rowsRef}
                      className="file-window"
                      style={{ height: virtualizer.getTotalSize() }}
                    >
                      {virtualRows.map((row) => {
                        const entry = listing.at(row.index)
                        return (
                          <div
                            key={row.key}
                            className="file-window__slot"
                            style={{ top: row.start - geometry.margin, height: row.size }}
                          >
                            {entry ? (
                              <FileRow
                                entry={entry}
                                position={row.index}
                                label={labelFor(entry)}
                                selected={selected.has(entry.relative_path)}
                                onClick={(e) => clickEntry(entry, e)}
                                onDoubleClick={() => openEntry(entry)}
                                onContextMenu={(e) => contextRow(entry, e)}
                                dragProps={entryDragProps(entry)}
                                renaming={canRename && write.renamingPath === entry.relative_path}
                                onRename={(name) => submitRename(entry.relative_path, name)}
                                onCancelRename={write.cancelRename}
                              />
                            ) : (
                              <div
                                className="file-row file-row--placeholder"
                                role="row"
                                aria-busy="true"
                                aria-rowindex={row.index + 2}
                              >
                                <span role="gridcell" className="file-row__name">
                                  Loading…
                                </span>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                  {!listing &&
                    visible.map((entry) => (
                      <FileRow
                        key={entry.relative_path}
                        entry={entry}
                        pending={arriving(entry)}
                        label={labelFor(entry)}
                        selected={selected.has(entry.relative_path)}
                        onClick={(e) => clickEntry(entry, e)}
                        onDoubleClick={() => openEntry(entry)}
                        onContextMenu={(e) => contextRow(entry, e)}
                        dragProps={entryDragProps(entry)}
                        renaming={canRename && write.renamingPath === entry.relative_path}
                        onRename={(name) => submitRename(entry.relative_path, name)}
                        onCancelRename={write.cancelRename}
                      />
                    ))}
                </div>
              ) : listing ? (
                <div
                  ref={rowsRef}
                  className="file-window"
                  style={{ height: virtualizer.getTotalSize() + GRID_GAP }}
                >
                  {virtualRows.map((row) => (
                    <div
                      key={row.key}
                      className="file-grid file-window__slot"
                      style={{
                        top: row.start - geometry.margin,
                        height: row.size,
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                        gridAutoRows: `${row.size - GRID_GAP}px`,
                        padding: `${GRID_GAP}px ${GRID_GAP}px 0`,
                      }}
                    >
                      {Array.from({ length: columns }, (_, column) => {
                        const slot = row.index * columns + column
                        if (slot >= listing.count) return null
                        const entry = listing.at(slot)
                        return entry ? (
                          <FileCard
                            key={entry.relative_path}
                            entry={entry}
                            position={{ index: slot, size: listing.count }}
                            label={labelFor(entry)}
                            selected={selected.has(entry.relative_path)}
                            onClick={(e) => clickEntry(entry, e)}
                            onDoubleClick={() => openEntry(entry)}
                            onContextMenu={(e) => contextRow(entry, e)}
                            previewDisabled={marqueeRect !== null || menu.state !== null}
                            dragProps={entryDragProps(entry)}
                            renaming={canRename && write.renamingPath === entry.relative_path}
                            onRename={(name) => submitRename(entry.relative_path, name)}
                            onCancelRename={write.cancelRename}
                          />
                        ) : (
                          <div
                            key={`slot-${slot}`}
                            className="card card--placeholder"
                            role="option"
                            aria-selected="false"
                            aria-busy="true"
                            aria-setsize={listing.count}
                            aria-posinset={slot + 1}
                            aria-label="Loading…"
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="file-grid" style={gridStyle}>
                  {visible.map((entry) => (
                    <FileCard
                      key={entry.relative_path}
                      entry={entry}
                      pending={arriving(entry)}
                      label={labelFor(entry)}
                      selected={selected.has(entry.relative_path)}
                      onClick={(e) => clickEntry(entry, e)}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(e) => contextRow(entry, e)}
                      previewDisabled={marqueeRect !== null || menu.state !== null}
                      dragProps={entryDragProps(entry)}
                      renaming={canRename && write.renamingPath === entry.relative_path}
                      onRename={(name) => submitRename(entry.relative_path, name)}
                      onCancelRename={write.cancelRename}
                    />
                  ))}
                </div>
              )}
            </div>
            {hasMore && (
              <button
                className="btn file-browser__more"
                onClick={onLoadMore}
                disabled={isFetchingMore}
              >
                {isFetchingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}

        <ContextMenu state={menu.state} onClose={menu.close} />
        {(sheetTarget ?? localSheet.target) && (
          <ContactSheetDialog
            target={(sheetTarget ?? localSheet.target)!}
            onClose={() => {
              setSheetTarget(null)
              localSheet.close()
            }}
            onReport={(message) => message !== null && onFlash?.(message)}
          />
        )}

        {write.conflict && (
          <ConflictDialog
            name={write.conflict.conflictingName}
            onKeepBoth={write.keepBoth}
            onReplace={write.replace}
            onCancel={write.dismissConflict}
            busy={write.busy}
          />
        )}

        {write.pendingDelete && (
          <DeleteDialog
            paths={write.pendingDelete.paths}
            linkedCount={write.pendingDelete.linkedCount}
            onConfirm={write.confirmDelete}
            onCancel={write.dismissDelete}
            busy={write.busy}
          />
        )}

        {write.pendingMove && (
          <DirectoryPicker
            moving={write.pendingMove.paths}
            onChoose={write.moveTo}
            onCancel={write.dismissMove}
            busy={write.busy}
          />
        )}

        {openIndex >= 0 && catalogLibrary && (
          <ReplicaViewer
            library={catalogLibrary}
            folder={{ entries: openable, title: viewerTitle }}
            target={{
              fileId: openable[openIndex]!.file_id ?? undefined,
              relativePath: openable[openIndex]!.relative_path,
            }}
            onClose={() => setOpenKey(null)}
          />
        )}
        {openIndex >= 0 && !catalogLibrary && (
          <FileEntryViewer
            files={openable}
            index={openIndex}
            onIndex={(index) => {
              const entry = openable[index]
              if (entry) setOpenKey(fileEntryKey(entry))
            }}
            onClose={() => setOpenKey(null)}
            title={viewerTitle}
            playerPrefs={playerPrefs}
            onPlayerPrefs={onPlayerPrefs}
          />
        )}
      </div>
    </>
  )
}

function FileRow({
  entry,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  dragProps,
  renaming,
  onRename,
  onCancelRename,
  label,
  pending = false,
  position,
}: {
  /** A folder still being created: shown, but not yet openable. */
  pending?: boolean
  /** The row's place in a windowed list, which draws only some of its rows. */
  position?: number
  entry: FileBrowserEntry
  /** The name as displayed — may have its extension hidden (a display pref). */
  label: string
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  dragProps: FileDragProps
  renaming: boolean
  onRename: (name: string) => void | Promise<void>
  onCancelRename: () => void
}) {
  const isDir = entry.kind === 'directory'
  return (
    <div
      className={`file-row${selected ? ' file-row--selected' : ''}`}
      aria-busy={pending || undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="row"
      aria-selected={selected}
      // The header is row 1
      aria-rowindex={position === undefined ? undefined : position + 2}
      id={`file-option-${encodeURIComponent(entry.relative_path)}`}
      data-relpath={entry.relative_path}
      // A row being renamed must not also be a drag source: the pointer belongs
      // to the text field while a name is being edited.
      {...(renaming ? {} : dragProps)}
    >
      <span role="gridcell" className="file-row__name">
        <span className="file-row__icon">
          <EntryThumb
            entry={entry}
            className="file-row__thumb"
            holderClassName="file-row__thumb-holder"
            fallback={entryIcon(entry)}
          />
        </span>
        {renaming ? (
          <NameEditor
            initial={entry.name}
            label={`Rename ${entry.name}`}
            onSubmit={onRename}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="file-row__text">{label}</span>
        )}
        {/* Only the exception is shown: a catalog entry this device did not find.
            Present files carry no availability text. */}
        {entry.local_state === 'unavailable' && (
          <span className="badge badge--missing" title="Not found on this device">
            missing
          </span>
        )}
        {!isDir && !entry.supported && <span className="badge">unsupported</span>}
        {/* Bundle status: flag files that still need attention. A file already in
            a confirmed bundle shows no status badge. */}
        {!isDir && !entry.linked && <span className="badge badge--warn">unlinked</span>}
        {!isDir && entry.unbundled && <span className="badge badge--warn">unbundled</span>}
      </span>
      <span role="gridcell" className="file-row__type">
        {isDir ? 'Folder' : (entry.extension ?? 'file')}
      </span>
      <span role="gridcell" className="file-table__num">
        {isDir ? '' : formatBytes(entry.size_bytes)}
      </span>
      <span role="gridcell" className="file-row__added">
        {entry.created_at ? formatDate(entry.created_at) : ''}
      </span>
      <span role="gridcell" className="file-row__modified">
        {entry.modified_at ? formatDate(entry.modified_at) : ''}
      </span>
    </div>
  )
}

/** Card tile for grid layout — same visual language as BundleCard (icon in
 * place of a thumbnail, since physical files don't carry a cover image). */
function FileCard({
  entry,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  previewDisabled,
  dragProps,
  renaming,
  onRename,
  onCancelRename,
  label,
  pending = false,
  position,
}: {
  /** A folder still being created: shown, but not yet openable. */
  pending?: boolean
  /** The card's place in a windowed list, which draws only some of its cards. */
  position?: { index: number; size: number }
  entry: FileBrowserEntry
  /** The name as displayed — may have its extension hidden (a display pref). */
  label: string
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  previewDisabled: boolean
  dragProps: FileDragProps
  renaming: boolean
  onRename: (name: string) => void | Promise<void>
  onCancelRename: () => void
}) {
  const isDir = entry.kind === 'directory'
  const previewSource = useMemo<HoverPreviewSource | null>(
    () =>
      // A portable entry previews only what this device last inspected and
      // still finds unchanged; the server omits the details otherwise.
      entry.local_state === 'unavailable'
        ? null
        : entry.media_kind === 'video' && entry.file_id && entry.duration
          ? {
              mediaKind: 'video',
              fileId: entry.file_id,
              mimeType: entry.mime_type,
              relativePath: entry.relative_path,
              container: entry.container,
              videoCodec: entry.video_codec,
              videoCodecTag: entry.video_codec_tag,
              bitDepth: entry.bit_depth,
              audioCodec: entry.audio_codec,
              duration: entry.duration,
              startTime: entry.resume_position,
              storyboardVersion: entry.storyboard_version,
              generation: entry.generation,
            }
          : null,
    [
      entry.local_state,
      entry.generation,
      entry.storyboard_version,
      entry.audio_codec,
      entry.bit_depth,
      entry.container,
      entry.duration,
      entry.file_id,
      entry.media_kind,
      entry.mime_type,
      entry.relative_path,
      entry.resume_position,
      entry.video_codec,
      entry.video_codec_tag,
    ],
  )
  return (
    <div
      className={`card${selected ? ' card--selected' : ''}`}
      aria-busy={pending || undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="option"
      aria-selected={selected}
      aria-setsize={position?.size}
      aria-posinset={position === undefined ? undefined : position.index + 1}
      id={`file-option-${encodeURIComponent(entry.relative_path)}`}
      data-relpath={entry.relative_path}
      {...(renaming ? {} : dragProps)}
    >
      <HoverPreview source={previewSource} disabled={previewDisabled} className="card__thumb">
        <EntryThumb
          entry={entry}
          className="card__thumb-img"
          holderClassName="card__thumb-holder"
          fallback={
            <div className="card__placeholder card__placeholder--icon">{entryIcon(entry)}</div>
          }
        />
        {/* The corner holds one badge; a file this device did not find outranks
            its bundle status, as a missing bundle member does on a bundle card. */}
        {entry.local_state === 'unavailable' ? (
          <span className="card__badge card__badge--missing" title="Not found on this device">
            missing
          </span>
        ) : !isDir && !entry.linked ? (
          <span className="card__badge card__badge--missing">unlinked</span>
        ) : !isDir && entry.unbundled ? (
          <span className="card__badge card__badge--review">unbundled</span>
        ) : null}
      </HoverPreview>
      <div className="card__meta">
        {renaming ? (
          <NameEditor
            initial={entry.name}
            label={`Rename ${entry.name}`}
            onSubmit={onRename}
            onCancel={onCancelRename}
          />
        ) : (
          <div className="card__title">{label}</div>
        )}
        <div className="card__sub">
          <span>{isDir ? 'Folder' : formatFileType(entry.media_kind ?? 'other', entry.name)}</span>
          {!isDir && <span>{formatBytes(entry.size_bytes)}</span>}
          {!isDir && entry.duration != null && entry.duration > 0 && (
            <span>{formatDuration(entry.duration)}</span>
          )}
        </div>
      </div>
    </div>
  )
}
