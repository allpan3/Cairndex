import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { BundleSummary } from '../api/client'
import { thumbnailUrl } from '../api/client'
import { formatBytes, formatDate, formatDimensions } from '../lib/format'
import { BundleCard } from './BundleCard'
import { computeRows, type PlacedCard, type Row } from './layout'
import { moveTo } from './reorder'
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
  // Right-click on empty space (not on a card/row) — e.g. to create a bundle.
  onEmptyContextMenu?: (e: React.MouseEvent) => void
  // When set (Manual sort), cards/rows become drag-reorderable; a drop fires the
  // full resulting order of loaded items.
  onReorder?: (orderedIds: string[]) => void
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
  const [dropSlot, setDropSlot] = useState<{ id: string; before: boolean } | null>(null)
  const clearDrag = () => {
    setDragId(null)
    setDropSlot(null)
    onBundleDragEnd?.()
  }
  // Drag handlers for a card/row. A card is draggable when it can be reordered
  // (Manual sort) or moved into a collection (always, if the parent wired the
  // cross-surface hook). Reorder over/drop only fire when onReorder is set.
  const dragProps = (id: string) => {
    if (!onReorder && !onBundleDragStart) return {}
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        // copyMove (not plain move) so holding Option/Alt — which the OS reads as
        // a "copy" gesture — still yields a valid drop (Alt = add to collection
        // without removing from the current one) instead of a rejected drag.
        e.dataTransfer.effectAllowed = 'copyMove'
        setDragId(id)
        // Carry the whole selection when dragging a selected card, else just this.
        onBundleDragStart?.(selectedIds.has(id) ? [...selectedIds] : [id])
      },
      onDragEnd: clearDrag,
      onDragOver: (e: React.DragEvent) => {
        if (!onReorder || dragId === null || dragId === id) return
        e.preventDefault()
        // Insert before/after based on which half of the target the cursor is in
        // — horizontally for grid/justified tiles, vertically for list rows.
        const r = e.currentTarget.getBoundingClientRect()
        const before =
          layout === 'list' ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2
        setDropSlot((prev) => (prev?.id === id && prev.before === before ? prev : { id, before }))
      },
      onDrop: (e: React.DragEvent) => {
        if (!onReorder || dragId === null || dragId === id) return
        e.preventDefault()
        onReorder(
          moveTo(
            items.map((i) => i.id),
            dragId,
            id,
            dropSlot?.id === id ? dropSlot.before : true,
          ),
        )
        clearDrag()
      },
      'data-drop': dropSlot?.id === id ? (dropSlot.before ? 'before' : 'after') : undefined,
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
    isBackgroundTarget: (target) => {
      if (target.closest('.list-row--head')) return false
      if (!target.closest('[data-bundle-id]')) return true
      return layout === 'list' && !onReorder
    },
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

  return (
    <div
      className={`browser${marqueeRect ? ' browser--dragging' : ''}`}
      ref={setScrollEl}
      role="listbox"
      aria-label="Bundles"
      onMouseDown={onBackgroundMouseDown}
      onContextMenu={onRootContextMenu}
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
      <div className="list-row__title">
        {item.title ?? 'Untitled'}
        {item.grouping_state === 'provisional' && (
          <span className="list-row__state">Needs review</span>
        )}
      </div>
      <span className="list-cell">{formatDimensions(item.width, item.height)}</span>
      <span className="list-cell">{item.extension ?? '—'}</span>
      <span className="list-cell">{formatBytes(item.total_size)}</span>
      <span className="list-cell">{formatDate(item.date_added)}</span>
    </div>
  )
}
