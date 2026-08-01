import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { FileBrowserEntry, SortOrder } from '../api/client'
import { fileBrowserPreviewUrl, fileThumbnailUrl } from '../api/client'
import { useFileBrowser, useUnbundledFiles } from '../api/hooks'
import { formatBytes, formatDate, formatDuration, formatFileType } from '../lib/format'
import type { HostLabels } from '../platform'
import { displayName, useDisplayPrefs } from '../state/displayPrefs'
import { usePersistentState } from '../state/usePersistentState'
import { ContextMenu } from './ContextMenu'
import { type FileDragProps, fileDragProps } from './dragOut'
import { markHtmlFileDropHandled } from './htmlFileDrop'
import { FileEntryViewer } from './FileEntryViewer'
import { contactSheetMenuItem, type ContactSheetTarget } from './contactSheetExport'
import { ContactSheetDialog } from './ContactSheetDialog'
import { useFileWriteActions } from './fileWriteActions'
import { ConflictDialog, DeleteDialog, DirectoryPicker, NameEditor } from './FileWriteDialogs'
import { hostFileMenuEntries } from './hostActions'
import { HoverPreview } from './HoverPreview'
import type { HoverPreviewSource } from './hoverPreviewState'
import { IconCaptions, IconFile, IconFilm, IconFolder, IconImage, IconMusic } from './icons'
import { listRowHeight } from './layout'
import { usePinyinSearch } from './pinyin'
import { selectionTargets, suppressShiftSelection } from './selection'
import { type MenuEntry, useContextMenu } from './useContextMenu'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'
import type { PlayerPrefs } from './types'

// File Browser mirrors the bundle browser's toolbar, but with file-appropriate
// sort fields (bundles' rating/file-count/date-added don't apply) and only
// grid/list layouts (justified needs image aspect ratios files don't carry).
type FileSort = 'name' | 'type' | 'size' | 'added' | 'modified'
type FileLayout = 'list' | 'grid'

interface FilePrefs {
  layout: FileLayout
  zoom: number // target card width in px (grid only)
  sort: FileSort
  order: SortOrder
}

const DEFAULT_FILE_PREFS: FilePrefs = { layout: 'list', zoom: 200, sort: 'name', order: 'asc' }

const FILE_SORTS: { value: FileSort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'size', label: 'Size' },
  { value: 'added', label: 'Date Added' },
  { value: 'modified', label: 'Date Modified' },
]

interface FileBrowserProps {
  /** Leading header controls — the Back/Forward history buttons. */
  headerLeading?: ReactNode
  libraryName: string
  // 'browse' = the directory tree; 'unbundled' = the flat "to-bundle queue".
  scope: 'browse' | 'unbundled'
  path: string
  selectedPath: string | null
  onNavigate: (path: string) => void
  onSelectEntry: (entry: FileBrowserEntry | null) => void
  // Manual bundling actions on selected file paths (unlinked ones auto-linked).
  onAddToBundle: (relativePaths: string[]) => void
  onCreateBundle: (relativePaths: string[]) => void
  hostLabels: HostLabels
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onRevealFile?: (relativePath: string) => void
  onOpenFile?: (relativePath: string) => void
  // Jump to this file's owning confirmed bundle in Bundle Browser
  onLocateBundle?: (bundleId: string) => void
  // Drag file(s) out to Finder/other apps (plan 3 §6); undefined disables it.
  onStartFileDrag?: (relativePaths: string[]) => void
  // Whether guarded write operations are permitted for this library right now
  // (ADR-0013: the per-library opt-in *and* the deployment switch). False keeps
  // the browser exactly as it was before write mode existed.
  writeMode?: boolean
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
  if (entry.kind === 'directory') return null
  if (entry.file_id && entry.bundle_id) return fileThumbnailUrl(entry.bundle_id, entry.file_id)
  if (entry.media_kind === 'image') return fileBrowserPreviewUrl(entry.relative_path, 640)
  return null
}

/**
 * One entry's still image, falling back to `fallback` when it has none or the
 * server cannot produce one — an unprobed or undecodable file answers 503, and
 * the icon is a better answer than a broken image.
 *
 * **Only requested once on screen.** Neither the file grid nor the file list is
 * virtualized, so every row in a folder mounts at once; asking for all of their
 * thumbnails immediately saturated the browser's per-origin connections and made
 * everything sharing them — video loads above all — wait behind frame
 * extractions nobody was looking at (owner: "videos take longer to load",
 * 2026-07-27).
 *
 * `loading="lazy"` was the first attempt and does not work here: verified in a
 * real browser, an in-viewport thumbnail inside the listing's own scroll
 * container stayed unloaded through scrolling and only appeared once forced
 * eager. So visibility is observed directly, which also makes the behavior
 * ours to test rather than the browser's to decide.
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
  const [visible, setVisible] = useState(false)
  const holderRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const node = holderRef.current
    if (!node || visible) return
    // Generous margin so a thumbnail is in flight by the time it is scrolled to,
    // without reaching the whole folder.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true)
      },
      { rootMargin: '200px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible])

  if (!src || failedSrc === src) return <>{fallback}</>
  return (
    <span ref={holderRef} className={holderClassName}>
      {visible ? (
        <img
          className={className}
          src={src}
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
 * cross-library list of files awaiting bundling. Files can be right-clicked to
 * add them to / create a bundle (metadata-only; no move/rename/delete on disk).
 */
export function FileBrowser(props: FileBrowserProps) {
  return props.scope === 'unbundled' ? <UnbundledScope {...props} /> : <BrowseScope {...props} />
}

function BrowseScope(props: FileBrowserProps) {
  const { headerLeading, libraryName, path, onNavigate } = props
  const qc = useQueryClient()
  const query = useFileBrowser(path)
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
      <nav className="file-browser__crumbs" aria-label="Breadcrumb">
        <button className="crumb" onClick={() => onNavigate('')} disabled={!path}>
          {libraryName}
        </button>
        {crumbs(path).map((c) => (
          <span key={c.path}>
            <span className="crumb__sep">/</span>
            <button className="crumb" onClick={() => onNavigate(c.path)}>
              {c.label}
            </button>
          </span>
        ))}
      </nav>
    </>
  )

  return (
    <div className="file-browser">
      <FileList
        key={`browse:${path}`}
        header={header}
        entries={entries}
        isLoading={query.isLoading}
        isError={query.isError}
        errorText={query.error instanceof Error ? query.error.message : undefined}
        emptyText="This folder is empty."
        {...props}
      />
    </div>
  )
}

function UnbundledScope(props: FileBrowserProps) {
  const query = useUnbundledFiles()
  const entries = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data])

  return (
    <div className="file-browser">
      <FileList
        key="unbundled"
        header={
          <>
            {props.headerLeading}
            <span className="toolbar__title">Unbundled</span>
          </>
        }
        entries={entries}
        isLoading={query.isLoading}
        isError={query.isError}
        errorText={query.error instanceof Error ? query.error.message : undefined}
        emptyText="Nothing to bundle — every file is already in a bundle."
        hasMore={query.hasNextPage}
        isFetchingMore={query.isFetchingNextPage}
        onLoadMore={() => query.fetchNextPage()}
        {...props}
      />
    </div>
  )
}

interface FileListProps extends FileBrowserProps {
  header: ReactNode
  entries: FileBrowserEntry[]
  isLoading: boolean
  isError: boolean
  errorText?: string
  emptyText: string
  hasMore?: boolean
  isFetchingMore?: boolean
  onLoadMore?: () => void
}

/** The selectable, right-clickable table/grid of file/dir entries shared by
 * both scopes, with a bundle-browser-style toolbar (search / sort / layout /
 * zoom). Local selection + search are reset by remount (the caller keys it by
 * scope/path); layout/sort/zoom persist. Single click selects (drives the
 * inspector); double click navigates into a folder or opens a file. Only files
 * participate in the bundling context menu and drag-select. */
function FileList({
  header,
  entries,
  isLoading,
  isError,
  errorText,
  emptyText,
  hasMore,
  isFetchingMore,
  onLoadMore,
  selectedPath,
  onNavigate,
  onSelectEntry,
  onAddToBundle,
  onCreateBundle,
  hostLabels,
  onRevealFile,
  onOpenFile,
  onLocateBundle,
  onStartFileDrag,
  scope,
  path: currentPath,
  writeMode = false,
  onFlash,
  onImportFiles,
  libraryName,
  playerPrefs,
  onPlayerPrefs,
}: FileListProps) {
  const menu = useContextMenu()
  // The file whose contact-sheet options are open, if any.
  const [sheetTarget, setSheetTarget] = useState<ContactSheetTarget | null>(null)
  const write = useFileWriteActions({
    currentPath,
    onFlash: onFlash ?? (() => undefined),
    onImportFiles,
  })
  // New Folder needs a directory to create *in*, which the flat unbundled queue
  // does not have. Renaming works in both scopes — a path is a path.
  const canCreateFolder = writeMode && scope === 'browse'
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Anchor for Shift-range selection (the last plainly-clicked file).
  const [anchor, setAnchor] = useState<string | null>(null)
  const [prefs, setPrefs] = usePersistentState<FilePrefs>('cairndex.filePrefs', DEFAULT_FILE_PREFS)
  const [displayPrefs] = useDisplayPrefs()
  // The *displayed* name only. Renaming, search and every operation keep using
  // `entry.name`, so hiding extensions can never change what an action does.
  const labelFor = (entry: FileBrowserEntry) =>
    displayName(entry.name, entry.kind === 'directory', displayPrefs.hideFileExtensions)
  const [search, setSearch] = useState('')
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
    const q = search.trim()
    const filtered = q ? entries.filter((e) => matchSearch(e.name)) : entries
    const dir = prefs.order === 'asc' ? 1 : -1
    const cmp = (a: FileBrowserEntry, b: FileBrowserEntry) => compareEntries(a, b, prefs.sort) * dir
    const dirs = filtered.filter((e) => e.kind === 'directory').sort(cmp)
    const files = filtered.filter((e) => e.kind !== 'directory').sort(cmp)
    return [...dirs, ...files]
  }, [entries, search, prefs.sort, prefs.order, matchSearch])

  const openable = useMemo(() => visible.filter((e) => e.kind === 'file' && e.supported), [visible])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
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
  const clickEntry = (entry: FileBrowserEntry, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const ids = visible.map((v) => v.relative_path)
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(entry.relative_path)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const range = visible.slice(lo, hi + 1).map((v) => v.relative_path)
        setSelected(new Set(range))
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

  const openEntry = (entry: FileBrowserEntry) => {
    if (entry.kind === 'directory') {
      onNavigate(entry.relative_path)
      return
    }
    if (entry.supported) {
      const idx = openable.findIndex((e) => e.relative_path === entry.relative_path)
      if (idx >= 0) setOpenIndex(idx)
    }
  }

  // Rename is the one action a directory has, so a directory's context menu now
  // exists at all — it used to return early because bundling acts on files only.
  const contextDirectory = (entry: FileBrowserEntry, e: React.MouseEvent) => {
    setSelected(new Set([entry.relative_path]))
    onSelectEntry(entry)
    const items: MenuEntry[] = [
      { label: 'Copy Path', onClick: () => copyPath(entry.relative_path) },
      null,
      { label: 'Rename…', onClick: () => write.startRename(entry.relative_path) },
      { label: 'Move to…', onClick: () => write.askToMove([entry.relative_path]) },
      // A folder's own delete takes everything inside it, in one operation.
      { label: 'Move to Trash', onClick: () => write.askToDelete([entry.relative_path], 0) },
    ]
    if (canCreateFolder) items.push({ label: 'New Folder', onClick: write.startNewFolder })
    menu.open(e, items)
  }

  const contextRow = (entry: FileBrowserEntry, e: React.MouseEvent) => {
    if (entry.kind === 'directory') {
      if (writeMode) contextDirectory(entry, e)
      return // bundling acts on files only
    }
    const inSelection = selected.has(entry.relative_path)
    // The selection can now include directories (drag/shift-select), so restrict
    // the bundling targets to files.
    const filePaths = new Set(visible.filter((v) => v.kind === 'file').map((v) => v.relative_path))
    const targets = selectionTargets(entry.relative_path, selected).filter((p) => filePaths.has(p))
    if (!inSelection) {
      setSelected(new Set([entry.relative_path]))
      onSelectEntry(entry)
    }
    const n = targets.length
    const items: MenuEntry[] = []
    if (n === 1) {
      const hostItems = hostFileMenuEntries(
        hostLabels,
        { onOpenFile, onRevealFile },
        targets[0] as string,
      )
      if (hostItems.length > 0) items.push(...hostItems)
    }
    if (writeMode) {
      const writeItems: MenuEntry[] = []
      // Rename acts on one entry; a multi-selection has no single new name.
      if (n === 1)
        writeItems.push({
          label: 'Rename…',
          onClick: () => write.startRename(targets[0] as string),
        })
      // Move takes the whole selection, directories included — unlike bundling,
      // which is a files-only action.
      const moveTargets = selectionTargets(entry.relative_path, selected)
      writeItems.push({
        label: moveTargets.length > 1 ? `Move ${moveTargets.length} Items…` : 'Move to…',
        onClick: () => write.askToMove(moveTargets),
      })
      writeItems.push({
        label: n > 1 ? `Move ${n} Files to Trash` : 'Move to Trash',
        onClick: () => write.askToDelete(targets, linkedCount(targets)),
      })
      if (canCreateFolder) writeItems.push({ label: 'New Folder', onClick: write.startNewFolder })
      if (writeItems.length > 0) {
        if (items.length > 0) items.push(null)
        items.push(...writeItems)
      }
    }
    if (items.length > 0) items.push(null)
    items.push(
      {
        label: n > 1 ? `Create Bundle from ${n} Files…` : 'Create Bundle…',
        onClick: () => onCreateBundle(targets),
      },
      {
        label: n > 1 ? `Add ${n} Files to Bundle…` : 'Add to Bundle…',
        onClick: () => onAddToBundle(targets),
      },
    )
    if (n === 1) {
      const owningBundleId = entry.bundle_id
      if (onLocateBundle && owningBundleId && !entry.unbundled) {
        items.push({
          label: 'Locate in Bundle Browser',
          onClick: () => onLocateBundle(owningBundleId),
        })
      }
    }
    items.push(null, {
      label: 'Copy Path',
      disabled: n > 1,
      onClick: () => copyPath(entry.relative_path),
    })
    // An unindexed video has no file row for the server to cut a sheet from
    if (n === 1 && entry.media_kind === 'video' && entry.file_id) {
      items.push(
        null,
        contactSheetMenuItem(
          {
            fileId: entry.file_id,
            title: entry.name,
            sizeBytes: entry.size_bytes,
            duration: entry.duration,
            mimeType: entry.mime_type,
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
    menu.open(e, items)
  }

  // Right-clicking empty space is where New Folder is expected to live.
  const contextBackground = (e: React.MouseEvent) => {
    if (!canCreateFolder) return
    if ((e.target as HTMLElement).closest('[data-relpath]')) return // a row handles its own
    e.preventDefault()
    menu.open(e, [{ label: 'New Folder', onClick: write.startNewFolder }])
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
    visible.filter((entry) => paths.includes(entry.relative_path) && entry.linked).length

  // F2 (and Enter, the macOS convention) renames the single selected entry;
  // Delete / ⌘⌫ moves the selection to the trash.
  const listKeyDown = (e: React.KeyboardEvent) => {
    if (!writeMode || write.renamingPath || write.creatingFolder) return
    if (e.key === 'F2' || e.key === 'Enter') {
      const only = selected.size === 1 ? [...selected][0] : null
      if (!only) return
      e.preventDefault()
      write.startRename(only)
      return
    }
    if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) {
      if (selected.size === 0) return
      e.preventDefault()
      const paths = [...selected]
      write.askToDelete(paths, linkedCount(paths))
    }
  }

  // Drag-out targets: the whole file selection when dragging a selected file in a
  // multi-selection, else just this file. Directories are never drag sources, and
  // any selected directory is filtered out (mirrors the context-menu rule).
  const dragTargets = (entry: FileBrowserEntry): string[] => {
    const filePaths = new Set(visible.filter((v) => v.kind === 'file').map((v) => v.relative_path))
    return selectionTargets(entry.relative_path, selected).filter((p) => filePaths.has(p))
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
      const lastId = ids.at(-1)
      const lastEntry = lastId ? (visible.find((e) => e.relative_path === lastId) ?? null) : null
      onSelectEntry(lastEntry)
    },
  })

  const gridStyle =
    prefs.layout === 'grid'
      ? {
          gridTemplateColumns: `repeat(auto-fill, minmax(${prefs.zoom}px, 1fr))`,
          gridAutoRows: `${Math.round(prefs.zoom * 0.78)}px`,
        }
      : undefined

  return (
    <>
      <div className="toolbar" data-tauri-drag-region="deep">
        {header}
        <span className="toolbar__count">{visible.length.toLocaleString()} items</span>
        <span className="toolbar__spacer" />

        {canCreateFolder && (
          <>
            <button
              className="btn btn--sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={write.busy}
              title="Copy files from this computer into this folder"
            >
              Add Files…
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
            <button
              className="btn btn--sm"
              onClick={write.startNewFolder}
              disabled={write.busy}
              title="Create a folder in this directory"
            >
              New Folder
            </button>
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

        <select
          value={prefs.sort}
          onChange={(e) => setPrefs({ ...prefs, sort: e.target.value as FileSort })}
          aria-label="Sort by"
        >
          {FILE_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          className="seg"
          style={{ padding: '5px 8px', cursor: 'pointer' }}
          onClick={() => setPrefs({ ...prefs, order: prefs.order === 'desc' ? 'asc' : 'desc' })}
          aria-label="Toggle sort order"
          title="Toggle sort order"
        >
          {prefs.order === 'desc' ? '↓' : '↑'}
        </button>

        <div className="seg" role="group" aria-label="Layout">
          <button
            className={prefs.layout === 'grid' ? 'is-active' : ''}
            onClick={() => setPrefs({ ...prefs, layout: 'grid' })}
            title="Grid"
            aria-label="Grid"
            aria-pressed={prefs.layout === 'grid'}
          >
            ▦
          </button>
          <button
            className={prefs.layout === 'list' ? 'is-active' : ''}
            onClick={() => setPrefs({ ...prefs, layout: 'list' })}
            title="List"
            aria-label="List"
            aria-pressed={prefs.layout === 'list'}
          >
            ☰
          </button>
        </div>

        {/* Always shown — drives card size in grid, row height in list — so the
            controls to its left don't shift when switching layouts. */}
        <div className="zoom">
          <input
            type="range"
            min={120}
            max={360}
            step={10}
            value={prefs.zoom}
            onChange={(e) => setPrefs({ ...prefs, zoom: Number(e.target.value) })}
            aria-label="Zoom"
          />
        </div>
      </div>

      <div
        className={`file-browser__body${marqueeRect ? ' file-browser__body--dragging' : ''}${
          dropActive ? ' file-browser__body--dropping' : ''
        }`}
        ref={setScrollEl}
        onMouseDownCapture={suppressShiftSelection}
        onMouseDown={onBackgroundMouseDown}
        onContextMenu={contextBackground}
        onKeyDown={listKeyDown}
        onDragOver={canCreateFolder ? onDragOverFiles : undefined}
        onDragLeave={canCreateFolder ? () => setDropActive(false) : undefined}
        onDrop={canCreateFolder ? onDropFiles : undefined}
        // Focusable so F2/Enter reach the list without stealing the tab order
        // from the toolbar controls above it.
        tabIndex={-1}
      >
        {/* Above the listing rather than inside it: the new folder has no
            position in the current sort until it has a name. */}
        {write.creatingFolder && (
          <div className="file-newfolder">
            <span className="file-row__icon">
              <IconFolder />
            </span>
            <NameEditor
              initial="New Folder"
              label="New folder name"
              onSubmit={write.submitNewFolder}
              onCancel={write.cancelNewFolder}
            />
          </div>
        )}
        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : isError ? (
          <div className="empty empty--error">{errorText ?? 'Could not load files.'}</div>
        ) : entries.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : visible.length === 0 ? (
          <div className="empty">No files match “{search}”.</div>
        ) : (
          <>
            <div className="file-browser__wrapper" ref={wrapperRef}>
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
                  role="table"
                  style={{ ['--file-row-h' as string]: `${listRowHeight(prefs.zoom)}px` }}
                >
                  <div className="file-table__head" role="row">
                    <span role="columnheader">Name</span>
                    <span role="columnheader">Type</span>
                    <span className="file-table__num" role="columnheader">
                      Size
                    </span>
                    <span role="columnheader">Date Added</span>
                    <span role="columnheader">Date Modified</span>
                  </div>
                  {visible.map((entry) => (
                    <FileRow
                      key={entry.relative_path}
                      entry={entry}
                      label={labelFor(entry)}
                      selected={
                        selected.has(entry.relative_path) || entry.relative_path === selectedPath
                      }
                      onClick={(e) => clickEntry(entry, e)}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(e) => contextRow(entry, e)}
                      dragProps={entryDragProps(entry)}
                      renaming={write.renamingPath === entry.relative_path}
                      onRename={(name) => write.submitRename(entry.relative_path, name)}
                      onCancelRename={write.cancelRename}
                    />
                  ))}
                </div>
              ) : (
                <div className="file-grid" style={gridStyle}>
                  {visible.map((entry) => (
                    <FileCard
                      key={entry.relative_path}
                      entry={entry}
                      label={labelFor(entry)}
                      selected={
                        selected.has(entry.relative_path) || entry.relative_path === selectedPath
                      }
                      onClick={(e) => clickEntry(entry, e)}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(e) => contextRow(entry, e)}
                      previewDisabled={marqueeRect !== null || menu.state !== null}
                      dragProps={entryDragProps(entry)}
                      renaming={write.renamingPath === entry.relative_path}
                      onRename={(name) => write.submitRename(entry.relative_path, name)}
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
        {sheetTarget && (
          <ContactSheetDialog
            target={sheetTarget}
            onClose={() => setSheetTarget(null)}
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

        {openIndex !== null && (
          <FileEntryViewer
            files={openable}
            index={openIndex}
            onIndex={setOpenIndex}
            onClose={() => setOpenIndex(null)}
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
}: {
  entry: FileBrowserEntry
  /** The name as displayed — may have its extension hidden (a display pref). */
  label: string
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  dragProps: FileDragProps
  renaming: boolean
  onRename: (name: string) => void
  onCancelRename: () => void
}) {
  const isDir = entry.kind === 'directory'
  return (
    <div
      className={`file-row${selected ? ' file-row--selected' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="row"
      aria-selected={selected}
      data-relpath={entry.relative_path}
      // A row being renamed must not also be a drag source: the pointer belongs
      // to the text field while a name is being edited.
      {...(renaming ? {} : dragProps)}
    >
      <span className="file-row__name">
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
        {!isDir && !entry.supported && <span className="badge">unsupported</span>}
        {/* Bundle status: flag files that still need attention. A file already in
            a confirmed bundle shows no status badge. */}
        {!isDir && !entry.linked && <span className="badge badge--warn">unlinked</span>}
        {!isDir && entry.unbundled && <span className="badge badge--warn">unbundled</span>}
      </span>
      <span className="file-row__type">{isDir ? 'Folder' : (entry.extension ?? 'file')}</span>
      <span className="file-table__num">{isDir ? '' : formatBytes(entry.size_bytes)}</span>
      <span className="file-row__added">
        {entry.created_at ? formatDate(entry.created_at) : ''}
      </span>
      <span className="file-row__modified">
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
}: {
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
  onRename: (name: string) => void
  onCancelRename: () => void
}) {
  const isDir = entry.kind === 'directory'
  const previewSource = useMemo<HoverPreviewSource | null>(
    () =>
      entry.media_kind === 'video' && entry.file_id && entry.duration
        ? {
            mediaKind: 'video',
            fileId: entry.file_id,
            mimeType: entry.mime_type,
            relativePath: entry.relative_path,
            container: entry.container,
            videoCodec: entry.video_codec,
            videoCodecTag: entry.video_codec_tag,
            audioCodec: entry.audio_codec,
            duration: entry.duration,
            startTime: entry.resume_position,
          }
        : null,
    [
      entry.audio_codec,
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
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="gridcell"
      aria-selected={selected}
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
        {!isDir && !entry.linked && (
          <span className="card__badge card__badge--missing">unlinked</span>
        )}
        {!isDir && entry.linked && entry.unbundled && (
          <span className="card__badge card__badge--review">unbundled</span>
        )}
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
