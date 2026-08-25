import { useEffect, useMemo, useRef, useState } from 'react'

import { type FileRead, fileThumbnailUrl } from '../api/client'
import {
  useBundle,
  useBundleFiles,
  useFileMutations,
  useFileOperations,
  useForgetMissingFiles,
} from '../api/hooks'
import { formatBytes, formatDimensions, formatDuration } from '../lib/format'
import type { HostLabels } from '../platform'
import { ContextMenu } from './ContextMenu'
import { type FileDragProps, fileDragProps } from './dragOut'
import { bundleFileMenuEntries } from './bundleFileMenu'
import { ContactSheetDialog } from './ContactSheetDialog'
import type { ContactSheetTarget } from './contactSheetExport'
import { HoverPreview } from './HoverPreview'
import type { HoverPreviewSource } from './hoverPreviewState'
import { factsFromBundleFile } from './fileFacts'
import { listRowHeight } from './layout'
import { selectionTargets } from './selection'
import { useContextMenu } from './useContextMenu'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'
import { MediaViewer } from './viewer/MediaViewer'
import type { LayoutMode, PlayerPrefs } from './types'

/**
 * Inline "album" view: replaces the bundle grid in the center pane with the
 * files inside one opened bundle. Single-click selects a file (drag-select and
 * Shift-range work too); double-click opens the fullscreen MediaViewer. The right
 * inspector keeps showing the *bundle* info — file selection here is local. A
 * back breadcrumb returns to the library. Right-clicking a file can locate it in
 * the File Browser.
 */
export function BundleAlbum({
  bundleId,
  playerPrefs,
  onPlayerPrefs,
  onBack,
  onLocateFile,
  hostLabels,
  onRevealFile,
  onOpenFile,
  onStartFileDrag,
  onFlash,
  onSelectFile,
  layout = 'grid',
  zoom = 200,
  writeMode = false,
}: {
  bundleId: string
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onBack: () => void
  // Jump to the File Browser at this file's directory, selecting it.
  onLocateFile?: (relativePath: string) => void
  hostLabels: HostLabels
  onRevealFile?: (relativePath: string) => void
  onOpenFile?: (relativePath: string) => void
  // Drag file(s) out to Finder/other apps (plan 3 §6); undefined disables it.
  onStartFileDrag?: (relativePaths: string[]) => void
  /** Report a transient message (export progress, results) to the shell. */
  onFlash?: (message: string) => void
  /** The single selected file, so the shell can show its details in the rail. */
  onSelectFile?: (file: FileRead | null) => void
  /** The shell toolbar's layout — one control drives both surfaces (owner,
   *  2026-07-27). `justified` has no meaning for an album, so it reads as grid. */
  layout?: LayoutMode
  /** The shell toolbar's zoom: tile width in grid, row height in list. */
  zoom?: number
  // Whether guarded write operations are permitted (ADR-0013's two gates) —
  // gates the Move to Trash entry the way the File Browser gates its own.
  writeMode?: boolean
}) {
  const { data: bundle } = useBundle(bundleId)
  const { data: files = [], isLoading } = useBundleFiles(bundleId)
  const fileMutations = useFileMutations(bundleId)
  // Dropping the record of a file that is gone; see `useForgetMissingFiles`.
  const forgetMissing = useForgetMissingFiles()
  const fileOps = useFileOperations()
  const [viewing, setViewing] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const menu = useContextMenu()
  const listLayout = layout === 'list'
  // The file whose contact-sheet options are open, if any.
  const [sheetTarget, setSheetTarget] = useState<ContactSheetTarget | null>(null)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)

  // Esc returns to the library — but only when the fullscreen viewer (which has
  // its own Esc-to-close) isn't open.
  useEffect(() => {
    if (viewing !== null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing, onBack])

  const clickTile = (file: FileRead, e: React.MouseEvent | React.KeyboardEvent) => {
    const ids = files.map((f) => f.id)
    if (e.shiftKey && anchor) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(file.id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected(new Set(ids.slice(lo, hi + 1)))
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(file.id)) next.delete(file.id)
        else next.add(file.id)
        return next
      })
    } else {
      setSelected(new Set([file.id]))
    }
    setAnchor(file.id)
  }

  const openFile = (index: number) => setViewing(index)

  // Drag-out targets: the whole selection when dragging a selected tile within a
  // multi-selection, otherwise just this file (mirrors the context-menu rule).
  const dragTargets = (file: FileRead): string[] => {
    const ids = new Set(selectionTargets(file.id, selected))
    return files.filter((f) => ids.has(f.id)).map((f) => f.relative_path)
  }

  const contextTile = (file: FileRead, e: React.MouseEvent) => {
    if (!selected.has(file.id)) setSelected(new Set([file.id]))
    // The whole selection when this tile is part of one, else just this tile —
    // the same rule the drag-out targets follow.
    const targetIds = selectionTargets(file.id, selected)
    const targets = files.filter((f) => targetIds.includes(f.id))
    menu.open(
      e,
      bundleFileMenuEntries({
        targets,
        hostLabels,
        onOpenFile,
        onRevealFile,
        onLocateFile,
        onRemoveFromBundle: (files) => files.forEach((f) => fileMutations.remove.mutate(f.id)),
        onForgetMissing: (files) =>
          forgetMissing.mutate(
            { bundleId, fileIds: files.map((f) => f.id) },
            {
              // Forgetting the last file takes the bundle with it, and an album
              // view of a bundle that no longer exists is nothing to look at.
              onSuccess: (result) => {
                if (result.bundle_deleted) onBack()
              },
            },
          ),
        onTrash: writeMode
          ? (files) => fileOps.trash.mutate(files.map((f) => f.relative_path))
          : undefined,
        onContactSheet: setSheetTarget,
      }),
    )
  }

  const hitTest = (rect: MarqueeRect): string[] => {
    const gridEl = gridRef.current
    if (!gridEl) return []
    const gridRect = gridEl.getBoundingClientRect()
    const ids: string[] = []
    for (const el of gridEl.querySelectorAll<HTMLElement>('[data-file-id]')) {
      const r = el.getBoundingClientRect()
      const cardRect: MarqueeRect = {
        left: r.left - gridRect.left,
        top: r.top - gridRect.top,
        width: r.width,
        height: r.height,
      }
      if (rectsIntersect(rect, cardRect)) ids.push(el.dataset.fileId as string)
    }
    return ids
  }

  const { marqueeRect, onMouseDown } = useMarqueeSelect({
    getScrollEl: () => scrollRef.current,
    getWrapperEl: () => gridRef.current,
    isBackgroundTarget: (target) => !target.closest('[data-file-id]'),
    hitTest,
    getBaseSelection: () => selected,
    onChange: (ids) => setSelected(new Set(ids)),
  })

  // One file selected means the rail can describe it; anything else and the
  // bundle's own inspector is the useful thing to show.
  const soleSelected = selected.size === 1 ? (files.find((f) => selected.has(f.id)) ?? null) : null
  useEffect(() => {
    onSelectFile?.(soleSelected)
  }, [soleSelected, onSelectFile])
  // Leaving the bundle clears it, so a stale file never outlives the view.
  useEffect(() => () => onSelectFile?.(null), [onSelectFile])

  const title = bundle?.title ?? 'Untitled'

  return (
    <div className="album">
      <div className="album__bar">
        <button className="album__back" onClick={onBack} aria-label="Back to library">
          ‹ Library
        </button>
        <span className="album__title">{title}</span>
        <span className="album__count">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>

      <div
        className={`album__scroll${marqueeRect ? ' browser--dragging' : ''}`}
        ref={scrollRef}
        onMouseDown={onMouseDown}
      >
        <div
          className={listLayout ? 'album__rows' : 'album__grid'}
          role="list"
          ref={gridRef}
          // The shell's zoom slider, on the shell's own curves — tiles share the
          // bundle-card ramp, rows share the File Browser's row height (owner,
          // 2026-07-27: the one control must actually drive this surface too).
          style={
            listLayout
              ? ({
                  position: 'relative',
                  ['--file-row-h' as string]: `${listRowHeight(zoom)}px`,
                } as React.CSSProperties)
              : {
                  position: 'relative',
                  gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(zoom * 0.75)}px, 1fr))`,
                }
          }
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
          {isLoading && <div className="state">Loading files…</div>}
          {!isLoading && files.length === 0 && (
            <div className="state">This bundle has no files.</div>
          )}
          {files.map((f, i) =>
            listLayout ? (
              <AlbumRow
                key={f.id}
                file={f}
                selected={selected.has(f.id)}
                onSelect={(e) => clickTile(f, e)}
                onOpen={() => openFile(i)}
                onContextMenu={(e) => contextTile(f, e)}
                dragProps={fileDragProps(onStartFileDrag, () => dragTargets(f))}
              />
            ) : (
              <AlbumTile
                key={f.id}
                file={f}
                selected={selected.has(f.id)}
                onSelect={(e) => clickTile(f, e)}
                onOpen={() => openFile(i)}
                onContextMenu={(e) => contextTile(f, e)}
                previewDisabled={marqueeRect !== null || menu.state !== null}
                dragProps={fileDragProps(onStartFileDrag, () => dragTargets(f))}
              />
            ),
          )}
        </div>
      </div>

      <ContextMenu state={menu.state} onClose={menu.close} />
      {sheetTarget && (
        <ContactSheetDialog
          target={sheetTarget}
          onClose={() => setSheetTarget(null)}
          onReport={(message) => message !== null && onFlash?.(message)}
        />
      )}

      {viewing !== null && (
        <MediaViewer
          bundleId={bundleId}
          initialFileId={files[viewing]?.id}
          playerPrefs={playerPrefs}
          onPlayerPrefs={onPlayerPrefs}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}

function AlbumTile({
  file,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  previewDisabled,
  dragProps,
}: {
  file: FileRead
  selected: boolean
  onSelect: (e: React.MouseEvent | React.KeyboardEvent) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  previewDisabled: boolean
  dragProps: FileDragProps
}) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  const thumbnailable =
    file.availability === 'available' &&
    (file.media_kind === 'image' || file.media_kind === 'video')
  const duration = typeof meta.duration === 'number' ? meta.duration : 0
  const container = typeof meta.container === 'string' ? meta.container : null
  const videoCodec = typeof meta.video_codec === 'string' ? meta.video_codec : null
  const audioCodec = typeof meta.audio_codec === 'string' ? meta.audio_codec : null
  const previewSource = useMemo<HoverPreviewSource | null>(
    () =>
      file.availability === 'available' && file.media_kind === 'video' && duration > 0
        ? {
            mediaKind: 'video',
            fileId: file.id,
            mimeType: file.mime_type,
            relativePath: file.relative_path,
            container,
            videoCodec,
            audioCodec,
            duration,
            startTime: file.resume_position,
          }
        : null,
    [
      audioCodec,
      container,
      duration,
      file.availability,
      file.id,
      file.media_kind,
      file.mime_type,
      file.relative_path,
      file.resume_position,
      videoCodec,
    ],
  )

  return (
    <div
      className={`album-tile${selected ? ' album-tile--selected' : ''}`}
      onClick={(event) => onSelect(event)}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onSelect(event)
      }}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      title={file.display_title}
      data-file-id={file.id}
      {...dragProps}
    >
      <HoverPreview
        source={previewSource}
        disabled={previewDisabled}
        className="album-tile__thumb"
        style={
          thumbnailable
            ? {
                backgroundImage: `url(${fileThumbnailUrl(file.bundle_id, file.id, file.updated_at)})`,
              }
            : undefined
        }
      >
        {!thumbnailable && <span className="album-tile__placeholder">▦</span>}
        {file.availability !== 'available' && (
          <span className="card__badge card__badge--missing">missing</span>
        )}
        {file.media_kind === 'video' && meta.duration != null && (
          <span className="card__dur">{dur}</span>
        )}
      </HoverPreview>
      <div className="album-tile__name">{file.display_title}</div>
      <div className="album-tile__sub">
        {dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(file.size_bytes)}
      </div>
    </div>
  )
}

/** One file as a row, matching the File Browser's list layout. */
function AlbumRow({
  file,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  dragProps,
}: {
  file: FileRead
  selected: boolean
  onSelect: (e: React.MouseEvent) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  dragProps: FileDragProps
}) {
  const facts = factsFromBundleFile(file)
  return (
    <div
      className={`file-row${selected ? ' file-row--selected' : ''}`}
      data-file-id={file.id}
      role="row"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      {...dragProps}
    >
      <span className="file-row__name">
        <span className="file-row__icon">
          <span className="file-row__thumb-holder">
            {file.media_kind === 'image' || file.media_kind === 'video' ? (
              <img
                className="file-row__thumb"
                src={fileThumbnailUrl(file.bundle_id, file.id)}
                alt=""
                loading="lazy"
              />
            ) : (
              <span aria-hidden="true">📄</span>
            )}
          </span>
        </span>
        <span className="file-row__text">{file.display_title}</span>
        {!file.supported && <span className="badge">unsupported</span>}
        {file.availability !== 'available' && <span className="badge badge--warn">missing</span>}
      </span>
      <span className="file-row__type">{facts.extension ?? 'file'}</span>
      <span className="file-table__num">{formatBytes(file.size_bytes)}</span>
      <span className="file-row__added">
        {facts.duration ? formatDuration(facts.duration) : ''}
      </span>
      <span className="file-row__modified">{formatDimensions(facts.width, facts.height)}</span>
    </div>
  )
}
