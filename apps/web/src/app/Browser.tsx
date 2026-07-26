import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { BundleSummary } from '../api/client'
import { thumbnailUrl } from '../api/client'
import { formatBytes, formatDate, formatDimensions } from '../lib/format'
import { BundleCard } from './BundleCard'
import { dragBadgeLabel, setDragBadge } from './dragBadge'
import { computeRows, type PlacedCard, type Row } from './layout'
import type { DropTarget } from './dnd'
import { DRAG_BUNDLES, sameTarget, seamFor } from './dnd'
import { selectionTargets, suppressShiftSelection } from './selection'
import type { LayoutMode } from './types'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'

const H_PADDING = 12

interface BrowserProps {
  items: BundleSummary[]
  total: number
  layout: LayoutMode
  zoom: number
  selectedIds: Set<string>
  onSelect: (id: string, e: React.MouseEvent) => void
  // Fired continuously while a marquee drag is in progress (and once more on
  // mouseup) with the full resulting selection — replaces selectedIds wholesale.
  onMarqueeSelect: (ids: string[]) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  contextMenuOpen?: boolean
  // Right-click on empty space (not on a card/row) — e.g. to create a bundle.
  onEmptyContextMenu?: (e: React.MouseEvent) => void
  // When set (Manual sort), cards/rows become drag-reorderable; a drop fires the
  // full resulting order of loaded items.
  onReorder?: (move: { movedIds: string[]; beforeId: string | null }) => void
  // Cross-surface drag: a bundle drag begins (carrying the whole selection when
  // the dragged card is selected) so folder cards / the sidebar can accept a
  // "move into collection" drop. onBundleDragEnd clears that state.
  onBundleDragStart?: (ids: string[]) => void
  onBundleDragEnd?: () => void
  isLoading: boolean
  isError: boolean
  error?: unknown
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  // When set, an empty result is shown as "no matches" for this query rather
  // than the generic "nothing here yet" state.
  searchQuery?: string
  // Overrides the generic empty-state body (e.g. a collection whose bundles all
  // live in subcollections). Ignored while a search is active.
  emptyState?: React.ReactNode
}

/**
 * The reorder gesture's single source of truth.
 *
 * Every dragover and the drop itself run this one function over the rendered
 * cards: nearest card by clamped distance (so gutters and margins resolve to
 * the gap they visually belong to), leading/trailing half by the layout's axis.
 * Geometry only: which card the cursor resolves to and which side of it. The
 * caller turns that into a destination (see DropTarget), so the seam that paints
 * and the move that commits are the same value — the previous design let cards
 * and the container answer the drop independently, and every reorder bug so far
 * was some version of those answers diverging.
 */
function computeGap(
  scrollEl: HTMLElement,
  e: { clientX: number; clientY: number },
  layout: LayoutMode,
): { overId: string; before: boolean } | null {
  let best: { id: string; before: boolean; distance: number } | null = null
  for (const el of scrollEl.querySelectorAll<HTMLElement>('[data-bundle-id]')) {
    const id = el.dataset.bundleId
    if (id === undefined) continue
    // Grid/justified cards sit inside a positioned slot that owns the gap
    // geometry; list rows are their own geometry.
    const box = el.closest<HTMLElement>('.browser__cardslot') ?? el
    const r = box.getBoundingClientRect()
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right)
    const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom)
    const distance = Math.hypot(dx, dy)
    const before =
      layout === 'list' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2
    if (best === null || distance < best.distance) best = { id, before, distance }
  }
  if (best === null) return null
  return { overId: best.id, before: best.before }
}

export function Browser(props: BrowserProps) {
  const {
    items,
    layout,
    zoom,
    selectedIds,
    onSelect,
    onOpen,
    onContextMenu,
    onMarqueeSelect,
    onReorder,
    onBundleDragStart,
    onBundleDragEnd,
  } = props
  // State-backed ref: the virtualizer re-initializes (and measures the
  // viewport) once the scroll element is actually attached.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  // Manual-reorder drag: the id being dragged, and the current drop slot (which
  // card, and whether the insertion point is before or after it). The slot drives
  // a gap indicator so the drop lands *between* items, not onto one.
  const [dragId, setDragId] = useState<string | null>(null)
  // The destination, not a card and a side — see DropTarget in dnd.ts. One gap,
  // one name, one seam.
  const [dropSlot, setDropSlot] = useState<DropTarget | null>(null)
  // The dragged payload, in a ref: the commit path never reads React state
  // (a drop can fire before the render that state update scheduled), and
  // dataTransfer's payload is unreadable during dragover by spec — the ref is
  // the one place that is always current within this window.
  const dragIdsRef = useRef<string[] | null>(null)
  // Where the pointer came to rest as the drag ended. A settled reorder slides
  // cards under that stationary pointer, and each one that passes gets a
  // mouse-enter — so whichever card ends up under the cursor starts its hover
  // preview unasked (and if it then slides on without a mouse-leave, keeps
  // playing with the pointer nowhere near it). Previews stay disabled until the
  // pointer travels away from this point — the signal that hovering is
  // intentional again.
  const settlePoint = useRef<{ x: number; y: number } | null>(null)
  const [settling, setSettling] = useState(false)
  const settleAt = (e: { clientX: number; clientY: number }) => {
    settlePoint.current = { x: e.clientX, y: e.clientY }
    setSettling(true)
  }
  const onContainerMouseMove = (e: React.MouseEvent) => {
    if (!settling) return
    const at = settlePoint.current
    if (at === null || Math.hypot(e.clientX - at.x, e.clientY - at.y) > 8) setSettling(false)
  }
  const clearDrag = () => {
    dragIdsRef.current = null
    setDragId(null)
    setDropSlot(null)
    onBundleDragEnd?.()
  }
  // Drag handlers for a card/row. A card is draggable when it can be reordered
  // (Manual sort) or moved into a collection (always, if the parent wired the
  // cross-surface hook). Reorder over/drop only fire when onReorder is set.
  // The gap a drop lands in, named by the card that will follow the moved block:
  // the leading half of a card is the gap before it, the trailing half is the gap
  // before whatever comes next (null at the end of the list = append). Cards in
  // the moved block are skipped — naming one of them would describe the gap by a
  // card that is about to leave it, which the server can only read as "nowhere".
  const itemIds = useMemo(() => items.map((i) => i.id), [items])

  const gapBefore = (overId: string, before: boolean, moved: string[]): string | null => {
    const index = items.findIndex((i) => i.id === overId)
    if (index < 0) return null
    for (let at = before ? index : index + 1; at < items.length; at++) {
      const candidate = items[at]?.id
      if (candidate !== undefined && !moved.includes(candidate)) return candidate
    }
    return null
  }

  const dragProps = (id: string) => {
    if (!onReorder && !onBundleDragStart) return {}
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        // copyMove (not plain move) so holding Option/Alt — which the OS reads as
        // a "copy" gesture — still yields a valid drop (Alt = add to collection
        // without removing from the current one) instead of a rejected drag.
        e.dataTransfer.effectAllowed = 'copyMove'
        // Carry the whole selection when dragging a selected card, else just this.
        const targets = selectionTargets(id, selectedIds)
        dragIdsRef.current = targets
        e.dataTransfer.setData(DRAG_BUNDLES, targets.join(' '))
        setDragId(id)
        setDropSlot(null) // the previous drag's gap indicator must not flash back
        const title = items.find((i) => i.id === id)?.title ?? 'Bundle'
        setDragBadge(e, dragBadgeLabel(targets.length, title, 'bundle'))
        onBundleDragStart?.(targets)
      },
      onDragEnd: (e: React.DragEvent) => {
        // A drag cancelled outside the grid still leaves the pointer somewhere —
        // the settle window applies to every way a drag can end, not just drops.
        settleAt(e)
        clearDrag()
      },
      // Deliberately no per-card dragover/drop: the container owns the whole
      // gesture (see onContainerDragOver/Drop), so there is exactly one handler
      // pair and one gap computation — nothing to race, nothing to disagree.
      // One seam per destination: a leading line on the card the block lands
      // before, or a trailing line on the last card when it lands at the end.
      'data-drop': seamFor(dropSlot, id, itemIds),
    }
  }
  const [width, setWidth] = useState(0)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    if (!scrollEl) return
    const update = () => setWidth(scrollEl.clientWidth - H_PADDING * 2)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [scrollEl])

  const rows = useMemo(() => computeRows(items, layout, width, zoom), [items, layout, width, zoom])

  // Cumulative top offset of each row in content space — mirrors what the
  // virtualizer derives from estimateSize, so marquee math stays in sync with
  // rendered positions without needing to measure the (possibly unmounted,
  // virtualized-away) DOM nodes.
  const rowTops = useMemo(() => {
    const tops: number[] = []
    let acc = 0
    for (const row of rows) {
      tops.push(acc)
      acc += row.height
    }
    return tops
  }, [rows])

  const cardRect = (rowIndex: number, row: Row, card: PlacedCard): MarqueeRect => {
    const top = rowTops[rowIndex] ?? 0
    if (layout === 'list') return { left: 0, top, width, height: row.height }
    return { left: card.x, top, width: card.width, height: row.height - 10 }
  }

  const idsInRect = (rect: MarqueeRect): string[] => {
    const ids: string[] = []
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri]
      if (!row) continue
      const top = rowTops[ri] ?? 0
      if (top > rect.top + rect.height) break
      if (top + row.height < rect.top) continue
      for (const card of row.cards) {
        if (rectsIntersect(rect, cardRect(ri, row, card))) ids.push(card.item.id)
      }
    }
    return ids
  }

  const { marqueeRect, onMouseDown: onBackgroundMouseDown } = useMarqueeSelect({
    getScrollEl: () => scrollEl,
    getWrapperEl: () => wrapperRef.current,
    // A drag can rubber-band from empty space always, and *from a list row* when
    // rows aren't reorder-draggable (list rows fill the width, so there'd be no
    // empty space to grab otherwise; a plain click still selects via the 4px
    // threshold). In manual sort the native row-drag owns the gesture instead.
    // Only true empty space starts a band; a card or row is never a band origin.
    isBackgroundTarget: (target) =>
      !target.closest('.list-row--head') && !target.closest('[data-bundle-id]'),
    rubberBand: layout !== 'list',
    hitTest: idsInRect,
    getBaseSelection: () => selectedIds,
    onChange: onMarqueeSelect,
  })

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns non-memoizable fns; safe here
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => rows[i]?.height ?? 100,
    overscan: 6,
  })

  // The virtualizer caches row sizes and only re-derives them when the row
  // count changes. Grid zoom changes the column count (so it recomputes), but
  // list zoom keeps one row per item — so force a re-measure when zoom/layout
  // change, otherwise list rows wouldn't grow/shrink with the slider.
  useEffect(() => {
    virtualizer.measure()
  }, [zoom, layout, width, virtualizer])

  // Load the next page when the user scrolls near the end.
  const virtualItems = virtualizer.getVirtualItems()
  useEffect(() => {
    const last = virtualItems.at(-1)
    if (!last) return
    if (last.index >= rows.length - 4 && props.hasNextPage && !props.isFetchingNextPage) {
      props.fetchNextPage()
    }
  }, [virtualItems, rows.length, props])

  // The scroll container is always mounted (even for states) so its width is
  // measured once the data arrives — otherwise the virtualizer would size to 0.
  const showGrid = !props.isError && !props.isLoading && items.length > 0

  // Fire the empty-space menu only when the target isn't a card/row (cards call
  // their own onContextMenu, which bubbles here).
  const onRootContextMenu = (e: React.MouseEvent) => {
    if (!props.onEmptyContextMenu) return
    if ((e.target as HTMLElement).closest('[data-bundle-id]')) return
    props.onEmptyContextMenu(e)
  }

  // The container owns the whole reorder gesture. Both handlers run the same
  // `computeGap` over the same cursor position: dragover paints the indicator
  // from it, drop commits it. What the blue line shows is, by construction,
  // what the drop does.
  // Resolve the cursor to a destination: the item the block lands in front of,
  // or null for the end. Returns undefined when there is nothing to land on.
  const resolveTarget = (e: React.DragEvent, moved: string[]): DropTarget | undefined => {
    if (!scrollEl) return undefined
    const gap = computeGap(scrollEl, e, layout)
    if (gap === null) return undefined
    return { kind: 'gap', beforeId: gapBefore(gap.overId, gap.before, moved) }
  }

  const onContainerDragOver = (e: React.DragEvent) => {
    if (!onReorder || !scrollEl || dragIdsRef.current === null) return
    e.preventDefault()
    const target = resolveTarget(e, dragIdsRef.current) ?? null
    setDropSlot((prev) => (sameTarget(prev, target) ? prev : target))
  }
  const onContainerDrop = (e: React.DragEvent) => {
    if (!onReorder || !scrollEl) return
    // Same-window drags carry the payload in the ref; the dataTransfer copy is
    // the fallback for a drop whose dragstart this component never saw.
    const moved =
      dragIdsRef.current ?? e.dataTransfer.getData(DRAG_BUNDLES).split(' ').filter(Boolean)
    if (moved.length === 0) return
    e.preventDefault()
    const target = resolveTarget(e, moved)
    if (target !== undefined && target.kind === 'gap')
      onReorder({ movedIds: moved, beforeId: target.beforeId })
    settleAt(e)
    clearDrag()
  }
  // Leaving the browser mid-drag (headed for the sidebar, say) takes the
  // indicator with it — a line promising an insertion that pointer is no longer
  // offering.
  const onContainerDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDropSlot(null)
  }

  return (
    <div
      className={`browser${marqueeRect ? ' browser--dragging' : ''}`}
      ref={setScrollEl}
      role="listbox"
      aria-label="Bundles"
      onMouseDownCapture={suppressShiftSelection}
      onMouseDown={onBackgroundMouseDown}
      onMouseMove={onContainerMouseMove}
      onContextMenu={onRootContextMenu}
      onDragOver={onContainerDragOver}
      onDrop={onContainerDrop}
      onDragLeave={onContainerDragLeave}
    >
      {props.isError && (
        <div className="state state--error">
          <div>Couldn’t load the library.</div>
          <code>{props.error instanceof Error ? props.error.message : 'Unknown error'}</code>
        </div>
      )}
      {props.isLoading && (
        <div className="state">{props.searchQuery ? 'Searching…' : 'Loading library…'}</div>
      )}
      {!props.isLoading && !props.isError && items.length === 0 && (
        <div className="state">
          {props.searchQuery ? (
            <>
              <div>No matches for “{props.searchQuery}”.</div>
              <div>Try a different title, filename, tag, or collection.</div>
            </>
          ) : (
            (props.emptyState ?? (
              <>
                <div>Nothing here yet.</div>
                <div>Update the library or add files to see bundles.</div>
              </>
            ))
          )}
        </div>
      )}

      {showGrid && layout === 'list' && <ListHeader />}
      {showGrid && (
        <div
          ref={wrapperRef}
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
            margin: `0 ${H_PADDING}px`,
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
          {virtualItems.map((vRow) => {
            const row = rows[vRow.index]
            if (!row) return null
            return (
              <div
                key={vRow.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width,
                  height: vRow.size,
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                {layout === 'list'
                  ? row.cards.map((c) => (
                      <ListRow
                        key={c.item.id}
                        item={c.item}
                        selected={selectedIds.has(c.item.id)}
                        onSelect={onSelect}
                        onOpen={onOpen}
                        onContextMenu={onContextMenu}
                        dragProps={dragProps(c.item.id)}
                      />
                    ))
                  : row.cards.map((c) => (
                      <div
                        key={c.item.id}
                        className="browser__cardslot"
                        style={{
                          position: 'absolute',
                          left: c.x,
                          width: c.width,
                          height: row.height - 10,
                        }}
                        {...dragProps(c.item.id)}
                      >
                        <BundleCard
                          item={c.item}
                          selected={selectedIds.has(c.item.id)}
                          showMeta={layout === 'grid'}
                          onSelect={onSelect}
                          onOpen={onOpen}
                          onContextMenu={onContextMenu}
                          previewDisabled={
                            dragId !== null ||
                            settling ||
                            marqueeRect !== null ||
                            props.contextMenuOpen === true
                          }
                        />
                      </div>
                    ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ListHeader() {
  return (
    <div className="list-row list-row--head" style={{ position: 'sticky', height: 36 }}>
      <span />
      <span>Name</span>
      <span className="list-cell">Dimensions</span>
      <span className="list-cell">Type</span>
      <span className="list-cell">Size</span>
      <span className="list-cell">Date Added</span>
    </div>
  )
}

function ListRow({
  item,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  dragProps,
}: {
  item: BundleSummary
  selected: boolean
  onSelect: (id: string, e: React.MouseEvent) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  dragProps?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }
}) {
  return (
    <div
      className={`list-row${selected ? ' list-row--selected' : ''}`}
      style={{ height: '100%', width: '100%' }}
      // Select on press so a drag departs with this row selected — see the same
      // handler on BundleCard for the full reasoning.
      onMouseDown={(e) => {
        if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || selected) return
        onSelect(item.id, e)
      }}
      onClick={(e) => onSelect(item.id, e)}
      onDoubleClick={() => onOpen(item.id)}
      onContextMenu={(e) => onContextMenu(item.id, e)}
      role="option"
      aria-selected={selected}
      data-bundle-id={item.id}
      {...dragProps}
    >
      <div
        className="list-row__thumb"
        style={
          item.has_cover
            ? { backgroundImage: `url(${thumbnailUrl(item.id, item.cover_key)})` }
            : undefined
        }
      />
      <div className="list-row__title">{item.title ?? 'Untitled'}</div>
      <span className="list-cell">{formatDimensions(item.width, item.height)}</span>
      <span className="list-cell">{item.extension ?? '—'}</span>
      <span className="list-cell">{formatBytes(item.total_size)}</span>
      <span className="list-cell">{formatDate(item.date_added)}</span>
    </div>
  )
}
