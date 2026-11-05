import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fetchWriteMode } from '../api/client'
import { IncomingDialog, type IncomingTarget } from './IncomingDialog'
import type { CatalogCollection } from './useCatalogCollections'

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

beforeEach(() => vi.mocked(fetchWriteMode).mockReset().mockResolvedValue(enabled))
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
