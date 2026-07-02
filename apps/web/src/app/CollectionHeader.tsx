import { useRef, useState } from 'react'

import type { CollectionRead } from '../api/client'
import { collectionThumbnailUrl } from '../api/client'
import { IconFolder } from './icons'
import { collectionCardWidth } from './layout'
import { moveBefore } from './reorder'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'

interface CollectionHeaderProps {
  subcollections: CollectionRead[]
  // Heading for the folder section — "Subcollections" inside a collection,
  // "Collections" at the top level (All view).
  sectionLabel: string
  // Direct (non-recursive) bundle count per collection id.
  counts?: Record<string, number>
  // Direct subcollection count per collection id.
  subcounts?: Record<string, number>
  // Whether the Contents grid below includes bundles from these subcollections.
  // Omitted (with its toggle) at the top level, where Contents already shows
  // every bundle.
  showContents?: boolean
  onToggleShowContents?: (value: boolean) => void
  // Click (with modifier = toggle) selects a subcollection card; double-click
  // navigates into it. Drag-select fires onMarqueeSelect instead.
  onSelectSubcollection: (id: string, e: React.MouseEvent) => void
  onMarqueeSelect: (ids: string[]) => void
  onOpenSubcollection: (id: string) => void
  // Right-click a folder card (mirrors the sidebar's Delete Collection menu).
  onContextMenuSubcollection?: (id: string, e: React.MouseEvent) => void
  // Persist a manual drag-reorder of the folder cards (these all share one
  // parent). Omitted when reordering doesn't apply (e.g. the flattened view).
  onReorderCollections?: (orderedIds: string[]) => void
  // Open the "Clean up by…" dialog for collections. Omitted when there's nothing
  // to tidy.
  onCleanup?: () => void
  selectedIds: Set<string>
  // Target card width (px) — driven by the toolbar zoom slider, shared with the
  // bundle grid.
  zoom: number
  // Collapse state for the two sections (owned by the parent so the Contents
  // fold can also hide the bundle grid it renders as a sibling).
  subcollapsed: boolean
  onToggleSubcollapsed: () => void
  contentsCount: number
  contentsCollapsed: boolean
  onToggleContents: () => void
}

function Caret({ open }: { open: boolean }) {
  return <span className="collsec__caret">{open ? '▾' : '▸'}</span>
}

/** A folder card with a cover image (the collection's chosen/auto-picked cover
 * bundle), falling back to a folder glyph when it has no thumbnailable bundle.
 * The stacked-sheet look (CSS) marks it as a folder — visually distinct from a
 * single bundle card. The footer shows both the direct bundle count and the
 * subcollection count. */
function CollectionCard({
  collection,
  count,
  subCount,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  draggable,
  isDropTarget,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  collection: CollectionRead
  count: number
  subCount: number
  selected: boolean
  onSelect: (e: React.MouseEvent) => void
  onOpen: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  draggable?: boolean
  isDropTarget?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const [hasCover, setHasCover] = useState(true)
  return (
    <button
      className={`collcard${selected ? ' collcard--selected' : ''}${
        isDropTarget ? ' collcard--drop' : ''
      }`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      title={collection.name}
      data-collection-id={collection.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="collcard__thumb">
        <span className="collcard__thumb-icon">
          <IconFolder />
        </span>
        {hasCover && (
          <img
            className="collcard__thumb-img"
            src={collectionThumbnailUrl(collection.id, collection.cover_bundle_id)}
            alt=""
            loading="lazy"
            onError={() => setHasCover(false)}
          />
        )}
      </div>
      <div className="collcard__meta">
        <div className="collcard__name">{collection.name}</div>
        <div className="collcard__count">
          {count} bundle{count === 1 ? '' : 's'} · {subCount} subcollection
          {subCount === 1 ? '' : 's'}
        </div>
      </div>
    </button>
  )
}

/**
 * The two coherent, collapsible section headers shown above (Subcollections)
 * and around (Contents) the bundle grid when a collection has subcollections —
 * modeled on Eagle's folder view. No hard separator: the header shares the
 * grid's background so the whole surface reads as one. Folding "Subcollections"
 * hides the folder tiles; folding "Contents" hides the bundle grid (the parent
 * renders the grid conditionally). The "Show subcollection contents" toggle
 * decides whether the grid lists only this collection's own bundles or also its
 * descendants'.
 *
 * The folder grid gets its own drag-to-select (mirroring Browser.tsx), scoped
 * to this section only — a marquee here can't also pick up bundle cards, since
 * selecting subcollections and bundles together doesn't mean anything.
 */
export function CollectionHeader({
  subcollections,
  sectionLabel,
  counts,
  subcounts,
  showContents,
  onToggleShowContents,
  onSelectSubcollection,
  onMarqueeSelect,
  onOpenSubcollection,
  onContextMenuSubcollection,
  onReorderCollections,
  onCleanup,
  selectedIds,
  zoom,
  subcollapsed,
  onToggleSubcollapsed,
  contentsCount,
  contentsCollapsed,
  onToggleContents,
}: CollectionHeaderProps) {
  // .collhead (the outer wrapper) is the actual scrollable element — the grid
  // itself doesn't scroll — so auto-scroll-on-drag targets that, while hit
  // testing and the marquee rect stay relative to the grid.
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  // Id of the folder card being dragged for manual reorder (null when idle).
  const [dragId, setDragId] = useState<string | null>(null)
  const siblingIds = subcollections.map((c) => c.id)

  const hitTest = (rect: MarqueeRect): string[] => {
    const gridEl = gridRef.current
    if (!gridEl) return []
    const gridRect = gridEl.getBoundingClientRect()
    const ids: string[] = []
    for (const el of gridEl.querySelectorAll<HTMLElement>('[data-collection-id]')) {
      const r = el.getBoundingClientRect()
      const cardRect: MarqueeRect = {
        left: r.left - gridRect.left,
        top: r.top - gridRect.top,
        width: r.width,
        height: r.height,
      }
      if (rectsIntersect(rect, cardRect)) ids.push(el.dataset.collectionId as string)
    }
    return ids
  }

  const { marqueeRect, onMouseDown } = useMarqueeSelect({
    getScrollEl: () => scrollElRef.current,
    getWrapperEl: () => gridRef.current,
    isBackgroundTarget: (target) =>
      !target.closest('[data-collection-id]') && !target.closest('.collsec__row'),
    hitTest,
    getBaseSelection: () => selectedIds,
    onChange: onMarqueeSelect,
  })

  return (
    <div
      className={`collhead${marqueeRect ? ' browser--dragging' : ''}`}
      ref={scrollElRef}
      onMouseDown={onMouseDown}
    >
      <div className="collsec__row">
        <button
          className="collsec__title"
          onClick={onToggleSubcollapsed}
          aria-expanded={!subcollapsed}
        >
          <Caret open={!subcollapsed} />
          {sectionLabel} ({subcollections.length})
        </button>
        <div className="collsec__controls">
          {onToggleShowContents && (
            <label className="collsec__check">
              <input
                type="checkbox"
                checked={showContents ?? false}
                onChange={(e) => onToggleShowContents(e.target.checked)}
              />
              Show subcollection contents
            </label>
          )}
          {onCleanup && (
            <button className="collsec__cleanup" onClick={onCleanup} title="Clean up folder order">
              Clean up…
            </button>
          )}
        </div>
      </div>
      {!subcollapsed && (
        <div
          ref={gridRef}
          className="collcard__grid"
          style={{
            // Folder cards follow their own (smaller) curve off the shared zoom
            // slider — see collectionCardWidth — so they don't grow as large as
            // bundle tiles.
            gridTemplateColumns: `repeat(auto-fill, minmax(${collectionCardWidth(zoom)}px, 1fr))`,
            position: 'relative',
          }}
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
          {subcollections.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              count={counts?.[c.id] ?? 0}
              subCount={subcounts?.[c.id] ?? 0}
              selected={selectedIds.has(c.id)}
              onSelect={(e) => onSelectSubcollection(c.id, e)}
              onOpen={() => onOpenSubcollection(c.id)}
              onContextMenu={
                onContextMenuSubcollection ? (e) => onContextMenuSubcollection(c.id, e) : undefined
              }
              draggable={onReorderCollections !== undefined}
              isDropTarget={dragId !== null && dragId !== c.id}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragId(c.id)
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => {
                if (dragId !== null && dragId !== c.id) e.preventDefault()
              }}
              onDrop={(e) => {
                if (dragId === null || dragId === c.id || !onReorderCollections) return
                e.preventDefault()
                onReorderCollections(moveBefore(siblingIds, dragId, c.id))
                setDragId(null)
              }}
            />
          ))}
        </div>
      )}
      <div className="collsec__row">
        <button
          className="collsec__title"
          onClick={onToggleContents}
          aria-expanded={!contentsCollapsed}
        >
          <Caret open={!contentsCollapsed} />
          Contents ({contentsCount})
        </button>
      </div>
    </div>
  )
}
