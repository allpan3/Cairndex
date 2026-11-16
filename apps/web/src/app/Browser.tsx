import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { BundleSort, SortOrder } from '../api/client'
import { thumbnailUrl } from '../api/client'
import { formatBytes, formatDate, formatDimensions } from '../lib/format'
import { BundleCard, type BundleCardItem } from './BundleCard'
import { CoverImage } from './CoverImage'
import { dragBadgeLabel, draggedCovers, setCoversDragImage } from './dragBadge'
import { computeRows, type PlacedCard, type Row } from './layout'
import type { DropTarget } from './dnd'
import { DRAG_BUNDLES, sameTarget, seamFor } from './dnd'
import { focusListing, selectionTargets } from './selection'
import { rowStep } from './spatialNav'
import { cardCentre, zoomAnchor } from './zoomAnchor'
import { SortHeaderCell } from './SortHeader'
import type { LayoutMode } from './types'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'

const H_PADDING = 12

// The full layout owns navigation even when a target row is outside the rendered window
export interface BrowserNavigation {
  step: (from: string | null, direction: 'up' | 'down') => string | null
  focus: (id: string) => void
  /**
   * Show a zoom being dragged without laying the grid out again: cards and
   * justified tiles scale around the item a zoom keeps in place, and the next
   * `zoom` prop lays them out once. Null ends the preview. List rows have no
   * cheaper stand-in than their real height, so a list lays itself out live.
   */
  previewZoom?: (zoom: number | null) => void
}

/** A zoom preview in progress: the zoom it scales from and the item it holds still. */
interface ZoomPreview {
  base: number
  /** `screenY`: the anchor's centre in the window, which the zoom keeps */
  anchor: { id: string; screenY: number } | null
  ending: boolean
}

interface BrowserProps {
  showCardDetails?: boolean
  unavailableSize?: boolean
  singleSelection?: boolean

  items: BundleCardItem[]
  total: number
  layout: LayoutMode
  zoom: number
  // The active sort, so the list view's headers can show and change it.
  sort: BundleSort
  order: SortOrder
  onSort: (sort: BundleSort, order: SortOrder) => void
  selectedIds: Set<string>
  activeId?: string | null
  navigationRef?: React.Ref<BrowserNavigation>
  onSelect: (id: string, e: React.MouseEvent) => void
  // Fired continuously while a marquee drag is in progress (and once more on
  // mouseup) with the full resulting selection — replaces selectedIds wholesale.
  onMarqueeSelect: (ids: string[]) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  contextMenuOpen?: boolean
  // Right-click on empty space (not on a card/row) — e.g. to create a bundle.
  onEmptyContextMenu?: (e: React.MouseEvent) => void
  // OS files dropped on a card: import into the library, link into that bundle.
  onDropFilesOnBundle?: (id: string, files: File[]) => void
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
  /** Offered beside a failed load. */
  onRetry?: () => void
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  // The collection sections, drawn above the bundles in the same scroll area so
  // one scrollbar and one band cover both. A band selects within the section it
  // starts in: collections and bundles selected together mean nothing.
  header?: React.ReactNode
  headerSelectedIds?: Set<string>
  onHeaderMarqueeSelect?: (ids: string[]) => void
  // The header's Contents section is folded, so no bundles are shown.
  contentsHidden?: boolean
  // When set, an empty result is shown as "no matches" for this query rather
  // than the generic "nothing here yet" state.
  searchQuery?: string
  onClearSearch?: () => void
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

// Where `inner` sits within `outer`; both scroll together, so this holds at any scroll position
function offsetWithin(outer: HTMLElement | null, inner: HTMLElement | null) {
  const a = outer?.getBoundingClientRect()
  const b = inner?.getBoundingClientRect()
  return a && b ? { x: b.left - a.left, y: b.top - a.top } : null
}

export function Browser(props: BrowserProps) {
  const {
    showCardDetails = true,
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
        setCoversDragImage(
          e,
          dragBadgeLabel(targets.length, title, 'bundle'),
          draggedCovers(scrollEl, id, targets),
        )
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
  // Everything that scrolls: the header, then the listing. Band coordinates are
  // relative to it, so a band is never cut off where the sections meet.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const listingRef = useRef<HTMLDivElement | null>(null)
  // How far below the top of the scrolled content the bundle grid starts
  const [scrollMargin, setScrollMargin] = useState(0)
  const gridOffset = () => offsetWithin(contentRef.current, wrapperRef.current)
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    // The header folding, a list header appearing or the grid mounting resize
    // the content, or, when it is shorter than the view, the listing below
    const update = () => setScrollMargin(offsetWithin(content, wrapperRef.current)?.y ?? 0)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(content)
    if (listingRef.current) ro.observe(listingRef.current)
    return () => ro.disconnect()
  }, [props.contentsHidden])
  // A dragged zoom: the list's live row height, extra rows rendered while cards
  // shrink, and a render request when the drag ends (see previewZoom)
  const [listZoom, setListZoom] = useState<number | null>(null)
  const [zoomOverscan, setZoomOverscan] = useState(0)
  const [zoomSettled, setZoomSettled] = useState(0)
  const zoomPreview = useRef<ZoomPreview | null>(null)
  const shownZoom = layout === 'list' && listZoom !== null ? listZoom : zoom

  useLayoutEffect(() => {
    if (!scrollEl) return
    const update = () => setWidth(scrollEl.clientWidth - H_PADDING * 2)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [scrollEl])

  const rows = useMemo(
    () => computeRows(items, layout, width, shownZoom, showCardDetails),
    [items, layout, width, shownZoom, showCardDetails],
  )

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

  // The header marks its own space with data-band; the rest belongs to the bundles
  const bundleSpace = (target: HTMLElement) =>
    (target.closest<HTMLElement>('[data-band]')?.dataset.band ?? 'bundles') === 'bundles'

  const collectionsInRect = (rect: MarqueeRect): string[] => {
    const content = contentRef.current
    if (!content) return []
    const origin = content.getBoundingClientRect()
    const ids: string[] = []
    for (const el of content.querySelectorAll<HTMLElement>('[data-collection-id]')) {
      const r = el.getBoundingClientRect()
      const card = {
        left: r.left - origin.left,
        top: r.top - origin.top,
        width: r.width,
        height: r.height,
      }
      if (rectsIntersect(rect, card)) ids.push(el.dataset.collectionId as string)
    }
    return ids
  }

  const bundleBand = useMarqueeSelect({
    getScrollEl: () => scrollEl,
    getWrapperEl: () => contentRef.current,
    // Only true empty space starts a band; a card or row is never a band origin.
    isBackgroundTarget: (target) =>
      bundleSpace(target) &&
      !target.closest('button, label, input') &&
      !target.closest('.list-row--head') &&
      !target.closest('[data-bundle-id]'),
    rubberBand: layout !== 'list',
    hitTest: (rect) => {
      const at = gridOffset()
      return at ? idsInRect({ ...rect, left: rect.left - at.x, top: rect.top - at.y }) : []
    },
    getBaseSelection: () => selectedIds,
    onChange: onMarqueeSelect,
  })
  const collectionBand = useMarqueeSelect({
    getScrollEl: () => scrollEl,
    getWrapperEl: () => contentRef.current,
    isBackgroundTarget: (target) =>
      !bundleSpace(target) &&
      !target.closest('[data-collection-id]') &&
      !target.closest('button, label, input'),
    hitTest: collectionsInRect,
    getBaseSelection: () => props.headerSelectedIds ?? new Set<string>(),
    onChange: (ids) => props.onHeaderMarqueeSelect?.(ids),
  })
  const marqueeRect = bundleBand.marqueeRect ?? collectionBand.marqueeRect
  const onBackgroundMouseDown = (e: React.MouseEvent) => {
    if (!props.singleSelection) bundleBand.onMouseDown(e)
    if (props.header) collectionBand.onMouseDown(e)
  }

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns non-memoizable fns; safe here
  const virtualizer = useVirtualizer({
    count: props.contentsHidden ? 0 : rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => rows[i]?.height ?? 100,
    overscan: 6 + zoomOverscan,
    scrollMargin,
  })

  // Cards stand in the top of their row; the rest of its height is the gap below
  const cardGap = layout === 'list' ? 0 : 10
  // Where the grid starts inside the scrolled content, so zoom anchoring holds
  // whatever sits above the grid (the list's header, for one)
  const gridTop = () => {
    const wrapper = wrapperRef.current
    if (!wrapper || !scrollEl) return 0
    return (
      wrapper.getBoundingClientRect().top -
      scrollEl.getBoundingClientRect().top +
      scrollEl.scrollTop
    )
  }
  // The item a zoom holds still, and where it sat in the window. Measured in
  // the window rather than the scroll area, because what sits above the grid
  // (the collections strip) can resize with the same zoom.
  const anchorFor = (inRows: Row[], tops: number[], scrollTop: number, viewTop: number) => {
    if (!scrollEl || scrollEl.clientHeight === 0) return null
    const top = gridTop()
    const view = { top: scrollTop - top, bottom: scrollTop - top + scrollEl.clientHeight, width }
    const id = zoomAnchor(inRows, tops, view, props.activeId ?? null)
    const centre = id ? cardCentre(inRows, tops, id, cardGap) : null
    return id && centre ? { id, screenY: viewTop + top + centre.y - scrollTop, centre } : null
  }
  // The layout last shown, so a zoom change can find its anchor where it was
  const shown = useRef<{
    zoom: number
    layout: LayoutMode
    width: number
    rows: Row[]
    rowTops: number[]
    scrollTop: number
    viewTop: number
  } | null>(null)
  // One layout per zoom: keep the anchor where it was on screen, and drop a
  // finished preview's scaling in the same frame the real layout appears
  useLayoutEffect(() => {
    const before = shown.current
    const preview = zoomPreview.current
    const wrapper = wrapperRef.current
    const ending = preview?.ending ?? false
    if (ending) {
      zoomPreview.current = null
      if (wrapper) {
        wrapper.style.transform = ''
        wrapper.style.transformOrigin = ''
      }
      scrollEl?.classList.remove('browser--zooming')
      setZoomOverscan(0)
      setListZoom(null)
    }
    shown.current = {
      zoom: shownZoom,
      layout,
      width,
      rows,
      rowTops,
      scrollTop: scrollEl?.scrollTop ?? 0,
      viewTop: scrollEl?.getBoundingClientRect().top ?? 0,
    }
    if (!before || !scrollEl || !wrapper || before.layout !== layout || before.width !== width)
      return
    if (before.zoom === shownZoom && !ending) return
    const anchor =
      preview?.anchor ?? anchorFor(before.rows, before.rowTops, before.scrollTop, before.viewTop)
    const centre = anchor ? cardCentre(rows, rowTops, anchor.id, cardGap) : null
    if (!anchor || !centre) return
    // Row sizes are cached until measured; the scroll below needs the new total
    virtualizer.measure()
    wrapper.style.height = `${virtualizer.getTotalSize()}px`
    const viewTop = scrollEl.getBoundingClientRect().top
    scrollEl.scrollTop = Math.max(0, gridTop() + centre.y - (anchor.screenY - viewTop))
    shown.current.scrollTop = scrollEl.scrollTop
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per layout; helpers read it
  }, [shownZoom, layout, width, rows, rowTops, zoomSettled])

  const previewZoom = (next: number | null) => {
    const wrapper = wrapperRef.current
    if (next === null) {
      if (zoomPreview.current) {
        zoomPreview.current.ending = true
        setZoomSettled((count) => count + 1)
      }
      return
    }
    if (!wrapper || !scrollEl) return
    if (!zoomPreview.current) {
      const anchor = anchorFor(
        rows,
        rowTops,
        scrollEl.scrollTop,
        scrollEl.getBoundingClientRect().top,
      )
      zoomPreview.current = {
        base: shownZoom,
        anchor: anchor && { id: anchor.id, screenY: anchor.screenY },
        ending: false,
      }
      if (layout !== 'list') {
        if (anchor) wrapper.style.transformOrigin = `${anchor.centre.x}px ${anchor.centre.y}px`
        scrollEl.classList.add('browser--zooming')
      }
    }
    if (layout === 'list') {
      setListZoom(next)
      return
    }
    const scale = next / zoomPreview.current.base
    wrapper.style.transform = scale === 1 ? '' : `scale(${scale})`
    // Shrinking cards bring rows into view that the virtualizer has not
    // rendered; render enough of them, growing only, until the drag ends
    if (scale < 1 && rows.length) {
      const height = scrollEl.clientHeight
      const shortest = Math.min(...rows.slice(0, 50).map((row) => row.height))
      const extra = Math.min(60, Math.ceil((height / scale - height) / shortest))
      setZoomOverscan((current) => Math.max(current, extra))
    }
  }

  useImperativeHandle(props.navigationRef, () => ({
    step: (from, direction) =>
      rowStep(
        rows.flatMap((row, index) =>
          row.cards.map((card) => ({
            id: card.item.id,
            rect: {
              top: rowTops[index] ?? 0,
              bottom: (rowTops[index] ?? 0) + row.height,
              left: card.x,
              right: card.x + card.width,
            },
          })),
        ),
        from,
        direction,
      ),
    focus: (id) => {
      const index = rows.findIndex((row) => row.cards.some((card) => card.item.id === id))
      if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
      listingRef.current?.focus({ preventScroll: true })
    },
    previewZoom,
  }))

  // Mark the focused option after virtual rows mount, independent of its selected range
  useLayoutEffect(() => {
    scrollEl?.querySelectorAll<HTMLElement>('[data-bundle-id]').forEach((element) => {
      element.id = `bundle-option-${element.dataset.bundleId}`
      element.dataset.focused = String(element.dataset.bundleId === props.activeId)
    })
  })

  // The virtualizer caches row sizes and only re-derives them when the row
  // count changes. Grid zoom changes the column count (so it recomputes), but
  // list zoom keeps one row per item — so force a re-measure when zoom/layout
  // change, otherwise list rows wouldn't grow/shrink with the slider.
  useEffect(() => {
    virtualizer.measure()
  }, [shownZoom, layout, width, virtualizer])

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
  const showGrid = !props.isError && !props.isLoading && items.length > 0 && !props.contentsHidden

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
      onMouseDown={onBackgroundMouseDown}
      onMouseMove={onContainerMouseMove}
      onScroll={() => {
        if (shown.current && scrollEl) shown.current.scrollTop = scrollEl.scrollTop
      }}
    >
      <div ref={contentRef} className="browser__content">
        {props.header}
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
        {!props.contentsHidden && (
          <div
            ref={listingRef}
            className="browser__listing"
            role="listbox"
            aria-label="Bundles"
            aria-multiselectable={!props.singleSelection}
            aria-activedescendant={props.activeId ? `bundle-option-${props.activeId}` : undefined}
            tabIndex={0}
            onMouseDownCapture={focusListing}
            onContextMenu={onRootContextMenu}
            onDragOver={onContainerDragOver}
            onDrop={onContainerDrop}
            onDragLeave={onContainerDragLeave}
          >
            {props.isError && (
              <div className="state state--error">
                <div>Couldn’t load the library.</div>
                <code>{props.error instanceof Error ? props.error.message : 'Unknown error'}</code>
                {props.onRetry && (
                  <button className="btn" onClick={props.onRetry}>
                    Try Again
                  </button>
                )}
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
                    {props.onClearSearch && (
                      <button className="btn" onClick={props.onClearSearch}>Clear search</button>
                    )}
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

            {showGrid && layout === 'list' && (
              <ListHeader sort={props.sort} order={props.order} onSort={props.onSort} />
            )}
            {showGrid && (
              <div
                ref={wrapperRef}
                style={{
                  height: virtualizer.getTotalSize(),
                  position: 'relative',
                  margin: `0 ${H_PADDING}px`,
                }}
              >
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
                        transform: `translateY(${vRow.start - scrollMargin}px)`,
                      }}
                    >
                      {layout === 'list'
                        ? row.cards.map((c) => (
                            <ListRow
                              unavailableSize={props.unavailableSize}
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
                                showMeta={layout === 'grid' && showCardDetails}
                                onSelect={onSelect}
                                onOpen={onOpen}
                                onContextMenu={onContextMenu}
                                previewDisabled={
                                  dragId !== null ||
                                  settling ||
                                  marqueeRect !== null ||
                                  props.contextMenuOpen === true
                                }
                                onDropFiles={props.onDropFilesOnBundle}
                              />
                            </div>
                          ))}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The list view's column headers. The three that name a sort the browse query
 *  actually supports are clickable; Dimensions and Type have no server-side
 *  order behind them, so they stay plain rather than pretending. */
function ListHeader({
  sort,
  order,
  onSort,
}: {
  sort: BundleSort
  order: SortOrder
  onSort: (sort: BundleSort, order: SortOrder) => void
}) {
  return (
    <div className="list-row list-row--head" style={{ position: 'sticky', height: 36 }}>
      <span />
      <SortHeaderCell label="Name" value="title" sort={sort} order={order} onSort={onSort} />
      <span className="list-cell">Dimensions</span>
      <span className="list-cell">Type</span>
      <SortHeaderCell
        label="Size"
        value="size"
        sort={sort}
        order={order}
        onSort={onSort}
        className="list-cell"
      />
      <SortHeaderCell
        label="Date Added"
        value="date_added"
        sort={sort}
        order={order}
        onSort={onSort}
        className="list-cell"
      />
    </div>
  )
}

function ListRow({
  unavailableSize,
  item,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  dragProps,
}: {
  item: BundleCardItem
  unavailableSize?: boolean
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
      <div className="list-row__thumb">
        {item.has_cover && <CoverImage src={thumbnailUrl(item.id, item.cover_key)} />}
      </div>
      <div className="list-row__title">{item.title ?? 'Untitled'}</div>
      <span className="list-cell">{formatDimensions(item.width, item.height)}</span>
      <span className="list-cell">{item.extension ?? '—'}</span>
      <span className="list-cell">
        {unavailableSize || item.size_known === false ? '—' : formatBytes(item.total_size)}
      </span>
      <span className="list-cell">{formatDate(item.date_added)}</span>
    </div>
  )
}
