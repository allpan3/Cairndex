import { QueryClient, QueryClientProvider, useIsFetching } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

/**
 * The three queries that only run when the *whole app* is (re)loading a library:
 * the library list, the unlock check, and the ownership probe. Nothing else.
 *
 * Deliberately this narrow. Counting every query lit the bar on ordinary pointer
 * work; counting page data still lit it on every navigation, which reads as noise
 * rather than feedback. These three fire on a ⌘R reload and on switching
 * libraries — the two moments where "did that take effect?" is a real question —
 * and at no other time. A new query key lights nothing until it is listed here,
 * which is the safe default.
 */
const PAGE_LEVEL_QUERIES = new Set(['auth-status', 'libraries', 'library-ownership'])

/**
 * A thin bar at the top of the window while the page's own data is loading.
 *
 * Without it a ⌘R reload's refetch is silent, so there is no way to tell it took
 * effect. This makes "the page is refreshing" visible rather than a guess.
 *
 * A local server answers in a few milliseconds — fewer frames than the eye
 * registers — so the bar has to outlive the request that caused it. That minimum
 * is done in **CSS**, not with a timer: the element stays mounted and only its
 * opacity is toggled, appearing instantly and fading out after a delay (see
 * `.top-progress`). No timers to clear, and render stays pure.
 */
function TopProgressBar() {
  const active =
    useIsFetching({
      predicate: (query) => PAGE_LEVEL_QUERIES.has(String(query.queryKey[0])),
    }) > 0
  return (
    <div
      className={`top-progress${active ? ' top-progress--active' : ''}`}
      aria-hidden="true"
      data-testid="top-progress"
    />
  )
}

/**
 * Owns one QueryClient for one connection scope (plan 3 §7.1).
 *
 * Library ids are per-server and **not** globally unique, so a cache entry left
 * over from a previous connection can be read as belonging to the new one. That
 * is why switching connections must not merely clear the cache.
 *
 * `queryClient.clear()` is genuinely insufficient here: a query lives in the
 * cache rather than in the component observing it, so a fetch already in flight
 * when the switch happens will resolve *after* the clear and repopulate that
 * entry — with the old server's answer, under an id the new server also uses.
 *
 * Remounting this component (give it a `key` of the active connection id) makes
 * a whole new client instead. Anything still in flight resolves into the old,
 * now-unreferenced one and is collected. That turns "remember to clear the
 * cache on every switch" from a discipline into a structural property, which is
 * also what makes it testable.
 */
export function QueryScope({ children }: { children: ReactNode }) {
  // Lazily initialized so the client is created once per mount, not per render.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  )
  return (
    <QueryClientProvider client={client}>
      <TopProgressBar />
      {children}
    </QueryClientProvider>
  )
}
