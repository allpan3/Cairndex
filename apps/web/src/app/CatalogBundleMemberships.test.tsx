import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { setMembership } from '../api/catalogOrganize'
import { setActiveLibraryId } from '../api/client'
import { CatalogBundleMemberships } from './CatalogBundleMemberships'

vi.mock('../api/catalog', () => ({ catalog: vi.fn() }))
vi.mock('../api/catalogOrganize', () => ({
  rename: vi.fn(),
  setBulkMembership: vi.fn(),
  setMembership: vi.fn(),
}))
const status = vi.hoisted(() => ({ selection_version: 2 }))
vi.mock('../api/useReplicaStatus', () => ({
  useReplicaStatus: () => ({ data: status }),
}))

const tag = (name: string) => ({
  id: `tag-${name}`,
  name,
  path: [name],
  assigned: true,
  held: false,
  observed: {},
})
beforeEach(() => {
  status.selection_version = 2
  setActiveLibraryId('library')
  vi.mocked(setMembership).mockReset()
  vi.mocked(catalog)
    .mockReset()
    .mockResolvedValue({ items: [tag('Amber'), tag('Blue')], next_cursor: null } as never)
})

test('an open tag menu enables its actions once the pending tag change settles', async () => {
  let acknowledge = () => {}
  vi.mocked(setMembership).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve
      }),
  )
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogBundleMemberships
        library="library"
        ids={['bundle']}
        family="tags"
        blocked={false}
        onReview={vi.fn()}
        onFilterTag={vi.fn()}
      />
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Remove Blue' }))
  expect(setMembership).toHaveBeenCalledTimes(1)
  // Opened while the removal awaits its acknowledgement, so tag changes wait
  fireEvent.click(screen.getByRole('button', { name: 'Tag actions Amber' }))
  const rename = () => screen.getByRole('menuitem', { name: 'Rename Tag…' })
  expect(rename()).toBeDisabled()
  await act(async () => acknowledge())
  // The same open menu becomes usable without reopening it
  await waitFor(() => expect(rename()).toBeEnabled())
  fireEvent.click(rename())
  expect(await screen.findByLabelText('Tag name')).toHaveValue('Amber')
})

const shared = (name: string, count: number) => ({
  id: `tag-${name}`,
  name,
  assigned_count: count,
  held: false,
  observed: {},
})
function selectionChips() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogBundleMemberships
        library="library"
        ids={['one', 'two']}
        family="tags"
        blocked={false}
        onReview={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

// A selection's chips are what every selected bundle has, as in v0.2.1
test('selection chips read only the tags every selected bundle shares', async () => {
  status.selection_version = 4
  vi.mocked(catalog).mockResolvedValue({ items: [shared('Amber', 2)], next_cursor: null } as never)
  selectionChips()
  expect(await screen.findByRole('button', { name: 'Remove Amber' })).toBeInTheDocument()
  expect(vi.mocked(catalog).mock.calls[0]![3]).toMatchObject({ ids: ['one', 'two'], common: true })
  expect(vi.mocked(catalog).mock.calls[0]![3]).not.toHaveProperty('assigned')
})

test('an older server lists any assigned tag, so the chips keep only the shared ones', async () => {
  status.selection_version = 3
  vi.mocked(catalog).mockResolvedValue({
    items: [shared('Amber', 2), shared('Blue', 1)],
    next_cursor: null,
  } as never)
  selectionChips()
  expect(await screen.findByRole('button', { name: 'Remove Amber' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove Blue' })).not.toBeInTheDocument()
  expect(vi.mocked(catalog).mock.calls[0]![3]).toMatchObject({ assigned: true })
})
