import { useInfiniteQuery } from '@tanstack/react-query'
import { sourceRequest, type ReceiptPage, type SourcePage } from '../api/sourceOperations'
import { trashRows } from './sourceActions'
import type { SourceTasks } from './useSourceTasks'

/**
 * The library's Trash, newest first. The open Trash view polls for other
 * windows' changes; elsewhere a finished task refreshes it.
 */
export function useTrash(library: string, enabled: boolean, open: boolean) {
  const receipts = useInfiniteQuery({
    queryKey: ['source-receipts', library],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      sourceRequest<ReceiptPage>(library, `/receipts?after=${encodeURIComponent(pageParam)}`),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
    refetchInterval: open ? 3000 : false,
  })
  return { receipts, rows: trashRows(receipts.data?.pages ?? []) }
}

/**
 * Saved operations that wait for the owner and belong to no task in this
 * window, such as a copy stopped on an occupied name or a prepared but
 * unapplied item, left by a reload, another window or an earlier version.
 * The server lists only these, newest first, so newer finished work never
 * hides an older one; `more` loads the next page.
 */
export function useUnfinishedOperations(library: string, enabled: boolean, tasks: SourceTasks) {
  const pages = useInfiniteQuery({
    queryKey: ['source-operations', library, 'waiting'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      sourceRequest<SourcePage>(library, `?waiting=true&after=${pageParam}`),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled,
    refetchInterval: 2000,
  })
  const own = new Set(
    tasks.tasks.flatMap((task) => task.items.map((item) => item.request.operation)),
  )
  return {
    operations: (pages.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((job) => !own.has(job.id)),
    more: pages.hasNextPage
      ? { load: () => void pages.fetchNextPage(), loading: pages.isFetchingNextPage }
      : null,
  }
}
