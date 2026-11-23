import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { catalog } from '../api/catalog'
import type { FileBrowserEntry } from '../api/client'
import type { components } from '../api/schema'
import { catalogPoll } from '../api/catalogRevision'

type Page = components['schemas']['CatalogUnbundledPage']
type Item = Page['items'][number]

/** Files per Unbundled request; each returned file is checked on disk, one stat each. */
export const UNBUNDLED_PAGE = 100
// A jump past the pages already shown waits this long for the scrollbar to settle,
// so dragging it through the list does not fetch every page on the way
const SETTLE_MS = 150
const PLAYABLE = new Set(['video', 'image', 'audio'])

/** One queued file as the shared file list shows it. Keys alone leave the facts unknown. */
export function unbundledEntry(
  item: Partial<Item> & Pick<Item, 'relative_path'>,
): FileBrowserEntry {
  const name = item.relative_path.split('/').pop() ?? item.relative_path
  const dot = name.lastIndexOf('.')
  return {
    kind: 'file',
    name,
    relative_path: item.relative_path,
    file_id: item.id ?? null,
    bundle_id: item.bundle_id ?? null,
    linked: item.id != null,
    unbundled: true,
    local_state: item.local_state ?? 'unknown',
    media_kind: item.media_kind ?? null,
    supported: PLAYABLE.has(item.media_kind ?? ''),
    extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : null,
    size_bytes: item.size_bytes ?? null,
    created_at: item.created_at ?? null,
    modified_at: item.modified_at ?? null,
    duration: null,
    mime_type: null,
    container: null,
    video_codec: null,
    video_codec_tag: null,
    audio_codec: null,
    resume_position: null,
  }
}

/** The pages a range of rows needs, and the one after it so scrolling on finds it ready. */
export function pagesFor(start: number, end: number, count: number): number[] {
  const last = Math.max(0, Math.ceil(count / UNBUNDLED_PAGE) - 1)
  const first = Math.min(Math.floor(Math.max(0, start) / UNBUNDLED_PAGE), last)
  const through = Math.min(Math.floor(Math.max(start, end) / UNBUNDLED_PAGE) + 1, last)
  return Array.from({ length: through - first + 1 }, (_, index) => first + index)
}

export interface UnbundledWindow {
  count: number
  /** Loaded rows in list order, for lookups; rows not yet fetched are absent. */
  entries: FileBrowserEntry[]
  at: (slot: number) => FileBrowserEntry | undefined
  slotOf: (path: string) => number
  /** Every fetched page is loaded and none is being read again. */
  complete: boolean
  isLoading: boolean
  isError: boolean
  error: Error | null
  refetch: () => void
}

/**
 * The Unbundled queue as a window over the whole list. The server's total sizes
 * the list; only the pages around the rows on screen are fetched, and only they
 * are refreshed, so the local stat each page costs stays bounded however long
 * the queue is. A jump far down the list fetches that page directly.
 */
export function useUnbundledWindow(
  library: string,
  query: { q: string; sort?: string; order?: string },
  range: { start: number; end: number },
): UnbundledWindow {
  const client = useQueryClient()
  const base = useMemo(() => ['catalog-unbundled', library, query] as const, [library, query])
  const identity = JSON.stringify(base)
  const [requested, setRequested] = useState({ identity, pages: [0, 1] })
  const current = requested.identity === identity ? requested.pages : [0, 1]
  const results = useQueries({
    queries: current.map((index) => ({
      queryKey: [...base, index],
      queryFn: () =>
        catalog<Page>(library, '/files/unbundled', 'POST', {
          ...query,
          offset: index * UNBUNDLED_PAGE,
          limit: UNBUNDLED_PAGE,
        }),
      refetchInterval: catalogPoll(library, 4000),
    })),
  })
  // Every page this query has read, active or not. The newest answer sizes the list,
  // so a queue that shrank or grew shows it at once, and a page still loading after
  // a jump does not collapse the list to nothing.
  const cached = client
    .getQueryCache()
    .findAll({ queryKey: base })
    .filter((entry) => entry.state.data !== undefined && typeof entry.queryKey[3] === 'number')
  const newest = [...cached].sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0]?.state
    .data as Page | undefined
  const count = newest?.total ?? 0
  const wanted = pagesFor(range.start, range.end, count)
  const wantedKey = wanted.join(',')
  const currentKey = current.join(',')
  useEffect(() => {
    // Until the first answer the list has no size to window
    if (!newest || wantedKey === currentKey) return
    // Scrolling on into the next page follows at once; a jump waits for the drag to rest
    const near = wanted.every(
      (index) =>
        current.includes(index) || current.includes(index - 1) || current.includes(index + 1),
    )
    const timer = setTimeout(() => setRequested({ identity, pages: wanted }), near ? 0 : SETTLE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys name both page lists
  }, [wantedKey, currentKey, identity, Boolean(newest)])
  // Pages outside the window keep what they last showed until they are read again
  const highest = Math.ceil(count / UNBUNDLED_PAGE)
  const pages = new Map<number, Page>()
  for (const entry of cached) {
    const index = entry.queryKey[3] as number
    if (index < highest) pages.set(index, entry.state.data as Page)
  }
  const signature = [...pages.entries()]
    .map(([index, page]) => `${index}:${page.offset}:${page.items.length}`)
    .join('|')
  // The cache is read directly, so the render must also read each active page's
  // stamp: the query results notify only on the fields a render reads.
  const dataStamp = [
    ...results.map((result) => result.dataUpdatedAt),
    ...cached.map((entry) => entry.state.dataUpdatedAt),
  ].join(',')
  const { entries, slots } = useMemo(() => {
    const entries: FileBrowserEntry[] = []
    const slots = new Map<string, number>()
    for (const [index, page] of [...pages.entries()].sort((a, b) => a[0] - b[0]))
      page.items.forEach((item, offset) => {
        const slot = index * UNBUNDLED_PAGE + offset
        if (slot >= count || slots.has(item.relative_path)) return
        slots.set(item.relative_path, slot)
        entries.push(unbundledEntry(item))
      })
    return { entries, slots }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stamps name the page data
  }, [signature, dataStamp, count])
  const bySlot = useMemo(() => {
    const map = new Map<number, FileBrowserEntry>()
    for (const entry of entries) map.set(slots.get(entry.relative_path)!, entry)
    return map
  }, [entries, slots])
  return {
    count,
    entries,
    at: (slot) => bySlot.get(slot),
    slotOf: (path) => slots.get(path) ?? -1,
    complete:
      pages.size === highest && results.every((result) => result.isSuccess && !result.isFetching),
    isLoading: !newest && results.some((result) => result.isPending),
    isError: results.some((result) => result.isError),
    error: (results.find((result) => result.error)?.error as Error | undefined) ?? null,
    refetch: () => {
      for (const result of results) void result.refetch()
    },
  }
}
