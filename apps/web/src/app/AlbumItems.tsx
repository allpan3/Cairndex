import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useImperativeHandle, useMemo, useState } from 'react'
import type { BrowserNavigation } from './Browser'
import { CARD_COVER_ASPECT, listRowHeight, packRows, ROW_GAP } from './layout'
import type { LayoutMode } from './types'

/** Shared album window. Layout and focus use all loaded rows, including off-screen rows. */
export function AlbumItems<T extends { id: string }>({
  items,
  scrollRef,
  layout,
  zoom,
  showCardDetails = true,
  getAspect = () => CARD_COVER_ASPECT,
  render,
  navigationRef,
}: {
  items: T[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  layout: LayoutMode
  zoom: number
  showCardDetails?: boolean
  getAspect?: (item: T) => number
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
  const innerWidth = Math.max(120, layout === 'list' ? width : width - 24)
  const rows = useMemo(
    () => packRows(items, layout, innerWidth, zoom, showCardDetails, getAspect),
    [items, layout, innerWidth, zoom, showCardDetails, getAspect],
  )
  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer is used directly, without memoized consumers.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.height ?? listRowHeight(zoom),
    overscan: 3,
  })
  useEffect(() => virtual.measure(), [virtual, rows])
  useImperativeHandle(
    navigationRef,
    () => ({
      step: (from, direction) => {
        if (rows.length === 0) return null
        let rowIndex = -1
        let centerX = 0
        for (let r = 0; r < rows.length; r++) {
          const hit = rows[r]!.cards.find((card) => card.item.id === from)
          if (hit) {
            rowIndex = r
            centerX = hit.x + hit.width / 2
            break
          }
        }
        if (rowIndex < 0) return items[0]?.id ?? null
        const targetRow = rows[rowIndex + (direction === 'up' ? -1 : 1)]
        if (!targetRow || targetRow.cards.length === 0) return from
        return targetRow.cards.reduce((best, candidate) =>
          Math.abs(candidate.x + candidate.width / 2 - centerX) <
          Math.abs(best.x + best.width / 2 - centerX)
            ? candidate
            : best,
        ).item.id
      },
      focus: (id) => {
        const rowIndex = rows.findIndex((row) => row.cards.some((card) => card.item.id === id))
        if (rowIndex < 0) return
        virtual.scrollToIndex(rowIndex, { align: 'auto' })
        requestAnimationFrame(() =>
          scrollRef.current
            ?.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(id)}"]`)
            ?.focus({ preventScroll: true }),
        )
      },
    }),
    [items, rows, scrollRef, virtual],
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
      {virtual.getVirtualItems().map((vRow) => {
        const row = rows[vRow.index]
        if (!row) return null
        if (layout === 'list') {
          const only = row.cards[0]
          if (!only) return null
          return (
            <div
              key={vRow.key}
              style={{
                position: 'absolute',
                top: vRow.start,
                left: 0,
                right: 0,
                height: vRow.size,
              }}
            >
              {render(only.item)}
            </div>
          )
        }
        return (
          <div
            key={vRow.key}
            style={{
              position: 'absolute',
              top: vRow.start,
              left: 0,
              width: innerWidth,
              height: vRow.size,
            }}
          >
            {row.cards.map((card) => (
              <div
                key={card.item.id}
                style={{
                  position: 'absolute',
                  left: card.x,
                  width: card.width,
                  height: row.height - ROW_GAP,
                  minWidth: 0,
                }}
              >
                {render(card.item)}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
