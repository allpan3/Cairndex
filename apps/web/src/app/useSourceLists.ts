import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  sourceRequest,
  type ReceiptPage,
  type SourceJob,
  type SourcePage,
} from '../api/sourceOperations'
import { trashRows } from './sourceActions'
import { isCollision, type SourceTasks } from './useSourceTasks'

/** An occupied name is a refused edit, not an interrupted file mutation. */
export const rejectedName = (job: SourceJob) =>
  ['mkdir', 'rename', 'relocate'].includes(job.action) &&
  job.state === 'interrupted' &&
  !job.result?.started &&
  isCollision(job)

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
 * window, including occupied names and prepared but unapplied items. They come
 * from a reload, another window or an earlier version's review panel. Only
 * the newest page is read; older ones stay listed by the server.
 */
export function useUnfinishedOperations(library: string, enabled: boolean, tasks: SourceTasks) {
  const page = useQuery({
    queryKey: ['source-operations', library, 0],
    queryFn: () => sourceRequest<SourcePage>(library, '?after=0'),
    enabled,
    refetchInterval: 2000,
  })
  const own = new Set(
    tasks.tasks.flatMap((task) => task.items.map((item) => item.request.operation)),
  )
  return (page.data?.items ?? []).filter(
    (job: SourceJob) =>
      !own.has(job.id) &&
      !rejectedName(job) &&
      (job.state === 'prepared' || job.state === 'interrupted'),
  )
}
