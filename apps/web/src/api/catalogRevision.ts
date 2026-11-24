import { useEffect, useRef } from 'react'
import { useQueryClient, type Query } from '@tanstack/react-query'

// Libraries whose server reports a private-metadata revision in its status. Their
// catalog reads refetch when that revision changes instead of each polling on a timer:
// an idle browser then sends one status request a second rather than dozens, and the
// sidecar stops re-running browse, navigation and inspector queries for nothing.
const revisioned = new Set<string>()

// A burst of background commits (Update, cover preparation) refetches at most this often
const MIN_REFRESH_MS = 1500

/**
 * `refetchInterval` for a catalog read: `ms` against a server without revisions, and
 * no timer once {@link useCatalogRevision} has seen one for `library`. TanStack calls
 * it before each scheduled refetch, so a query mounted first stops polling later.
 */
export function catalogPoll(library: string | null | undefined, ms: number) {
  return () => (library && revisioned.has(library) ? false : ms)
}

// Every catalog read is keyed `['catalog-…', library, …]`; status drives this hook
function isCatalogRead(query: Query, library: string): boolean {
  const [family, owner] = query.queryKey
  return (
    typeof family === 'string' &&
    family.startsWith('catalog-') &&
    family !== 'catalog-status' &&
    owner === library
  )
}

function isAppending(query: Query): boolean {
  return query.state.fetchStatus === 'fetching' && Boolean(query.state.fetchMeta?.fetchMore)
}

/**
 * Refetch `library`'s catalog reads whenever its status reports a new revision.
 * Mounted once, where the workspace polls status.
 */
export function useCatalogRevision(library: string, revision: string | null | undefined) {
  const client = useQueryClient()
  const seen = useRef<string | null>(null)
  const last = useRef(0)
  const pending = useRef<number | null>(null)
  // A revision arrived since the last refresh, so every catalog read is stale
  const owed = useRef(false)
  // Reads that were appending a page at the last refresh; they refetch once it settles
  const deferred = useRef(new Set<string>())

  useEffect(() => {
    if (!revision) return
    revisioned.add(library)
    if (seen.current === null || seen.current === revision) {
      seen.current = revision
      return
    }
    seen.current = revision
    owed.current = true
    if (pending.current !== null) return
    // Invalidation cancels a fetch in flight, which for a query appending its next page
    // would drop the page the user asked for. Such a query refreshes once the append
    // settles instead.
    const refresh = () => {
      pending.current = null
      last.current = Date.now()
      const all = owed.current
      const retry = deferred.current
      owed.current = false
      deferred.current = new Set()
      void client.invalidateQueries({
        predicate: (query) => {
          if (!(all ? isCatalogRead(query, library) : retry.has(query.queryHash))) return false
          if (isAppending(query)) {
            deferred.current.add(query.queryHash)
            return false
          }
          // A failed append (an album page rejected as changed) keeps its error, which
          // already asks the user to reload
          return all || query.state.status === 'success'
        },
      })
      if (deferred.current.size > 0) pending.current = window.setTimeout(refresh, MIN_REFRESH_MS)
    }
    const wait = last.current + MIN_REFRESH_MS - Date.now()
    if (wait <= 0) refresh()
    else pending.current = window.setTimeout(refresh, wait)
  }, [client, library, revision])

  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current)
      pending.current = null
      revisioned.delete(library)
      seen.current = null
      owed.current = false
      deferred.current = new Set()
    },
    [library],
  )
}
