import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { changeBundleMember } from '../api/catalogBundleMembers'
import { setActiveLibraryId } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { CatalogBundleFiles } from './CatalogBundleFiles'

vi.mock('../api/replicas', async (original) => ({
  ...(await original<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
}))
vi.mock('../api/catalogBundleMembers', () => ({ changeBundleMember: vi.fn() }))

let members = 'displayed'
function album() {
  const names = members === 'displayed' ? ['000', '001'] : ['001', '000']
  return {
    title: 'Synthetic bundle',
    directory_path: null,
    editable: true,
    total: 2,
    next_offset: null,
    revision: `synthetic-${members}`,
    observed: { 'asset_bundles/bundle/$members': [members] },
    items: names.map((name) => ({
      id: `loose-${name}`,
      kind: 'file',
      directory: null,
      file: {
        id: `loose-${name}`,
        relative_path: `Loose/frame${name}.png`,
        display_title: `frame${name}.png`,
        original_filename: `frame${name}.png`,
        media_kind: 'image',
        role: 'image',
        size_bytes: 5,
        availability: 'present',
      },
    })),
  }
}
function respond(_library: string, path: string) {
  if (path === '/status') return Promise.resolve({ browse_version: 16 })
  if (path.startsWith('/catalog/drafts')) return Promise.resolve({ items: [] })
  return Promise.resolve(album())
}
beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('library')
  members = 'displayed'
  vi.mocked(changeBundleMember).mockReset()
  vi.mocked(replicaRequest)
    .mockReset()
    .mockImplementation(respond as never)
})

test('an open file menu enables its actions once the pending save is acknowledged', async () => {
  let acknowledge = () => {}
  vi.mocked(changeBundleMember)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve
        }),
    )
    .mockResolvedValue()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={client}>
      <CatalogBundleFiles
        library="library"
        bundle="bundle"
        cover={null}
        blocked={false}
        onCover={vi.fn()}
        onOpen={vi.fn()}
        onLocateFile={vi.fn()}
      />
    </QueryClientProvider>,
  )
  await screen.findByRole('button', { name: 'Reorder Loose/frame001.png' })
  fireEvent.keyDown(container.querySelector('[data-member-id="loose-001"]')!, {
    key: 'ArrowUp',
    altKey: true,
  })
  expect(changeBundleMember).toHaveBeenCalledTimes(1)
  // Opened while the move awaits its acknowledgement, so file changes are held
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Loose/frame000.png' }))
  const collapse = () => screen.getByRole('menuitem', { name: 'Collapse “Loose” into One Row' })
  expect(collapse()).toBeDisabled()
  fireEvent.click(collapse())
  expect(changeBundleMember).toHaveBeenCalledTimes(1)
  members = 'acknowledged'
  await act(async () => acknowledge())
  // The same open menu becomes usable against the arrangement the refresh now shows
  await waitFor(() => expect(collapse()).toBeEnabled())
  expect(screen.getByRole('button', { name: 'Reorder Loose/frame000.png' })).toBeEnabled()
  fireEvent.click(collapse())
  await waitFor(() => expect(changeBundleMember).toHaveBeenCalledTimes(2))
  expect(vi.mocked(changeBundleMember).mock.calls[1]!.slice(0, 4)).toEqual([
    'library',
    'bundle',
    { 'asset_bundles/bundle/$members': ['acknowledged'] },
    { change: 'collapse', entity: 'loose-000', directory: 'Loose' },
  ])
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Reorder Loose/frame000.png' })).toBeEnabled(),
  )
})
