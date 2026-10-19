import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { changeBundleMember } from '../api/catalogBundleMembers'
import { setActiveLibraryId } from '../api/client'
import { useCatalogBundleMembers } from './useCatalogBundleMembers'

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
}))
vi.mock('../api/catalogBundleMembers', () => ({ changeBundleMember: vi.fn() }))

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useCatalogBundleMembers('library', 'bundle'), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}
beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('library')
  vi.mocked(catalog).mockReset().mockResolvedValue({ items: [] })
  vi.mocked(changeBundleMember).mockReset()
})

test('lost acknowledgements retain the exact operation and displayed bases after remount', async () => {
  vi.mocked(changeBundleMember).mockRejectedValue(new Error('Connection lost'))
  const first = setup()
  await act(() =>
    first.result.current.apply(
      { change: 'move', entity: 'file', before: 'peer' },
      { 'asset_bundles/bundle/$members': ['displayed'], 'asset_bundles/bundle/$alive': ['alive'] },
    ),
  )
  expect(first.result.current.pending).not.toBeNull()
  const call = vi.mocked(changeBundleMember).mock.calls[0]
  first.unmount()
  const restored = setup()
  expect(changeBundleMember).toHaveBeenCalledTimes(1)
  vi.mocked(changeBundleMember).mockResolvedValue()
  await act(() => restored.result.current.apply())
  expect(vi.mocked(changeBundleMember).mock.calls[1]).toEqual(call)
  expect(restored.result.current.pending).toBeNull()
})

test('another gesture cannot replace an operation whose response was lost', async () => {
  vi.mocked(changeBundleMember).mockRejectedValue(new Error('Connection lost'))
  const { result } = setup()
  await act(() =>
    result.current.apply({ change: 'remove', entity: 'file' }, { members: ['displayed'] }),
  )
  await act(() => result.current.apply({ change: 'expand', entity: 'other' }, { members: ['new'] }))
  expect(vi.mocked(changeBundleMember).mock.calls[1]).toEqual(
    vi.mocked(changeBundleMember).mock.calls[0],
  )
})
