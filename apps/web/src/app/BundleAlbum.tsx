import { useEffect, useMemo, useRef, useState } from 'react'

import { type FileRead, fileThumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles } from '../api/hooks'
import { formatBytes, formatDimensions, formatDuration } from '../lib/format'
import type { HostLabels } from '../platform'
import { ContextMenu } from './ContextMenu'
import { type FileDragProps, fileDragProps } from './dragOut'
import { hostFileMenuEntries } from './hostActions'
import { HoverPreview } from './HoverPreview'
import type { HoverPreviewSource } from './hoverPreviewState'
import { selectionTargets } from './selection'
import { type MenuEntry, useContextMenu } from './useContextMenu'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'
import { MediaViewer } from './viewer/MediaViewer'
import type { PlayerPrefs } from './types'

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
}) {
  const { data: bundle } = useBundle(bundleId)
  const { data: files = [], isLoading } = useBundleFiles(bundleId)
  const [viewing, setViewing] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const menu = useContextMenu()

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
    const items: MenuEntry[] = hostFileMenuEntries(
      hostLabels,
      { onOpenFile, onRevealFile },
      file.relative_path,
    )
    if (onLocateFile) {
      if (items.length > 0) items.push(null)
      items.push({
        label: 'Locate in File Browser',
        onClick: () => onLocateFile(file.relative_path),
      })
    }
    menu.open(e, items)
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
        <div className="album__grid" role="list" ref={gridRef} style={{ position: 'relative' }}>
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
          {files.map((f, i) => (
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
          ))}
        </div>
      </div>

      <ContextMenu state={menu.state} onClose={menu.close} />

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
