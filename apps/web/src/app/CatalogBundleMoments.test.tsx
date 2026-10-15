import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { replicaRequest } from '../api/replicas'
import { CatalogBundleMoments } from './CatalogBundleMoments'

vi.mock('../api/replicas', async (original) => ({
  ...(await original<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
}))

beforeEach(() => vi.mocked(replicaRequest).mockReset())

const file = {
  id: 'file',
  bundle_id: 'bundle',
  relative_path: 'Synthetic/a.mp4',
  display_title: 'a.mp4',
  media_kind: 'video',
  sequence: 0,
  supported: false,
}

function renderMoments(version: number, onPlay = vi.fn()) {
  vi.mocked(replicaRequest).mockImplementation(async (_library, path) => {
    if (path === '/status') return { moments_version: version }
    return {
      items: [
        { id: 'm', bundle_id: 'bundle', file_id: 'file', start_s: 42, end_s: null, tag_ids: [] },
      ],
      next_offset: null,
      tag_names: {},
      files: [file],
    }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CatalogBundleMoments library="synthetic" bundle="bundle" onPlay={onPlay} />
    </QueryClientProvider>,
  )
  return onPlay
}

// The page names its files, so the inspector lists moments without the playlist
test('the browser inspector lists moments and plays one from its time', async () => {
  const onPlay = renderMoments(4)
  fireEvent.click(await screen.findByRole('button', { name: 'Play from 0:42' }))
  expect(onPlay).toHaveBeenCalledWith('file', 42)
  // The browser has no playhead, so nothing here marks a new moment
  expect(screen.queryByRole('button', { name: 'Mark a moment at the playhead' })).toBeNull()
})

test('an older server shows no moments in the browser inspector', async () => {
  renderMoments(3)
  await vi.waitFor(() => expect(replicaRequest).toHaveBeenCalledWith('synthetic', '/status'))
  expect(screen.queryByRole('button', { name: 'Play from 0:42' })).toBeNull()
})
