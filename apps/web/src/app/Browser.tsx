import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'

import type { BundleSummary } from '../api/client'
import { thumbnailUrl } from '../api/client'
import { formatBytes, formatDate, formatDimensions } from '../lib/format'
import { BundleCard } from './BundleCard'
import { computeRows } from './layout'
import type { LayoutMode } from './types'

const H_PADDING = 12

interface BrowserProps {
  items: BundleSummary[]
  total: number
  layout: LayoutMode
  zoom: number
  selectedIds: Set<string>
  onSelect: (id: string, e: React.MouseEvent) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  // Right-click on empty space (not on a card/row) — e.g. to create a bundle.
  onEmptyContextMenu?: (e: React.MouseEvent) => void
  isLoading: boolean
  isError: boolean
  error?: unknown
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => void
  // When set, an empty result is shown as "no matches" for this query rather
  // than the generic "nothing here yet" state.
  searchQuery?: string
}

export function Browser(props: BrowserProps) {
  const { items, layout, zoom, selectedIds, onSelect, onOpen, onContextMenu } = props
  // State-backed ref: the virtualizer re-initializes (and measures the
  // viewport) once the scroll element is actually attached.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    if (!scrollEl) return
    const update = () => setWidth(scrollEl.clientWidth - H_PADDING * 2)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(scrollEl)
    return () => ro.disconnect()
  }, [scrollEl])

  const rows = useMemo(() => computeRows(items, layout, width, zoom), [items, layout, width, zoom])

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns non-memoizable fns; safe here
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: (i) => rows[i]?.height ?? 100,
    overscan: 6,
  })

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
      className="browser"
      ref={setScrollEl}
      role="listbox"
      aria-label="Bundles"
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
            <>
              <div>Nothing here yet.</div>
              <div>Update the library or add files to see bundles.</div>
            </>
          )}
        </div>
      )}

      {showGrid && layout === 'list' && <ListHeader />}
      {showGrid && (
        <div
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
                      />
                    ))
                  : row.cards.map((c) => (
                      <div
                        key={c.item.id}
                        style={{
                          position: 'absolute',
                          left: c.x,
                          width: c.width,
                          height: row.height - 10,
                        }}
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
}: {
  item: BundleSummary
  selected: boolean
  onSelect: (id: string, e: React.MouseEvent) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
}) {
  return (
    <div
      className={`list-row${selected ? ' list-row--selected' : ''}`}
      style={{ height: 40, width: '100%' }}
      onClick={(e) => onSelect(item.id, e)}
      onDoubleClick={() => onOpen(item.id)}
      onContextMenu={(e) => onContextMenu(item.id, e)}
      role="option"
      aria-selected={selected}
      data-bundle-id={item.id}
    >
      <div
        className="list-row__thumb"
        style={item.has_cover ? { backgroundImage: `url(${thumbnailUrl(item.id)})` } : undefined}
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
