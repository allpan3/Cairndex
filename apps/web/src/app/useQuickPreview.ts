import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { BundleCardItem } from './BundleCard'

/**
 * The preview's place in a paged result: which loaded bundle it shows, and a
 * step that pages further results in when it walks past the loaded ones. The
 * selection follows each step, as Eagle's does, so closing leaves the grid on
 * the bundle last seen.
 */
export function useQuickPreview({
  items,
  activeId,
  total,
  hasNextPage,
  fetchingNextPage,
  fetchNextPage,
  onSelect,
}: {
  items: BundleCardItem[]
  activeId: string | null
  total: number
  hasNextPage: boolean
  fetchingNextPage: boolean
  fetchNextPage: () => void
  onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  // A step beyond the loaded results waits here for its page
  const waiting = useRef<number | null>(null)
  const position = items.findIndex((item) => item.id === activeId)
  const item = open && position >= 0 ? items[position]! : null
  const select = useRef(onSelect)
  useLayoutEffect(() => {
    select.current = onSelect
  })
  useEffect(() => {
    const target = waiting.current
    if (target === null || items.length <= target) return
    waiting.current = null
    select.current(items[target]!.id)
  }, [items])
  // Keep a page ahead, so stepping never waits at the edge of what is loaded
  useEffect(() => {
    if (item && position >= items.length - 5 && hasNextPage && !fetchingNextPage) fetchNextPage()
  }, [item, position, items.length, hasNextPage, fetchingNextPage, fetchNextPage])
  const step = (delta: number) => {
    const next = position + delta
    if (position < 0 || next < 0 || next >= total) return
    if (next < items.length) onSelect(items[next]!.id)
    else if (hasNextPage) waiting.current = next
  }
  return {
    item,
    position,
    show: () => setOpen(true),
    close: () => {
      setOpen(false)
      waiting.current = null
    },
    step,
  }
}
