import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { setBulkMembership, setMembership } from '../api/catalogOrganize'
import { setActiveLibraryId } from '../api/client'
import { CatalogBundleMemberships } from './CatalogBundleMemberships'

vi.mock('../api/catalog', () => ({ catalog: vi.fn() }))
vi.mock('../api/catalogOrganize', () => ({
  rename: vi.fn(),
  setBulkMembership: vi.fn(),
  setMembership: vi.fn(),
}))
vi.mock('../api/useReplicaStatus', () => ({
  useReplicaStatus: () => ({ data: { selection_version: 4 } }),
}))
// The tree reads the library's tags, groups and counts through the shared hooks
const tag = (id: string, name: string, parent: string | null = null) => ({
  id,
  name,
  parent_id: parent,
  sort_order: 0,
  version: 1,
})
vi.mock('../api/hooks', () => ({
  useTags: () => ({
    data: [
      tag('tag-place', 'Synthetic place'),
      tag('tag-harbor', 'Synthetic harbor', 'tag-place'),
      tag('tag-mood', 'Synthetic mood'),
    ],
  }),
  useTagCounts: () => ({ data: { 'tag-place': 3, 'tag-harbor': 2, 'tag-mood': 1 } }),
  useTagGroups: () => ({ data: [] }),
  useTagGroupMemberships: () => ({ data: {} }),
  useCreateTagPath: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useCollections: () => ({
    data: [
      { ...tag('col-trips', 'Synthetic trips'), created_at: '' },
      { ...tag('col-coast', 'Synthetic coast', 'col-trips'), created_at: '' },
    ],
  }),
  useCreateCollection: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

const choice = (id: string, name: string, count: number) => ({
  id,
  name,
  assigned_count: count,
  held: false,
  observed: { [`tags/${id}/$alive`]: [`event-${id}`] },
})
beforeEach(() => {
  setActiveLibraryId('library')
  vi.mocked(setMembership).mockReset().mockResolvedValue()
  vi.mocked(setBulkMembership).mockReset().mockResolvedValue()
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation((_library, path, _method, body) => {
      const read = body as { target?: string; common?: boolean; assigned?: boolean } | undefined
      if (path.includes('/memberships/'))
        return Promise.resolve({ items: [], next_cursor: null }) as never
      if (read?.target)
        return Promise.resolve({
          items: [choice(read.target, read.target, 0)],
          next_cursor: null,
        }) as never
      // The chips read shared tags; the tree's dash reads any assigned tag
      return Promise.resolve({
        items: read?.common
          ? [choice('tag-mood', 'Synthetic mood', 2)]
          : [choice('tag-mood', 'Synthetic mood', 2), choice('tag-place', 'Synthetic place', 1)],
        next_cursor: null,
      }) as never
    })
})
function setup(ids: string[], family: 'tags' | 'collections' = 'tags') {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogBundleMemberships
        library="library"
        ids={ids}
        family={family}
        blocked={false}
        onReview={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

// v0.2.1's picker: a foldable tree with counts, not a flat list of names
test('the tag picker shows the tag tree and saves a picked child tag', async () => {
  setup(['one'])
  fireEvent.click(screen.getByRole('button', { name: '+ Tag' }))
  const picker = await screen.findByRole('dialog', { name: 'Choose tags' })
  const harbor = within(picker).getByRole('button', { name: /Synthetic harbor/ })
  expect(harbor.querySelectorAll('.pick-guide')).toHaveLength(1)
  fireEvent.click(within(picker).getByRole('button', { name: 'Collapse' }))
  expect(within(picker).queryByRole('button', { name: /Synthetic harbor/ })).toBeNull()
  fireEvent.click(within(picker).getByRole('button', { name: 'Expand' }))
  fireEvent.click(within(picker).getByRole('button', { name: /Synthetic harbor/ }))
  await waitFor(() => expect(setMembership).toHaveBeenCalledOnce())
  const [, bundle, family, read, assign] = vi.mocked(setMembership).mock.calls[0]!
  expect([bundle, family, read.id, read.observed, assign]).toEqual([
    'one',
    'tags',
    'tag-harbor',
    { 'tags/tag-harbor/$alive': ['event-tag-harbor'] },
    true,
  ])
})

test('a selection marks the tags only some bundles have', async () => {
  setup(['one', 'two'])
  fireEvent.click(await screen.findByRole('button', { name: '+ Tag' }))
  const picker = await screen.findByRole('dialog', { name: 'Choose tags' })
  await waitFor(() =>
    expect(within(picker).getAllByRole('button', { name: /Synthetic place/ })[0]).toHaveAttribute(
      'aria-pressed',
      'mixed',
    ),
  )
  expect(within(picker).getAllByRole('button', { name: /Synthetic mood/ })[0]).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  fireEvent.click(within(picker).getAllByRole('button', { name: /Synthetic place/ })[0]!)
  await waitFor(() => expect(setBulkMembership).toHaveBeenCalledOnce())
  expect(vi.mocked(setBulkMembership).mock.calls[0]![4]).toBe(true)
})

test('the collection picker shows the collection tree and saves a picked child', async () => {
  setup(['one'], 'collections')
  fireEvent.click(screen.getByRole('button', { name: '+ Collection' }))
  const picker = await screen.findByRole('dialog', { name: 'Choose collections' })
  const coast = within(picker).getByRole('button', { name: /Synthetic coast/ })
  expect(coast.querySelectorAll('.pick-guide')).toHaveLength(1)
  fireEvent.click(within(picker).getByRole('button', { name: 'Collapse' }))
  expect(within(picker).queryByRole('button', { name: /Synthetic coast/ })).toBeNull()
  fireEvent.click(within(picker).getByRole('button', { name: 'Expand' }))
  fireEvent.click(within(picker).getByRole('button', { name: /Synthetic coast/ }))
  await waitFor(() => expect(setMembership).toHaveBeenCalledOnce())
  const [, bundle, family, read, assign] = vi.mocked(setMembership).mock.calls[0]!
  expect([bundle, family, read.id, assign]).toEqual(['one', 'collections', 'col-coast', true])
})
