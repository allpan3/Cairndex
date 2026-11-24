import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogPoll, useCatalogRevision } from './catalogRevision'

function setup() {
  const client = new QueryClient()
  const invalidated: unknown[][] = []
  const refreshes = vi.spyOn(client, 'invalidateQueries')
  for (const key of [
    ['catalog-browse', 'lib-a', 'q'],
    ['catalog-detail', 'lib-a', 'asset_bundles', 'b1'],
    ['catalog-status', 'lib-a'],
    ['catalog-browse', 'lib-b', 'q'],
    ['libraries'],
  ])
    client.setQueryData(key, 1)
  client.getQueryCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'invalidate')
      invalidated.push([...event.query.queryKey])
  })
  const view = renderHook(({ revision }) => useCatalogRevision('lib-a', revision), {
    initialProps: { revision: undefined as string | undefined },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  return { client, invalidated, refreshes, view }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useCatalogRevision', () => {
  it('stops catalog timers once the server reports a revision', () => {
    const poll = catalogPoll('lib-a', 2000)
    const { view } = setup()
    expect(poll()).toBe(2000)
    view.rerender({ revision: 'h.1' })
    expect(poll()).toBe(false)
    expect(catalogPoll('lib-b', 2000)()).toBe(2000)
    view.unmount()
    expect(poll()).toBe(2000)
  })

  it("refetches only this library's catalog reads, and only when the revision moves", () => {
    const { invalidated, view } = setup()
    view.rerender({ revision: 'h.1' })
    view.rerender({ revision: 'h.1' })
    expect(invalidated).toEqual([])
    view.rerender({ revision: 'h.2' })
    expect(invalidated).toEqual([
      ['catalog-browse', 'lib-a', 'q'],
      ['catalog-detail', 'lib-a', 'asset_bundles', 'b1'],
    ])
  })

  it('coalesces a burst of revisions into one trailing refetch', () => {
    vi.useFakeTimers()
    const { refreshes, view } = setup()
    view.rerender({ revision: 'h.1' })
    view.rerender({ revision: 'h.2' })
    expect(refreshes).toHaveBeenCalledTimes(1)
    view.rerender({ revision: 'h.3' })
    view.rerender({ revision: 'h.4' })
    expect(refreshes).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1500)
    expect(refreshes).toHaveBeenCalledTimes(2)
  })

  it('lets a page being appended finish, then refreshes it unless the append failed', () => {
    vi.useFakeTimers()
    const { client, invalidated, view } = setup()
    const browse = client.getQueryCache().find({ queryKey: ['catalog-browse', 'lib-a', 'q'] })!
    const appending = {
      fetchStatus: 'fetching',
      fetchMeta: { fetchMore: { direction: 'forward' } },
    } as const
    browse.setState(appending)
    view.rerender({ revision: 'h.1' })
    view.rerender({ revision: 'h.2' })
    expect(invalidated).toEqual([['catalog-detail', 'lib-a', 'asset_bundles', 'b1']])
    vi.advanceTimersByTime(1500)
    expect(invalidated).toHaveLength(1)
    browse.setState({ fetchStatus: 'idle', fetchMeta: null })
    vi.advanceTimersByTime(1500)
    expect(invalidated.at(-1)).toEqual(['catalog-browse', 'lib-a', 'q'])

    invalidated.length = 0
    for (const query of client.getQueryCache().getAll()) query.setState({ isInvalidated: false })
    browse.setState(appending)
    view.rerender({ revision: 'h.3' })
    vi.advanceTimersByTime(1500)
    browse.setState({ fetchStatus: 'idle', fetchMeta: null, status: 'error' })
    vi.advanceTimersByTime(3000)
    expect(invalidated).toEqual([['catalog-detail', 'lib-a', 'asset_bundles', 'b1']])
  })
})
