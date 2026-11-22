import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { commit } from '../api/catalogOrganize'
import { setActiveLibraryId } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { CatalogFileDetails } from './CatalogFileDetails'

vi.mock('../api/replicas', async (original) => ({
  ...(await original<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
}))
vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
}))
vi.mock('../api/catalogOrganize', () => ({ commit: vi.fn(), rename: vi.fn() }))
vi.mock('../api/hooks', () => ({
  useTags: () => ({ data: [] }),
  useTagCounts: () => ({ data: {} }),
  useTagGroups: () => ({ data: [] }),
  useTagGroupMemberships: () => ({ data: {} }),
  useCreateTagPath: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useMoments: () => ({ data: [] }),
  useMomentMutations: () => ({
    create: { mutate: vi.fn(), isPending: false },
    update: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
  }),
}))

beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('library')
  vi.mocked(commit).mockReset().mockResolvedValue()
  vi.mocked(replicaRequest)
    .mockReset()
    .mockImplementation(async (_library, path) => {
      if (path === '/status') {
        return {
          browse_version: 18,
          inspector_version: 2,
          selection_version: 2,
          moments_version: 5,
        } as never
      }
      if (path === '/media/files/file-video-1') {
        return {
          state: 'available',
          generation: 'gen-1',
          message: null,
          playback: null,
          file: {
            id: 'file-video-1',
            bundle_id: 'bundle-1',
            relative_path: 'Clips/clip_01.mp4',
            display_title: 'clip_01.mp4',
            original_filename: 'clip_01.mp4',
            media_kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: 2048,
            availability: 'available',
            supported: true,
            starred: false,
            tech_metadata: { width: 1920, height: 1080, duration: 45 },
          },
        } as never
      }
      if (path.startsWith('/catalog/bundles/bundle-1/moments')) {
        return {
          items: [
            {
              id: 'moment-1',
              bundle_id: 'bundle-1',
              file_id: 'file-video-1',
              start_s: 12.5,
              end_s: 16.0,
              comment: 'Synthetic crane reveal',
              tag_ids: [],
              version: 1,
            },
            {
              id: 'moment-other',
              bundle_id: 'bundle-1',
              file_id: 'file-video-2',
              start_s: 30,
              end_s: null,
              comment: 'Other file moment',
              tag_ids: [],
              version: 1,
            },
          ],
          tag_names: {},
          files: [],
          next_offset: null,
        } as never
      }
      if (path.startsWith('/catalog/drafts')) return { items: [] } as never
      return {} as never
    })
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation(async (_library, path, _method, body) => {
      if (path === '/files/selection') {
        const ids = (body as { ids: string[] }).ids
        return {
          items: ids.map((id) => ({
            id,
            starred: false,
            held: false,
            observed: { [`asset_file_stars/${id}/$alive`]: ['rev-star-1'] },
          })),
        } as never
      }
      if (path === '/files/file-video-1/star') {
        return {
          file_id: 'file-video-1',
          starred: false,
          held: false,
          observed: { 'asset_file_stars/file-video-1/$alive': ['rev-star-1'] },
        } as never
      }
      if (path.startsWith('/files/file-video-1/tags')) {
        return { items: [], next_cursor: null } as never
      }
      if (path === '/entities/asset_files/file-video-1') {
        return {
          family: 'asset_files',
          id: 'file-video-1',
          fields: {
            $alive: {
              unit: 'asset_files/file-video-1/$alive',
              value: 'true',
              basis: ['r1'],
              held: false,
            },
            note: {
              unit: 'asset_files/file-video-1/note',
              value: 'null',
              basis: ['r1'],
              held: false,
            },
            source: {
              unit: 'asset_files/file-video-1/source',
              value: 'null',
              basis: ['r1'],
              held: false,
            },
          },
          observed: {},
          parents: ['r1'],
          has_conflicts: false,
        } as never
      }
      if (path === '/catalog/drafts') return { items: [] } as never
      return { items: [] } as never
    })
})

test('FileInspector renders star inline in the title row with 0ms optimistic flip and shows only this file’s Moments', async () => {
  let finishStarCommit!: () => void
  vi.mocked(commit).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishStarCommit = resolve
      }),
  )
  const onPlayMoment = vi.fn()
  const { container } = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogFileDetails
        library="library"
        file="file-video-1"
        editor="editor-1"
        metadataEnabled
        onPlayMoment={onPlayMoment}
      />
    </QueryClientProvider>,
  )

  // Star button sits inline inside `.inspector__title-row` beside `clip_01.mp4`
  const starBtn = await screen.findByRole('button', { name: 'Star file' })
  const titleRow = container.querySelector('.inspector__title-row')
  expect(titleRow).not.toBeNull()
  expect(titleRow?.contains(starBtn)).toBe(true)

  // Clicking flips to Unstar file immediately (0ms optimistic update) while commit is still pending
  fireEvent.click(starBtn)
  const unstarBtn = screen.getByRole('button', { name: 'Unstar file' })
  expect(unstarBtn).toHaveAttribute('aria-pressed', 'true')
  expect(unstarBtn).toBeEnabled()
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  await act(async () => finishStarCommit())

  // Only file-video-1's moment appears; file-video-2's moment is excluded
  expect(await screen.findByText('Synthetic crane reveal')).toBeInTheDocument()
  expect(screen.queryByText('Other file moment')).not.toBeInTheDocument()

  // Clicking the moment's Play button opens the viewer at that exact file and timestamp
  fireEvent.click(screen.getByRole('button', { name: /Play from/i }))
  expect(onPlayMoment).toHaveBeenCalledWith('bundle-1', 'file-video-1', 12.5)
})
