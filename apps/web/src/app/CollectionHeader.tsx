import { useRef, useState } from 'react'

import type { CollectionRead } from '../api/client'
import { collectionThumbnailUrl } from '../api/client'
import type { DragItem } from './dnd'
import { dropZone } from './dnd'
import { IconChevron, IconFolder } from './icons'
import { collectionCardWidth } from './layout'
import { moveTo } from './reorder'
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
  // Right-click on empty section space → the folder-order context menu (Clean up…).
  onSectionContextMenu?: (e: React.MouseEvent) => void
  // Cross-surface drag: the current payload + callbacks to start a collection
  // drag, reparent a collection into another, or move bundles into a collection.
  dragItem: DragItem | null
  onDragItem: (item: DragItem | null) => void
  onReparentCollection: (id: string, targetId: string) => void
  onMoveBundlesInto: (targetId: string, alt: boolean) => void
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
  return (
    <span className="collsec__caret">
      <IconChevron open={open} />
    </span>
  )
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
  drop,
  dropInto,
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
  drop?: 'before' | 'after'
  // Highlight the whole card as a "move into" target (reparent / add bundles).
  dropInto?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
}) {
  const [hasCover, setHasCover] = useState(true)
  return (
    <button
      className={`collcard${selected ? ' collcard--selected' : ''}${
        dropInto ? ' collcard--drop-into' : ''
      }`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      title={collection.name}
      data-collection-id={collection.id}
      data-drop={dropInto ? undefined : drop}
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
  onSectionContextMenu,
  dragItem,
  onDragItem,
  onReparentCollection,
  onMoveBundlesInto,
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
  // Drop feedback for the hovered folder card: which card and which zone
  // (before/after = reorder gap, into = reparent/add). The dragged item itself
  // comes from the App-level dragItem (so a bundle or a folder from elsewhere can
  // be dropped here).
  const [dropSlot, setDropSlot] = useState<{
    id: string
    zone: 'before' | 'into' | 'after'
  } | null>(null)
  const clearDrag = () => {
    setDropSlot(null)
    onDragItem(null)
  }
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
      // Right-click empty section space (not a card — those handle their own
      // menu) → the folder "Clean up…" menu.
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('[data-collection-id]')) return
        onSectionContextMenu?.(e)
      }}
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
              draggable
              drop={dropSlot?.id === c.id && dropSlot.zone !== 'into' ? dropSlot.zone : undefined}
              dropInto={dropSlot?.id === c.id && dropSlot.zone === 'into'}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                onDragItem({ kind: 'collection', id: c.id })
              }}
              onDragEnd={clearDrag}
              onDragOver={(e) => {
                // Bundles dropped on a folder always mean "move into"; a folder
                // hovering another can reorder (edges) or reparent (center).
                let zone: 'before' | 'into' | 'after' | null = null
                if (dragItem?.kind === 'bundles') zone = 'into'
                else if (dragItem?.kind === 'collection' && dragItem.id !== c.id) {
                  const r = e.currentTarget.getBoundingClientRect()
                  // Reorder edges only when this sibling group is reorderable.
                  zone = onReorderCollections ? dropZone(e, r, 'horizontal', true) : 'into'
                }
                if (zone === null) return
                e.preventDefault()
                setDropSlot((prev) =>
                  prev?.id === c.id && prev.zone === zone ? prev : { id: c.id, zone },
                )
              }}
              onDrop={(e) => {
                if (dragItem === null) return
                const zone = dropSlot?.id === c.id ? dropSlot.zone : 'into'
                if (dragItem.kind === 'bundles') {
                  e.preventDefault()
                  onMoveBundlesInto(c.id, e.altKey)
                } else if (dragItem.id !== c.id) {
                  e.preventDefault()
                  if (zone === 'into') onReparentCollection(dragItem.id, c.id)
                  else
                    onReorderCollections?.(moveTo(siblingIds, dragItem.id, c.id, zone === 'before'))
                }
                clearDrag()
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
