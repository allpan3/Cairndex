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

/** Serve these existing library folders to the directory listings. */
function folders(tree: Record<string, string[]>) {
  vi.mocked(replicaRequest).mockImplementation(async (_library: string, path: string) => {
    const match = /\/media\/directory\?path=(.*)$/.exec(path)
    if (!match) return { items: [] }
    const folder = decodeURIComponent(match[1]!)
    return {
      path: folder,
      missing_files_updated: 0,
      entries: (tree[folder] ?? []).map((name) => ({
        kind: 'directory',
        name,
        relative_path: folder ? `${folder}/${name}` : name,
      })),
    }
  })
}

const destinations = (task: { items: { request: { action: string; destination: string } }[] }) =>
  task.items.map((item) => `${item.request.action} ${item.request.destination}`)

beforeEach(() => {
  vi.mocked(fetchWriteMode).mockReset().mockResolvedValue(enabled)
  vi.mocked(replicaRequest).mockReset()
  folders({ '': ['Trips'] })
})
afterEach(cleanup)

test('a drop on a collection without bundles creates folders named after its path', async () => {
  folders({ '': ['Travel'], Travel: [] })
  const { onStart } = open({ kind: 'new-bundle', collection: 'coast', home: null, folder: 'Trips' })
  expect(screen.getByRole('heading', { name: 'Add 2 files as a new bundle' })).toBeInTheDocument()
  expect(screen.getByLabelText('Bundle name')).toHaveValue('Harbor at dusk')
  expect(screen.getByText('Travel / Coast')).toBeInTheDocument()
  // The last folder used (Trips) belongs to another collection and is not suggested
  expect(
    await screen.findByRole('button', { name: 'Harbor at dusk (new folder)' }),
  ).toHaveAttribute('aria-current', 'location')
  expect(screen.getByRole('button', { name: 'Coast (new folder)' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Travel' })).toBeInTheDocument()
  const copy = screen.getByRole('button', { name: 'Copy' })
  await vi.waitFor(() => expect(copy).toBeEnabled())
  fireEvent.click(copy)
  const [task, folder] = onStart.mock.calls[0]!
  expect(folder).toBe('Travel/Coast/Harbor at dusk')
  expect(task.finish).toEqual({
    kind: 'new-bundle',
    title: 'Harbor at dusk',
    collections: ['coast'],
  })
  // Outer folders first, each inside the one before, then the copies
  expect(destinations(task)).toEqual([
    'mkdir Travel/Coast',
    'mkdir Travel/Coast/Harbor at dusk',
    'copy Travel/Coast/Harbor at dusk/Harbor at dusk.mp4',
    'copy Travel/Coast/Harbor at dusk/Harbor at dusk.srt',
  ])
})

test('bundles with a folder each give the new bundle its own, which follows its name', async () => {
  folders({ '': ['Films'], Films: ['Alpha', 'Lighthouse'] })
  const { onStart } = open({
    kind: 'new-bundle',
    collection: 'coast',
    home: { folder: 'Films', perBundle: true },
    folder: 'Trips',
  })
  await screen.findByRole('button', { name: 'Harbor at dusk (new folder)' })
  // A name whose folder already exists uses it instead of creating it again
  fireEvent.change(screen.getByLabelText('Bundle name'), { target: { value: 'Lighthouse' } })
  await vi.waitFor(() =>
    expect(screen.getByRole('button', { name: 'Lighthouse' })).toHaveAttribute(
      'aria-current',
      'location',
    ),
  )
  const copy = screen.getByRole('button', { name: 'Copy' })
  await vi.waitFor(() => expect(copy).toBeEnabled())
  fireEvent.click(copy)
  expect(destinations(onStart.mock.calls[0]![0])).toEqual([
    'copy Films/Lighthouse/Harbor at dusk.mp4',
    'copy Films/Lighthouse/Harbor at dusk.srt',
  ])
})

test('bundles sharing a folder put the new bundle beside them without a folder', async () => {
  folders({ '': ['Shared'], Shared: [] })
  const { onStart } = open({
    kind: 'new-bundle',
    collection: 'coast',
    home: { folder: 'Shared', perBundle: false },
    folder: 'Trips',
  })
  const copy = screen.getByRole('button', { name: 'Copy' })
  await vi.waitFor(() => expect(copy).toBeEnabled())
  fireEvent.click(copy)
  expect(onStart.mock.calls[0]![1]).toBe('Shared')
})

test('New Folder adds a folder to create inside the chosen one; Enter does not copy', async () => {
  folders({ '': ['Trips'], Trips: [] })
  const { onStart } = open({ kind: 'folder', folder: 'Trips' })
  fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
  fireEvent.click(await screen.findByRole('button', { name: 'New Folder…' }))
  const name = screen.getByLabelText('New folder name')
  fireEvent.change(name, { target: { value: 'a/b' } })
  expect(screen.getByRole('alert')).toHaveTextContent('Enter a name without folder separators.')
  fireEvent.change(name, { target: { value: 'Evening' } })
  fireEvent.keyDown(name, { key: 'Enter' })
  expect(onStart).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Evening (new folder)' })).toHaveAttribute(
    'aria-current',
    'location',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  const [task, folder] = onStart.mock.calls[0]!
  expect(folder).toBe('Trips/Evening')
  expect(destinations(task)).toEqual([
    'mkdir Trips/Evening',
    'copy Trips/Evening/Harbor at dusk.mp4',
    'copy Trips/Evening/Harbor at dusk.srt',
  ])
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
