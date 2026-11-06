import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fetchWriteMode } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { IncomingDialog, type IncomingTarget } from './IncomingDialog'
import type { CatalogCollection } from './useCatalogCollections'

vi.mock('../api/replicas', async (original) => ({
  ...(await original<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
}))
vi.mock('../api/catalog', () => ({ catalog: vi.fn(), operationId: () => 'synthetic' }))
vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  fetchWriteMode: vi.fn(),
}))

const enabled = {
  allowed_by_deployment: true,
  effective: true,
  enabled: true,
  requires_passphrase: false,
}
const files = [
  new File(['synthetic video'], 'Harbor at dusk.mp4'),
  new File(['synthetic subtitles'], 'Harbor at dusk.srt'),
]
const collections = [
  { id: 'travel', name: 'Travel', parent_id: null },
  { id: 'coast', name: 'Coast', parent_id: 'travel' },
] as CatalogCollection[]

function open(target: IncomingTarget) {
  const onStart = vi.fn()
  const onManage = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IncomingDialog
        library="synthetic"
        files={files}
        target={target}
        collections={collections}
        onManage={onManage}
        onClose={vi.fn()}
        onStart={onStart}
      />
    </QueryClientProvider>,
  )
  return { onStart, onManage }
}

beforeEach(() => {
  vi.mocked(fetchWriteMode).mockReset().mockResolvedValue(enabled)
  vi.mocked(replicaRequest).mockReset().mockResolvedValue({ items: [] })
})
afterEach(cleanup)

test('a Bundle Browser drop names the bundle and keeps the open collection', async () => {
  const { onStart } = open({ kind: 'new-bundle', collection: 'coast', folder: 'Trips' })
  expect(screen.getByRole('heading', { name: 'Add 2 files as a new bundle' })).toBeInTheDocument()
  expect(screen.getByLabelText('Bundle name')).toHaveValue('Harbor at dusk')
  expect(screen.getByText('Travel / Coast')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Trips' })).toHaveAttribute('aria-current', 'location')
  const copy = screen.getByRole('button', { name: 'Copy' })
  await vi.waitFor(() => expect(copy).toBeEnabled())
  fireEvent.click(copy)
  const [task, folder] = onStart.mock.calls[0]!
  expect(folder).toBe('Trips')
  expect(task.finish).toEqual({
    kind: 'new-bundle',
    title: 'Harbor at dusk',
    collections: ['coast'],
  })
  expect(
    task.items.map((item: { request: { destination: string } }) => item.request.destination),
  ).toEqual(['Trips/Harbor at dusk.mp4', 'Trips/Harbor at dusk.srt'])
})

test('a File Browser drop copies into the open folder without a bundle', async () => {
  const { onStart } = open({ kind: 'folder', folder: '' })
  expect(screen.getByRole('heading', { name: 'Copy 2 files to Library' })).toBeInTheDocument()
  expect(screen.queryByLabelText('Bundle name')).not.toBeInTheDocument()
  const copy = screen.getByRole('button', { name: 'Copy' })
  await vi.waitFor(() => expect(copy).toBeEnabled())
  fireEvent.click(copy)
  expect(onStart.mock.calls[0]![0].finish).toEqual({ kind: 'none' })
})

test('with write mode off the next step is Libraries, not a disabled Copy', async () => {
  vi.mocked(fetchWriteMode).mockResolvedValue({ ...enabled, effective: false, enabled: false })
  const { onStart, onManage } = open({
    kind: 'bundle',
    bundle: 'b1',
    title: 'Lighthouse',
    folder: '',
  })
  expect(screen.getByRole('heading', { name: 'Add 2 files to “Lighthouse”' })).toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: 'Open Libraries…' }))
  expect(onManage).toHaveBeenCalled()
  expect(onStart).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
})

test.each([
  { items: [{ file: { relative_path: 'Trips/movie.mp4' } }], folder: 'Trips' },
  { items: [{ file: { relative_path: 'movie.mp4' } }], folder: '' },
  { items: [{ directory: { directory_path: 'Trips/Scenes' } }], folder: 'Trips/Scenes' },
  { items: [], folder: 'Remembered' },
])(
  'bundle copies suggest an ordered member folder or the empty-bundle fallback: $folder',
  async ({ items, folder }) => {
    vi.mocked(replicaRequest).mockResolvedValue({ items })
    const { onStart } = open({
      kind: 'bundle',
      bundle: 'b1',
      title: 'Lighthouse',
      folder: 'Remembered',
    })
    expect(screen.queryByLabelText('Bundle name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Add to a collection')).not.toBeInTheDocument()
    const copy = screen.getByRole('button', { name: 'Copy' })
    await vi.waitFor(() => expect(copy).toBeEnabled())
    fireEvent.click(copy)
    expect(onStart.mock.calls[0]![1]).toBe(folder)
    expect(onStart.mock.calls[0]![0].finish).toEqual({
      kind: 'add-to-bundle',
      bundle: 'b1',
      title: 'Lighthouse',
    })
    expect(replicaRequest).toHaveBeenCalledWith(
      'synthetic',
      '/media/bundles/b1/album?offset=0&limit=1',
      'GET',
      undefined,
      expect.any(AbortSignal),
    )
  },
)

test('a late folder suggestion does not replace a manual destination', async () => {
  let resolve!: (page: unknown) => void
  vi.mocked(replicaRequest).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const { onStart } = open({
    kind: 'bundle',
    bundle: 'b1',
    title: 'Lighthouse',
    folder: 'Remembered',
  })
  await screen.findByText('Finding a destination folder…')
  const copy = screen.getByRole('button', { name: 'Copy' })
  expect(copy).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Library' }))
  await act(async () => resolve({ items: [{ file: { relative_path: 'Trips/movie.mp4' } }] }))
  await vi.waitFor(() => expect(copy).toBeEnabled())
  fireEvent.click(copy)
  expect(onStart.mock.calls[0]![1]).toBe('')
})

test('a failed suggestion requires a chosen folder but preserves the target bundle', async () => {
  vi.mocked(replicaRequest).mockRejectedValue(new Error('Unavailable'))
  const { onStart } = open({
    kind: 'bundle',
    bundle: 'b1',
    title: 'Lighthouse',
    folder: 'Remembered',
  })
  await screen.findByText('The folder suggestion is unavailable. Choose a destination folder.')
  const copy = screen.getByRole('button', { name: 'Copy' })
  expect(copy).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Library' }))
  await vi.waitFor(() => expect(copy).toBeEnabled())
  fireEvent.click(copy)
  expect(onStart.mock.calls[0]![0].finish.bundle).toBe('b1')
})
