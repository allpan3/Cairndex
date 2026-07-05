import { useEffect, useRef, useState } from 'react'

import { type FileRead, fileThumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles } from '../api/hooks'
import { formatBytes, formatDimensions, formatDuration } from '../lib/format'
import { ContextMenu } from './ContextMenu'
import { useContextMenu } from './useContextMenu'
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
}: {
  bundleId: string
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onBack: () => void
  // Jump to the File Browser at this file's directory, selecting it.
  onLocateFile?: (relativePath: string) => void
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

  const clickTile = (file: FileRead, e: React.MouseEvent) => {
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

  const contextTile = (file: FileRead, e: React.MouseEvent) => {
    if (!selected.has(file.id)) setSelected(new Set([file.id]))
    const items = onLocateFile
      ? [{ label: 'Locate in File Browser', onClick: () => onLocateFile(file.relative_path) }]
      : []
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
              onClick={(e) => clickTile(f, e)}
              onOpen={() => openFile(i)}
              onContextMenu={(e) => contextTile(f, e)}
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
  onClick,
  onOpen,
  onContextMenu,
}: {
  file: FileRead
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  const thumbnailable =
    file.availability === 'available' &&
    (file.media_kind === 'image' || file.media_kind === 'video')

  return (
    <button
      className={`album-tile${selected ? ' album-tile--selected' : ''}`}
      onClick={onClick}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      role="listitem"
      title={file.display_title}
      data-file-id={file.id}
    >
      <div
        className="album-tile__thumb"
        style={
          thumbnailable
            ? { backgroundImage: `url(${fileThumbnailUrl(file.bundle_id, file.id)})` }
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
      </div>
      <div className="album-tile__name">{file.display_title}</div>
      <div className="album-tile__sub">
        {dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(file.size_bytes)}
      </div>
    </button>
  )
}
