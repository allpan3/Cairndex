import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { changeBundleMember } from '../api/catalogBundleMembers'
import { commit } from '../api/catalogOrganize'
import { setActiveLibraryId } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { CatalogBundleFiles } from './CatalogBundleFiles'

vi.mock('../api/replicas', async (original) => ({
  ...(await original<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
}))
vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
}))
vi.mock('../api/catalogOrganize', () => ({ commit: vi.fn(), rename: vi.fn() }))
vi.mock('../api/catalogBundleMembers', () => ({ changeBundleMember: vi.fn() }))
vi.mock('../api/hooks', () => ({
  useTags: () => ({ data: [] }),
  useTagCounts: () => ({ data: {} }),
  useTagGroups: () => ({ data: [] }),
  useTagGroupMemberships: () => ({ data: {} }),
  useCreateTagPath: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

let members = 'displayed'
let inspectorVersion = 2
let starredIds = new Set<string>()
let selectionHeld = false

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
        starred: starredIds.has(`loose-${name}`),
      },
    })),
  }
}

function respond(_library: string, path: string) {
  if (path === '/status')
    return Promise.resolve({ browse_version: 18, inspector_version: inspectorVersion })
  if (path.startsWith('/catalog/drafts')) return Promise.resolve({ items: [] })
  if (path.startsWith('/media/files/')) {
    const id = path.split('/').at(-1)!
    return Promise.resolve({
      state: 'available',
      generation: 'g1',
      message: null,
      file: {
        id,
        bundle_id: 'bundle',
        relative_path: `Loose/${id}.png`,
        display_title: `${id}.png`,
        original_filename: `${id}.png`,
        media_kind: 'image',
        mime_type: 'image/png',
        size_bytes: 5,
        availability: 'available',
        supported: true,
        starred: starredIds.has(id),
        tech_metadata: { width: 64, height: 64 },
      },
    })
  }
  return Promise.resolve(album())
}

beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('library')
  members = 'displayed'
  inspectorVersion = 2
  starredIds = new Set()
  selectionHeld = false
  vi.mocked(changeBundleMember).mockReset()
  vi.mocked(commit).mockReset().mockResolvedValue()
  vi.mocked(replicaRequest)
    .mockReset()
    .mockImplementation(respond as never)
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation(async (_library, path, _method, body) => {
      if (path === '/files/selection') {
        const ids = (body as { ids: string[] }).ids
        return {
          items: ids.map((id) => ({
            id,
            starred: starredIds.has(id),
            held: selectionHeld,
            observed: { [`asset_file_stars/${id}/$alive`]: [`rev-${id}`] },
          })),
        } as never
      }
      if (path === '/catalog/drafts') return { items: [] } as never
      if (path.endsWith('/star')) {
        const id = path.split('/')[2]!
        return {
          file_id: id,
          starred: starredIds.has(id),
          held: false,
          observed: { [`asset_file_stars/${id}/$alive`]: [`rev-${id}`] },
        } as never
      }
      if (path.includes('/tags')) return { items: [], next_cursor: null } as never
      if (path.startsWith('/entities/asset_files/')) {
        const id = path.split('/').at(-1)!
        return {
          family: 'asset_files',
          id,
          fields: {
            $alive: { unit: `asset_files/${id}/$alive`, value: 'true', basis: ['r1'], held: false },
            note: { unit: `asset_files/${id}/note`, value: 'null', basis: ['r1'], held: false },
            source: { unit: `asset_files/${id}/source`, value: 'null', basis: ['r1'], held: false },
          },
          observed: {},
          parents: ['r1'],
          has_conflicts: false,
        } as never
      }
      return { items: [] } as never
    })
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

test('row star button is gated on inspector_version >= 2 and cover uses SVG icon instead of ★', async () => {
  inspectorVersion = 1
  const v1 = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogBundleFiles
        library="library"
        bundle="bundle"
        cover={null}
        blocked={false}
        onCover={vi.fn()}
        onOpen={vi.fn()}
      />
    </QueryClientProvider>,
  )
  const coverBtn = await screen.findByRole('button', { name: 'Set Loose/frame000.png as cover' })
  expect(coverBtn.textContent).toBe('')
  expect(coverBtn.querySelector('svg')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Star Loose/frame000.png' })).not.toBeInTheDocument()
  v1.unmount()

  inspectorVersion = 2
  const onReviewConflict = vi.fn()
  const onFilterTag = vi.fn()
  const onSelectHostFile = vi.fn()
  let finishStarCommit!: () => void
  vi.mocked(commit).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishStarCommit = resolve
      }),
  )
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogBundleFiles
        library="library"
        bundle="bundle"
        cover={null}
        blocked={false}
        editor="editor-1"
        onCover={vi.fn()}
        onOpen={vi.fn()}
        onReviewConflict={onReviewConflict}
        onFilterTag={onFilterTag}
        onSelectHostFile={onSelectHostFile}
      />
    </QueryClientProvider>,
  )

  const starBtn = await screen.findByRole('button', { name: 'Star Loose/frame000.png' })
  fireEvent.click(starBtn)
  // Optimistic update flips aria-pressed and label immediately without waiting for backend commit
  expect(screen.getByRole('button', { name: 'Unstar Loose/frame000.png' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(screen.getByRole('button', { name: 'Unstar Loose/frame000.png' })).toBeEnabled()
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  expect(commit).toHaveBeenCalledWith('library', {
    action: 'file_stars',
    ids: ['loose-000'],
    starred: true,
    observed: { 'asset_file_stars/loose-000/$alive': ['rev-loose-000'] },
  })
  starredIds.add('loose-000')
  await act(async () => finishStarCommit())

  // Held conflict rolls back optimistic flip and surfaces Review Conflict
  selectionHeld = true
  fireEvent.click(screen.getByRole('button', { name: 'Star Loose/frame001.png' }))
  const reviewBtn = await screen.findByRole('button', { name: 'Review Conflict' })
  expect(screen.getByRole('button', { name: 'Star Loose/frame001.png' })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  fireEvent.click(reviewBtn)
  expect(onReviewConflict).toHaveBeenCalledWith('asset_file_stars/loose-001/$alive')

  // Clicking a file row selects it for host actions without appending file metadata at the bottom
  const rowBtn = screen.getByRole('button', { name: /^frame000\.png/ })
  fireEvent.click(rowBtn)
  expect(rowBtn).toHaveAttribute('aria-pressed', 'true')
  expect(onSelectHostFile).toHaveBeenCalledWith('loose-000')
  expect(screen.queryByRole('region', { name: 'Local file details' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'File note' })).not.toBeInTheDocument()
})
