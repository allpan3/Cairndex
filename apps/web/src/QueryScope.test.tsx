import { useQuery, useQueryClient } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'

import { QueryScope } from './QueryScope'

/**
 * The property that replaces "remember to clear the cache on a connection
 * switch": a request already in flight when the switch happens must not be able
 * to land in the new connection's cache. Library ids are per-server and not
 * globally unique, so such a write would look entirely plausible and be wrong.
 */

const KEY = ['libraries', 'shared-id']

function Probe({ resolver }: { resolver: () => Promise<string> }) {
  const { data } = useQuery({ queryKey: KEY, queryFn: resolver, retry: false })
  return <span data-testid="value">{data ?? 'pending'}</span>
}

/**
 * Subscribes rather than sampling. Reading `getQueryData` during render would
 * never re-render when a late response lands, so the assertion would pass
 * against a stale render even with a shared cache — verified by mutation.
 * `enabled: false` observes the entry without fetching it.
 */
function CacheReporter() {
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: () => Promise.resolve('should-not-run'),
    enabled: false,
  })
  return <span data-testid="cached">{data ?? 'empty'}</span>
}

describe('QueryScope', () => {
  it('keeps an in-flight response from the previous scope out of the new one', async () => {
    let releaseOldServer: ((value: string) => void) | undefined
    const slowOldServer = () =>
      new Promise<string>((resolve) => {
        releaseOldServer = resolve
      })

    const view = render(
      <QueryScope key="connection-a">
        <Probe resolver={slowOldServer} />
      </QueryScope>,
    )
    await screen.findByText('pending')

    // Switch connections while that request is still outstanding.
    view.rerender(
      <QueryScope key="connection-b">
        <CacheReporter />
      </QueryScope>,
    )
    expect(screen.getByTestId('cached')).toHaveTextContent('empty')

    // The old server finally answers, under a library id the new server also
    // uses. It must land nowhere the new scope can read.
    releaseOldServer?.('answer-from-the-old-server')
    await new Promise((resolve) => setTimeout(resolve, 10))

    await waitFor(() => expect(screen.getByTestId('cached')).toHaveTextContent('empty'))
  })

  it('gives each scope an independent cache', async () => {
    const view = render(
      <QueryScope key="connection-a">
        <Probe resolver={() => Promise.resolve('from-a')} />
      </QueryScope>,
    )
    await screen.findByText('from-a')

    view.rerender(
      <QueryScope key="connection-b">
        <CacheReporter />
      </QueryScope>,
    )

    expect(screen.getByTestId('cached')).toHaveTextContent('empty')
  })

  it('marks the fetching indicator active while a request is in flight', async () => {
    // The only feedback a ⌘R reload gives, so what matters is that the bar is
    // *marked* active during the request. How long it then stays visible is CSS
    // (an instant appear plus a delayed fade-out) precisely because a local
    // request can settle in fewer milliseconds than any fade would take — an
    // earlier attempt faded *in* over 80ms and was therefore never seen.
    let release: ((value: string) => void) | undefined
    render(
      <QueryScope>
        <Probe
          resolver={() =>
            new Promise<string>((resolve) => {
              release = resolve
            })
          }
        />
      </QueryScope>,
    )

    const bar = screen.getByTestId('top-progress')
    await waitFor(() => expect(bar).toHaveClass('top-progress--active'))

    release?.('done')

    // Always mounted, only re-styled: unmounting would cancel the fade-out.
    await waitFor(() => expect(bar).not.toHaveClass('top-progress--active'))
    expect(screen.getByTestId('top-progress')).toBeInTheDocument()
  })

  it('does not remake the client on an ordinary re-render', async () => {
    // Only a key change should reset the cache; a parent re-render must not
    // throw away a warm cache and refetch everything.
    const seen: unknown[] = []
    function Recorder() {
      const client = useQueryClient()
      useEffect(() => {
        seen.push(client)
      })
      return null
    }

    const view = render(
      <QueryScope key="stable">
        <Recorder />
      </QueryScope>,
    )
    view.rerender(
      <QueryScope key="stable">
        <Recorder />
      </QueryScope>,
    )

    await waitFor(() => expect(seen.length).toBeGreaterThan(1))
    expect(new Set(seen).size).toBe(1)
  })
})
