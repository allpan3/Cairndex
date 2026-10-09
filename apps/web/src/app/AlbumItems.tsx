import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useImperativeHandle, useState } from 'react'
import type { BrowserNavigation } from './Browser'
import { listRowHeight } from './layout'
import type { LayoutMode } from './types'

/** Shared album window. Layout and focus use all loaded rows, including off-screen rows. */
export function AlbumItems<T extends { id: string }>({
  items,
  scrollRef,
  layout,
  zoom,
  render,
  navigationRef,
}: {
  items: T[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  layout: LayoutMode
  zoom: number
  render: (item: T) => React.ReactNode
  navigationRef?: React.Ref<BrowserNavigation>
}) {
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [scrollRef])
  const columns = layout === 'list' ? 1 : Math.max(1, Math.floor((width - 24) / (zoom * 0.75 + 12)))
  const height = layout === 'list' ? listRowHeight(zoom) : (width - 24) / columns + 56
  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer is used directly, without memoized consumers.
  const virtual = useVirtualizer({
    count: Math.ceil(items.length / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => height,
    overscan: 3,
  })
  useEffect(() => virtual.measure(), [virtual, height])
  useImperativeHandle(
    navigationRef,
    () => ({
      step: (from, direction) => {
        const at = items.findIndex((item) => item.id === from)
        return (
          items[
            Math.max(0, Math.min(items.length - 1, at + (direction === 'up' ? -columns : columns)))
          ]?.id ?? null
        )
      },
      focus: (id) => {
        const at = items.findIndex((item) => item.id === id)
        if (at < 0) return
        virtual.scrollToIndex(Math.floor(at / columns), { align: 'auto' })
        requestAnimationFrame(() =>
          scrollRef.current
            ?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(id)}"]`)
            ?.focus({ preventScroll: true }),
        )
      },
    }),
    [items, columns, scrollRef, virtual],
  )
  return (
    <div
      style={{
        position: 'relative',
        height: virtual.getTotalSize(),
        minWidth: layout === 'list' ? 500 : undefined,
        ['--file-row-h' as string]: `${listRowHeight(zoom)}px`,
      }}
    >
      {virtual.getVirtualItems().map((row) => (
        <div
          key={row.key}
          style={{
            position: 'absolute',
            top: row.start,
            left: 0,
            right: 0,
            height: row.size,
            display: 'grid',
            gap: 12,
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          }}
        >
          {items.slice(row.index * columns, (row.index + 1) * columns).map((item) => (
            <div key={item.id} style={{ minWidth: 0 }}>
              {render(item)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
