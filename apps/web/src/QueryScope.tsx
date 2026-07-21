import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'

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
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
