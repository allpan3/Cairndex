import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { discovery } from '../../api/discovery'
import type { ReplicaDiscoveryState } from '../useReplicaDiscovery'
import { useFileChangeEntry } from './useFileChangeEntry'

vi.mock('../../api/discovery', () => ({ discovery: vi.fn() }))

const repair = { id: 'synthetic-repair', path: '', body: { kind: 'repair', title: 'Moved' } }
const review = { id: 'synthetic-review', state: 'ready' }

// `pending` stands for the unfiltered first page: here it holds only this
// Update's ordinary grouping proposals, whatever the filtered list holds.
function entry(changes: unknown[], reviews: unknown[], pending = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const paths: string[] = []
  vi.mocked(discovery).mockImplementation(async (_library, path) => {
    paths.push(path)
    return { items: changes, next_cursor: null }
  })
  const d = {
    pending,
    reviews: { data: { items: reviews, next_cursor: null } },
  } as unknown as Pick<ReplicaDiscoveryState, 'pending' | 'reviews'>
  const rendered = renderHook(() => useFileChangeEntry('synthetic', d), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  return { ...rendered, paths, client }
}

it('offers file changes only when the filtered list or saved reviews have some', async () => {
  const cases = [
    // Ordinary new grouping alone is the tree's own work
    { changes: [], reviews: [], label: 'Earlier grouping choices…', earlier: true },
    // A repair beyond the unfiltered first page still names the entry
    { changes: [repair], reviews: [], label: 'File changes…', earlier: false },
    { changes: [], reviews: [review], label: 'Saved reviews…', earlier: false },
    {
      changes: [repair],
      reviews: [review],
      label: 'File changes and saved reviews…',
      earlier: false,
    },
  ]
  for (const { changes, reviews, label, earlier } of cases) {
    const { result, paths, client, unmount } = entry(changes, reviews)
    await waitFor(() => expect(result.current).toEqual({ label, earlier }))
    expect(paths).toEqual(['/candidates?file_changes=true&limit=1'])
    unmount()
    client.clear()
  }
  // Nothing waits beside the tree, so nothing is offered once the answer is in
  const { result, client, unmount } = entry([], [], false)
  await waitFor(() =>
    expect(client.getQueryData(['discovery-file-changes', 'synthetic', 'any'])).toBeDefined(),
  )
  expect(result.current).toBeNull()
  unmount()
  client.clear()
  vi.resetAllMocks()
})
