import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { setActiveLibraryId } from '../../api/client'
import { replicaRequest } from '../../api/replicas'
import { ReplicaViewer } from './ReplicaViewer'

vi.mock('../../api/replicas', () => ({ replicaRequest: vi.fn() }))
vi.mock('./ViewerShell', () => ({
  ViewerShell: ({
    loading,
    error,
    serverExports,
  }: {
    loading: boolean
    error: Error | null
    serverExports: boolean
  }) =>
    loading ? (
      <p>Loading media</p>
    ) : error ? (
      <p role="alert">{error.message}</p>
    ) : (
      <p>{serverExports ? 'Media with exports' : 'Media'}</p>
    ),
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
