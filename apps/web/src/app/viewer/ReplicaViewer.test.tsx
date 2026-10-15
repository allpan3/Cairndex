import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { setActiveLibraryId } from '../../api/client'
import { replicaRequest } from '../../api/replicas'
import { ReplicaViewer } from './ReplicaViewer'
import { useMomentSource } from '../momentSource'

vi.mock('../../api/replicas', () => ({ replicaRequest: vi.fn() }))
vi.mock('./ViewerShell', () => ({
  ViewerShell: function ViewerShell({
    loading,
    error,
    serverExports,
    playable,
    inspectorTarget,
    savedMoments,
  }: {
    loading: boolean
    error: Error | null
    serverExports: boolean
    playable: { storyboard_url: string | null } | null
    inspectorTarget: { kind: string } | null
    savedMoments?: unknown[]
  }) {
    const source = useMomentSource()
    return loading ? (
      <p>Loading media</p>
    ) : error ? (
      <p role="alert">{error.message}</p>
    ) : (
      <>
        <p>{serverExports ? 'Media with exports' : 'Media'}</p>
        {playable && <p>Storyboard {playable.storyboard_url ?? 'none'}</p>}
        <p>Rail {inspectorTarget?.kind ?? 'none'}</p>
        <p>
          {source
            ? `Catalog moments ${source.moments.length}`
            : `Saved moments ${savedMoments?.length ?? 0}`}
        </p>
      </>
    )
  },
}))

test('a failed continuation exposes the error instead of waiting forever for a late cursor', async () => {
  vi.mocked(replicaRequest).mockImplementation(async (_library, path) => {
    if (path.includes('offset=0'))
      return {
        title: 'Synthetic album',
        files: [],
        directories: [],
        moments: [],
        cursor: 'late-file',
        revision: 'first',
        next_offset: 100,
      }
    throw new Error('Playlist changed. Retry local media to reload it.')
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ReplicaViewer library="synthetic" target={{ bundleId: 'bundle' }} onClose={() => {}} />
    </QueryClientProvider>,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('Playlist changed')
  expect(screen.queryByText('Loading media')).not.toBeInTheDocument()
  view.unmount()
  client.clear()
})

// Exports follow the server's advertised capability, never an assumption about its version
test.each([
  [1, 'Media with exports'],
  [null, 'Media'],
])('export capability %s shows %s', async (version, text) => {
  setActiveLibraryId('synthetic')
  vi.mocked(replicaRequest).mockImplementation(async (_library, path) => {
    if (path === '/status') return { export_version: version }
    if (path.startsWith('/media/files/'))
      return { file: { id: 'file', bundle_id: 'bundle' }, generation: 'g', state: 'available' }
    return {
      title: 'Synthetic album',
      files: [{ id: 'file', bundle_id: 'bundle', relative_path: 'a.mp4', media_kind: 'video' }],
      directories: [],
      moments: [],
      cursor: null,
      revision: 'first',
      next_offset: null,
    }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ReplicaViewer library="synthetic" target={{ bundleId: 'bundle' }} onClose={() => {}} />
    </QueryClientProvider>,
  )
  expect(await screen.findByText(text)).toBeInTheDocument()
  view.unmount()
  client.clear()
  setActiveLibraryId(null)
})

// A queued storyboard is polled with the observed generation until it is ready
test('a queued storyboard reaches the shell once it is ready', async () => {
  setActiveLibraryId('synthetic')
  const ready = { state: 'ready', url: '/api/v1/storyboard.vtt?v=g', message: null }
  const replies = [{ state: 'queued', url: null, message: null }, ready]
  const bodies: unknown[] = []
  const file = {
    id: 'file',
    bundle_id: 'bundle',
    relative_path: 'a.mp4',
    original_filename: 'a.mp4',
    display_title: 'a',
    media_kind: 'video',
    supported: true,
    availability: 'available',
  }
  vi.mocked(replicaRequest).mockImplementation(async (_library, path, _method, body) => {
    if (path === '/status') return { storyboard_version: 1 }
    if (path.endsWith('/storyboard')) {
      bodies.push(body)
      return replies.shift() ?? ready
    }
    if (path.startsWith('/media/files/'))
      return {
        file,
        generation: 'g',
        state: 'available',
        message: null,
        playback: { file_id: 'file', stream_url: '/stream', storyboard_url: null, subtitles: [] },
      }
    return {
      title: 'Synthetic album',
      files: [file],
      directories: [],
      moments: [],
      cursor: null,
      revision: 'first',
      next_offset: null,
    }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ReplicaViewer library="synthetic" target={{ bundleId: 'bundle' }} onClose={() => {}} />
    </QueryClientProvider>,
  )
  expect(await screen.findByText('Storyboard none')).toBeInTheDocument()
  expect(
    await screen.findByText('Storyboard /api/v1/storyboard.vtt?v=g', {}, { timeout: 4000 }),
  ).toBeInTheDocument()
  expect(bodies).toEqual([{ generation: 'g' }, { generation: 'g' }])
  view.unmount()
  client.clear()
  setActiveLibraryId(null)
}, 10_000)

// The moments capability moves the rail and the seek marks to the catalog source
test.each([
  [1, 'Rail moments', 'Catalog moments 2'],
  [2, 'Rail moments', 'Catalog moments 2'],
  [null, 'Rail none', 'Saved moments 1'],
])('moments capability %s shows %s', async (version, rail, moments) => {
  setActiveLibraryId('synthetic')
  const file = {
    id: 'file',
    bundle_id: 'bundle',
    relative_path: 'a.mp4',
    original_filename: 'a.mp4',
    display_title: 'a',
    media_kind: 'video',
    supported: true,
    availability: 'available',
  }
  const moment = { id: 'm', bundle_id: 'bundle', file_id: 'file', start_s: 1, end_s: null }
  vi.mocked(replicaRequest).mockImplementation(async (_library, path) => {
    if (path === '/status') return { moments_version: version }
    if (path.startsWith('/catalog/bundles/bundle/moments'))
      return path.endsWith('offset=0')
        ? { items: [moment], next_offset: 1, tag_names: {} }
        : { items: [{ ...moment, id: 'n' }], next_offset: null, tag_names: {} }
    if (path.startsWith('/media/files/'))
      return { file, generation: 'g', state: 'available', message: null, playback: null }
    return {
      title: 'Synthetic album',
      files: [file],
      directories: [],
      moments: [moment],
      cursor: null,
      revision: 'first',
      next_offset: null,
    }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ReplicaViewer library="synthetic" target={{ bundleId: 'bundle' }} onClose={() => {}} />
    </QueryClientProvider>,
  )
  expect(await screen.findByText(rail)).toBeInTheDocument()
  expect(await screen.findByText(moments)).toBeInTheDocument()
  view.unmount()
  client.clear()
  setActiveLibraryId(null)
})
