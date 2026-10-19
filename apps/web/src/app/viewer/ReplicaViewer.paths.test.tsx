import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { setActiveLibraryId, type FileBrowserEntry } from '../../api/client'
import { replicaRequest } from '../../api/replicas'
import { ReplicaViewer } from './ReplicaViewer'

vi.mock('../../api/replicas', () => ({ replicaRequest: vi.fn() }))
vi.mock('./ViewerShell', () => ({
  ViewerShell: ({
    items,
    index,
    onIndex,
    loading,
    error,
    playable,
  }: {
    items: { fileId: string | null; pathTarget: string | null; contentUrl: string }[]
    index: number
    onIndex: (index: number) => void
    loading: boolean
    error: Error | null
    playable: { progress?: { position_s: number } | null } | null
  }) =>
    loading ? (
      <p>Loading media</p>
    ) : error ? (
      <p role="alert">{error.message}</p>
    ) : (
      <>
        <p>{items[index]?.fileId ?? items[index]?.pathTarget}</p>
        <p>{items[index]?.contentUrl}</p>
        <p>Resume {playable?.progress?.position_s ?? 'none'}</p>
        <button onClick={() => onIndex(0)}>Previous file</button>
        <button onClick={() => onIndex(1)}>Next file</button>
      </>
    ),
}))

function entry(path: string, id: string | null = null): FileBrowserEntry {
  return {
    name: path.split('/').at(-1)!,
    relative_path: path,
    kind: 'file',
    size_bytes: 100,
    modified_at: null,
    created_at: null,
    extension: 'mp4',
    mime_type: 'video/mp4',
    media_kind: 'video',
    supported: true,
    linked: id !== null,
    file_id: id,
    bundle_id: id ? 'bundle' : null,
    container: 'mp4',
    video_codec: 'h264',
    video_codec_tag: 'avc1',
    audio_codec: 'aac',
    duration: 30,
    resume_position: null,
    unbundled: false,
  }
}

test('a mixed folder opens bare paths and retains linked resume and cursor identity', async () => {
  setActiveLibraryId('synthetic')
  const calls: { path: string; body: unknown }[] = []
  const loose = entry('Playback/loose.mp4')
  const linked = entry('Playback/linked.mp4', 'linked')
  vi.mocked(replicaRequest).mockImplementation(async (_library, path, _method, body) => {
    calls.push({ path, body })
    if (path === '/status') return { path_media_version: 1, browse_version: 11 }
    if (path.startsWith('/media/path?')) return { entry: loose, generation: 'a'.repeat(64) }
    if (path === '/media/files/linked')
      return {
        state: 'available',
        generation: 'b'.repeat(64),
        message: null,
        file: {
          id: 'linked',
          bundle_id: 'bundle',
          relative_path: linked.relative_path,
          original_filename: linked.name,
          display_title: linked.name,
          supported: true,
          media_kind: 'video',
          availability: 'available',
          tech_metadata: { duration: 30 },
        },
        playback: {
          stream_url: '/linked-stream',
          progress: { position_s: 17, completed: false },
          subtitles: [],
        },
      }
    return {}
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <ReplicaViewer
        library="synthetic"
        target={{ relativePath: loose.relative_path }}
        folder={{ entries: [loose, linked], title: 'Synthetic folder' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
  await screen.findByText(loose.relative_path, { exact: true })
  expect(screen.getByText('Resume none')).toBeInTheDocument()
  expect(
    calls.some(({ path }) => path.endsWith('/cursor') || path.startsWith('/media/files/')),
  ).toBe(false)
  expect(screen.getByText(/source_generation=aaa/)).toHaveTextContent('&source_generation=')
  fireEvent.click(screen.getByRole('button', { name: 'Next file' }))
  await screen.findByText('Resume 17')
  await waitFor(() =>
    expect(calls).toContainEqual({
      path: '/media/bundles/bundle/cursor',
      body: { file_id: 'linked' },
    }),
  )
  await waitFor(() =>
    expect(calls.some(({ path }) => path === '/media/bundles/bundle/opened')).toBe(true),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Previous file' }))
  await screen.findByText(loose.relative_path, { exact: true })
  expect(screen.getByText('Resume none')).toBeInTheDocument()
  expect(
    calls
      .filter(({ path }) => path.endsWith('/cursor'))
      .every(({ body }) => (body as { file_id: string }).file_id === 'linked'),
  ).toBe(true)
  view.unmount()
  client.clear()
  setActiveLibraryId(null)
})

test('older servers explain an unsupported path without calling unavailable APIs', async () => {
  setActiveLibraryId('synthetic')
  const paths: string[] = []
  vi.mocked(replicaRequest).mockImplementation(async (_library, path) => {
    paths.push(path)
    return path === '/status' ? { media_version: 1 } : {}
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const loose = entry('Playback/loose.mp4')
  const view = render(
    <QueryClientProvider client={client}>
      <ReplicaViewer
        library="synthetic"
        target={{ relativePath: loose.relative_path }}
        folder={{ entries: [loose], title: 'Synthetic folder' }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('cannot preview unindexed files')
  expect(paths.some((path) => path.startsWith('/media/path'))).toBe(false)
  view.unmount()
  client.clear()
  setActiveLibraryId(null)
})
