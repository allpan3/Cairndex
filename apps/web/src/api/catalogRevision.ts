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

/**
 * Refetch `library`'s catalog reads whenever its status reports a new revision.
 * Mounted once, where the workspace polls status.
 */
export function useCatalogRevision(library: string, revision: string | null | undefined) {
  const client = useQueryClient()
  const seen = useRef<string | null>(null)
  const last = useRef(0)
  const pending = useRef<number | null>(null)

  useEffect(() => {
    if (!revision) return
    revisioned.add(library)
    if (seen.current === null || seen.current === revision) {
      seen.current = revision
      return
    }
    seen.current = revision
    if (pending.current !== null) return
    const refresh = () => {
      pending.current = null
      last.current = Date.now()
      void client.invalidateQueries({ predicate: (query) => isCatalogRead(query, library) })
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
    },
    [library],
  )
}
