import { useRef, useState } from 'react'

import type { CollectionRead } from '../api/client'
import { collectionThumbnailUrl } from '../api/client'
import type { DragItem } from './dnd'
import { dropZone, getActiveDrag, sameTarget, seamFor, setActiveDrag } from './dnd'
import { dragBadgeLabel, setDragBadge } from './dragBadge'
import { suppressShiftSelection } from './selection'
import { IconChevron, IconFolder } from './icons'
import { collectionCardWidth } from './layout'
import { gapBefore, moveBeforeId } from './reorder'
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
  onReorderCollections?: (movedIds: string[], beforeId: string | null) => void
  // Right-click on empty section space → the folder-order context menu (Clean up…).
  onSectionContextMenu?: (e: React.MouseEvent) => void
  // Cross-surface drag: the current payload + callbacks to start a collection
  // drag, reparent a collection into another, or move bundles into a collection.
  dragItem: DragItem | null
  onDragItem: (item: DragItem | null) => void
  onReparentCollections: (ids: string[], targetId: string) => void
  // Parent of the folder cards shown here (the viewed collection, or null in the
  // All view) — used to place a card dragged in from another parent group.
  parentId: string | null
  onMoveCollections: (ids: string[], newParentId: string | null, orderedIds: string[]) => void
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
      // Select on press so a drag departs with this card selected — see the
      // same handler on BundleCard for the full reasoning.
      onMouseDown={(e) => {
        if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || selected) return
        onSelect(e)
      }}
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
            src={collectionThumbnailUrl(collection.id, collection.updated_at)}
            alt=""
            loading="lazy"
            // The card owns the drag; a draggable cover would start a native
            // image drag instead (see the inert-media rule in index.css).
            draggable={false}
            onError={() => setHasCover(false)}
          />
        )}
        <span className="collcard__chip">
          <IconFolder />
        </span>
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
  onReparentCollections,
  parentId,
  onMoveCollections,
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
  // Where the drop will land — a destination, not a card and a side. A gap
  // between two cards can be described from either card ("after the left one" /
  // "before the right one"), and describing it both ways is what made one
  // insertion point look like two seams. It is named once here, the way the
  // server names it: the card the moved block lands in front of, or null for the
  // end of the group.
  const [dropSlot, setDropSlot] = useState<
    { kind: 'into'; id: string } | { kind: 'gap'; beforeId: string | null } | null
  >(null)
  const clearDrag = () => {
    setActiveDrag(null)
    setDropSlot(null)
    onDragItem(null)
  }
  // Only show hover feedback while a drag is actually in flight. A bundle drag
  // starts in the Browser, so this card's own onDragEnd never fires for it —
  // gating on dragItem keeps the "drop into" highlight from sticking on the
  // last-hovered folder card after such a drag ends.
  const activeSlot = dragItem ? dropSlot : null
  // A drag ending leaves the last hovered slot behind; the *next* drag showed it
  // for a beat before the first dragover corrected it. Reset as the new drag
  // begins — adjusted during render (React's reset-on-prop-change pattern)
  // rather than in an effect, which would paint the stale slot for a frame.
  const [lastDragItem, setLastDragItem] = useState(dragItem)
  if (dragItem !== lastDragItem) {
    setLastDragItem(dragItem)
    if (dragItem) setDropSlot(null)
  }
  const siblingIds = subcollections.map((c) => c.id)

  // The container owns the whole drop gesture — same design as the bundle grid
  // (Browser.tsx), for the same reason. Cards used to handle drops themselves
  // while a separate surface handler caught the rest, and the two disagreed:
  // the card's dragover painted "insert before Archive" while a release two pixels
  // into the gutter fell to the surface handler, which resolved by the grid's
  // *vertical midpoint*, picked the last sibling as the edge — and when that
  // sibling was the dragged card itself, silently did nothing. One computation
  // over the cursor now feeds both the indicator and the commit.
  const computeGap = (e: {
    clientX: number
    clientY: number
  }): { kind: 'into'; id: string } | { kind: 'gap'; beforeId: string | null } | null => {
    const live = getActiveDrag() ?? dragItem
    const gridEl = gridRef.current
    if (live === null || gridEl === null) return null
    let best: { id: string; rect: DOMRect; distance: number } | null = null
    for (const el of gridEl.querySelectorAll<HTMLElement>('[data-collection-id]')) {
      const id = el.dataset.collectionId
      if (id === undefined) continue
      const r = el.getBoundingClientRect()
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right)
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom)
      const distance = Math.hypot(dx, dy)
      if (best === null || distance < best.distance) best = { id, rect: r, distance }
    }
    if (best === null) return null
    // Bundles dropped anywhere on the section mean "into the nearest folder".
    if (live.kind === 'bundles') return { kind: 'into', id: best.id }
    const member = live.ids.includes(best.id)
    // Hovering a member of the dragged block can only mean its own edges — a
    // no-op gap or a small nudge — never "into itself".
    const zone = member
      ? e.clientX < best.rect.left + best.rect.width / 2
        ? 'before'
        : 'after'
      : // A card's middle band nests into it; its edges (and the gutters either
        // side) are the reorder gap. With no reordering — the flattened view —
        // everything reads as "into".
        onReorderCollections
        ? dropZone(e, best.rect, 'horizontal', true)
        : 'into'
    if (zone === 'into') return member ? null : { kind: 'into', id: best.id }
    // Collapse "after this card" into "before the next one": one name per gap,
    // and the exact value the server is sent.
    return { kind: 'gap', beforeId: gapBefore(siblingIds, live.ids, best.id, zone) }
  }

  const onSurfaceDragOver = (e: React.DragEvent) => {
    const gap = computeGap(e)
    if (gap === null) return
    e.preventDefault()
    const live = getActiveDrag() ?? dragItem
    if (live?.kind === 'bundles') e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
    setDropSlot((prev) => (sameTarget(prev, gap) ? prev : gap))
  }
  const onSurfaceDrop = (e: React.DragEvent) => {
    const live = getActiveDrag() ?? dragItem
    const gap = computeGap(e)
    if (live === null || gap === null) return
    e.preventDefault()
    if (live.kind === 'bundles') {
      if (gap.kind === 'into') onMoveBundlesInto(gap.id, e.altKey)
    } else if (gap.kind === 'into') {
      onReparentCollections(live.ids, gap.id)
    } else {
      const dragged = live.ids
      const incoming = dragged.filter((id) => !siblingIds.includes(id))
      if (incoming.length === 0) {
        onReorderCollections?.(dragged, gap.beforeId)
      } else {
        onMoveCollections(
          dragged,
          parentId,
          moveBeforeId([...siblingIds, ...incoming], dragged, gap.beforeId),
        )
      }
    }
    clearDrag()
  }

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
    // Everything that isn't a folder card or one of the header's own controls
    // counts as background — including the wide empty strip beside the
    // "Subcollections"/"Contents" titles, which reads as blank space and so has
    // to deselect (and start a marquee) like any other blank space.
    isBackgroundTarget: (target) =>
      !target.closest('[data-collection-id]') && !target.closest('button, label, input'),
    hitTest,
    getBaseSelection: () => selectedIds,
    onChange: onMarqueeSelect,
  })

  return (
    <div
      className={`collhead${marqueeRect ? ' browser--dragging' : ''}`}
      ref={scrollElRef}
      onMouseDownCapture={suppressShiftSelection}
      onMouseDown={onMouseDown}
      onDragOver={onSurfaceDragOver}
      onDrop={onSurfaceDrop}
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
              // One seam per destination: the card it lands in front of shows a
              // leading line; the end of the group shows a trailing line on the
              // last card. Never both sides of one gap.
              drop={seamFor(activeSlot, c.id, siblingIds)}
              dropInto={activeSlot?.kind === 'into' && activeSlot.id === c.id}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                // Grabbing a card that is part of a multi-selection drags the
                // whole selection (as a bundle drag does); grabbing anything
                // else drags just it.
                const ids =
                  selectedIds.has(c.id) && selectedIds.size > 1 ? [...selectedIds] : [c.id]
                setDragBadge(e, dragBadgeLabel(ids.length, c.name, 'collection'))
                setActiveDrag({ kind: 'collection', id: c.id, ids })
                onDragItem({ kind: 'collection', id: c.id, ids })
              }}
              onDragEnd={clearDrag}
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
