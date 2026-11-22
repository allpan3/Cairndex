import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { CatalogQueryContext } from '../api/catalogQuery'
import { commit } from '../api/catalogOrganize'
import { setActiveLibraryId } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { CatalogBundleAlbum } from './CatalogBundleAlbum'

const fixture = vi.hoisted(() => ({
  albumVersion: 2,
  inspectorVersion: 2,
  browseVersion: 18,
  selectionHeld: false,
  tagNames: { 'tag-a': 'Amber', 'tag-b': 'Cobalt' } as Record<string, string>,
  items: [] as Array<{ id: string; title: string; starred: boolean; tags?: string[] }>,
}))

vi.mock('../api/replicas', async (original) => ({
  ...(await original<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
}))
vi.mock('../api/useReplicaStatus', () => ({
  useReplicaStatus: () => ({
    data: {
      album_version: fixture.albumVersion,
      inspector_version: fixture.inspectorVersion,
      browse_version: fixture.browseVersion,
    },
  }),
}))
vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
}))
vi.mock('../api/catalogOrganize', () => ({ commit: vi.fn() }))
vi.mock('./AlbumItems', () => ({
  AlbumItems: ({
    items,
    render,
  }: {
    items: { id: string }[]
    render: (item: { id: string }) => React.ReactNode
  }) => items.map((item) => <div key={item.id}>{render(item)}</div>),
}))

const defaultItems = [
  { id: 'f1', title: 'shot01.png', starred: false, tags: ['tag-a'] },
  { id: 'f2', title: 'shot02.png', starred: true, tags: ['tag-b'] },
]

beforeEach(() => {
  setActiveLibraryId('library')
  fixture.albumVersion = 2
  fixture.inspectorVersion = 2
  fixture.browseVersion = 18
  fixture.selectionHeld = false
  fixture.items = [...defaultItems]
  fixture.tagNames = { 'tag-a': 'Amber', 'tag-b': 'Cobalt' }
  vi.mocked(commit).mockReset().mockResolvedValue()
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation(async (_library, path, _method, body) => {
      if (path === '/files/selection') {
        const ids = (body as { ids: string[] }).ids
        return {
          items: ids.map((id) => ({
            id,
            starred: Boolean(fixture.items.find((item) => item.id === id)?.starred),
            held: fixture.selectionHeld,
            observed: { [`asset_file_stars/${id}/$alive`]: [`rev-${id}`] },
          })),
        } as never
      }
      return { items: [] } as never
    })
  vi.mocked(replicaRequest)
    .mockReset()
    .mockImplementation((_library, path) => {
      if (path.endsWith('/opened')) return Promise.resolve({} as never)
      const url = new URL(path, 'http://synthetic.invalid')
      const starredOnly = url.searchParams.get('starred_only') === 'true'
      const tagIds = url.searchParams.getAll('tag_ids')
      const mode = url.searchParams.get('tag_mode') ?? 'any'
      const visible = fixture.items.filter((item) => {
        if (starredOnly && !item.starred) return false
        if (tagIds.length > 0) {
          const itemTags = item.tags ?? []
          const match =
            mode === 'all'
              ? tagIds.every((id) => itemTags.includes(id))
              : tagIds.some((id) => itemTags.includes(id))
          if (!match) return false
        }
        return true
      })
      return Promise.resolve({
        title: 'Synthetic bundle',
        directory_path: null,
        editable: true,
        total: visible.length,
        next_offset: null,
        revision: 'syn-rev',
        observed: {},
        tag_names: fixture.tagNames,
        items: visible.map((item) => ({
          id: item.id,
          kind: 'file',
          directory: null,
          file: {
            id: item.id,
            bundle_id: 'bundle-1',
            relative_path: `Folder/${item.title}`,
            display_title: item.title,
            original_filename: item.title,
            media_kind: 'image',
            role: 'image',
            size_bytes: 10,
            availability: 'present',
            starred: item.starred,
            tag_ids: item.tags ?? [],
          },
        })),
      } as never)
    })
})

function setup({
  layout = 'grid' as const,
  onSelectFile = vi.fn(),
  onOpen = vi.fn(),
  onReviewConflict = vi.fn(),
}: {
  layout?: 'grid' | 'list'
  onSelectFile?: (file: string | null) => void
  onOpen?: (file: string) => void
  onReviewConflict?: (unit: string) => void
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <CatalogBundleAlbum
        library="library"
        bundle="bundle-1"
        layout={layout}
        zoom={100}
        onBack={vi.fn()}
        onOpen={onOpen}
        onSelectFile={onSelectFile}
        onReviewConflict={onReviewConflict}
      />
    </QueryClientProvider>,
  )
  return { ...view, onSelectFile, onOpen, onReviewConflict }
}

test('in-album Starred and Tags filter bar is gated on album_version >= 2 and queries album params', async () => {
  fixture.albumVersion = 1
  const v1 = setup()
  await screen.findByText('shot01.png')
  expect(
    screen.queryByRole('button', { name: 'Filter bundle by starred files' }),
  ).not.toBeInTheDocument()
  v1.unmount()

  fixture.albumVersion = 2
  setup()
  await screen.findByText('shot01.png')
  const firstAlbumCall = vi
    .mocked(replicaRequest)
    .mock.calls.find((call) => call[1].includes('/album?'))?.[1]
  expect(firstAlbumCall).not.toContain('starred_only')
  expect(firstAlbumCall).not.toContain('tag_ids')

  // Toggle Starred filter
  fireEvent.click(screen.getByRole('button', { name: 'Filter bundle by starred files' }))
  expect(await screen.findByText('shot02.png')).toBeInTheDocument()
  expect(screen.queryByText('shot01.png')).not.toBeInTheDocument()
  expect(
    vi.mocked(replicaRequest).mock.calls.some((call) => call[1].includes('starred_only=true')),
  ).toBe(true)

  // Combine with Tags filter (All mode triggers filtered empty state)
  fireEvent.click(screen.getByRole('button', { name: 'Filter bundle by tags' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Amber' }))
  fireEvent.click(screen.getByRole('button', { name: 'All' }))
  await waitFor(() => expect(screen.getByText('No files match these filters.')).toBeInTheDocument())
  expect(
    vi
      .mocked(replicaRequest)
      .mock.calls.some(
        (call) =>
          call[1].includes('tag_ids=tag-a') &&
          call[1].includes('include_descendants=true') &&
          call[1].includes('tag_mode=all'),
      ),
  ).toBe(true)

  // Close tag popover before clicking Clear filters underneath it
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(await screen.findByText('shot01.png')).toBeInTheDocument()
})

test('album tile & row star buttons toggle stars without selecting or opening, and support single/multi context menu', async () => {
  const onSelectFile = vi.fn()
  const onOpen = vi.fn()
  const { unmount } = setup({ layout: 'grid', onSelectFile, onOpen })
  const tileStar = await screen.findByRole('button', { name: 'Star shot01.png' })
  fireEvent.mouseDown(tileStar)
  fireEvent.click(tileStar)
  fireEvent.doubleClick(tileStar)
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  expect(commit).toHaveBeenLastCalledWith('library', {
    action: 'file_stars',
    ids: ['f1'],
    starred: true,
    observed: { 'asset_file_stars/f1/$alive': ['rev-f1'] },
  })
  expect(onOpen).not.toHaveBeenCalled()
  unmount()

  // List layout star button
  setup({ layout: 'list', onSelectFile, onOpen })
  const rowStar = await screen.findByRole('button', { name: 'Unstar shot02.png' })
  expect(rowStar).toHaveClass('album-row__star')
  fireEvent.click(rowStar)
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(2))
  expect(commit).toHaveBeenLastCalledWith('library', {
    action: 'file_stars',
    ids: ['f2'],
    starred: false,
    observed: { 'asset_file_stars/f2/$alive': ['rev-f2'] },
  })

  // Single-item context menu offers Unstar on starred item, then close menu and multi-select
  const row2 = screen.getByText('shot02.png').closest('[data-file-id]')!
  const row1 = screen.getByText('shot01.png').closest('[data-file-id]')!
  fireEvent.contextMenu(row2)
  expect(screen.getByRole('menuitem', { name: 'Unstar' })).toBeInTheDocument()
  fireEvent.keyDown(document, { key: 'Escape' })
  fireEvent.click(row1)
  fireEvent.click(row2, { metaKey: true })
  fireEvent.contextMenu(row2)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Star 2 Files' }))
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(3))
  expect(commit).toHaveBeenLastCalledWith('library', {
    action: 'file_stars',
    ids: ['f1', 'f2'],
    starred: true,
    observed: {
      'asset_file_stars/f1/$alive': ['rev-f1'],
      'asset_file_stars/f2/$alive': ['rev-f2'],
    },
  })
})

test('album star conflict surfaces Review Conflict alert button', async () => {
  fixture.selectionHeld = true
  const onReviewConflict = vi.fn()
  setup({ onReviewConflict })
  fireEvent.click(await screen.findByRole('button', { name: 'Star shot01.png' }))
  const reviewBtn = await screen.findByRole('button', { name: 'Review Conflict' })
  fireEvent.click(reviewBtn)
  expect(onReviewConflict).toHaveBeenCalledWith('asset_file_stars/f1/$alive')
})

test('in-album tag filter surfaces ancestor tags from catalog navigation hierarchy', async () => {
  fixture.tagNames = { 'tag-b': 'Cobalt' }
  vi.mocked(catalog).mockImplementation(async (_library, path) => {
    if (path.startsWith('/navigation/tags?')) {
      return {
        items: [
          { id: 'tag-parent', name: 'Palette', parent_id: null },
          { id: 'tag-b', name: 'Cobalt', parent_id: 'tag-parent' },
          { id: 'tag-unused', name: 'Unused', parent_id: null },
        ],
        next_cursor: null,
      } as never
    }
    return { items: [] } as never
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CatalogQueryContext value="library">
        <CatalogBundleAlbum
          library="library"
          bundle="bundle-1"
          layout="grid"
          zoom={100}
          onBack={vi.fn()}
          onOpen={vi.fn()}
          onSelectFile={vi.fn()}
        />
      </CatalogQueryContext>
    </QueryClientProvider>,
  )
  await screen.findByText('shot01.png')
  fireEvent.click(screen.getByRole('button', { name: 'Filter bundle by tags' }))
  expect(await screen.findByRole('checkbox', { name: 'Palette' })).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Cobalt' })).toBeInTheDocument()
  expect(screen.queryByRole('checkbox', { name: 'Unused' })).not.toBeInTheDocument()
})
