import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { replicaRequest } from '../api/replicas'
import { CatalogFileDetails } from './CatalogFileDetails'
import { linkedVideoEntry as entry } from './testFixtures'

vi.mock('../api/replicas', () => ({ replicaRequest: vi.fn() }))

const fact = (name: string) =>
  screen.getByText(name, { selector: 'dt' }).parentElement?.querySelector('dd')?.textContent

test('inspector Rename follows live permission for files and folders', () => {
  const client = new QueryClient()
  const onRename = vi.fn()
  const view = (enabled: boolean, directory = false) => (
    <QueryClientProvider client={client}>
      <CatalogFileDetails
        library="library"
        file={null}
        entry={
          directory
            ? { ...entry, kind: 'directory', name: 'Folder', relative_path: 'Folder' }
            : entry
        }
        onRename={enabled ? onRename : undefined}
      />
    </QueryClientProvider>
  )
  const { rerender } = render(view(false))
  fireEvent.doubleClick(screen.getByText(entry.name, { exact: true }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  rerender(view(true))
  fireEvent.doubleClick(screen.getByText(entry.name, { exact: true }))
  const input = screen.getByRole('textbox', { name: `Rename ${entry.name}` })
  fireEvent.change(input, { target: { value: 'clip.mp4' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onRename).toHaveBeenCalledExactlyOnceWith(entry.relative_path, 'clip.mp4')
  rerender(view(true, true))
  fireEvent.doubleClick(screen.getByText('Folder', { exact: true, selector: '.inspector__title' }))
  expect(screen.getByRole('textbox', { name: 'Rename Folder' })).toBeInTheDocument()
  rerender(view(false, true))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(onRename).toHaveBeenCalledTimes(1)
})

const observed = {
  state: 'available',
  generation: 'synthetic',
  message: null,
  playback: null,
  file: {
    id: 'file-one',
    bundle_id: 'bundle-one',
    relative_path: entry.relative_path,
    display_title: entry.name,
    original_filename: entry.name,
    media_kind: 'video',
    mime_type: 'video/mp4',
    size_bytes: 100,
    availability: 'available',
    supported: true,
    tech_metadata: { width: 320, height: 180, duration: 60, video_codec: 'h264' },
  },
}

// The File Browser pane reads as v0.2.1's: one title, every fact, Path last, then Locate
test('a File Browser file shows one title, all facts and the listing modified time', async () => {
  vi.mocked(replicaRequest).mockResolvedValue(observed as never)
  const onLocate = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CatalogFileDetails library="library" file="file-one" entry={entry} onLocate={onLocate} />
    </QueryClientProvider>,
  )
  expect(await screen.findByText('320 × 180')).toBeInTheDocument()
  expect(screen.getAllByText('movie.mp4', { exact: true })).toHaveLength(1)
  expect(fact('MIME')).toBe('video/mp4')
  expect(fact('Status')).toBe('In a bundle')
  expect(fact('Date Modified')).not.toBe('—')
  const facts = [...document.querySelectorAll('dt')].map((term) => term.textContent)
  expect(facts.at(-1)).toBe('Path')
  expect(fact('Path')).toBe('Movies/movie.mp4')
  expect(screen.queryByText('More details')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Locate in Bundle Browser' }))
  expect(onLocate).toHaveBeenCalledOnce()
})

// A file outside every bundle has nothing to locate, so the button stays visible but dimmed
test('an unbundled file shows Locate disabled', async () => {
  vi.mocked(replicaRequest).mockResolvedValue(observed as never)
  const onLocate = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CatalogFileDetails
        library="library"
        file="file-one"
        entry={entry}
        onLocate={onLocate}
        locatable={false}
      />
    </QueryClientProvider>,
  )
  const button = await screen.findByRole('button', { name: 'Locate in Bundle Browser' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('title', 'This file is not in a bundle yet')
  fireEvent.click(button)
  expect(onLocate).not.toHaveBeenCalled()
})

// No per-file check: the polled listing drives a new read while the file stays selected
test('a change in the listing state reads the selected file again', async () => {
  vi.mocked(replicaRequest)
    .mockReset()
    .mockResolvedValue(observed as never)
  const client = new QueryClient()
  const view = (state: 'observed' | 'unavailable') => (
    <QueryClientProvider client={client}>
      <CatalogFileDetails
        library="library"
        file="file-one"
        entry={{ ...entry, local_state: state }}
      />
    </QueryClientProvider>
  )
  const { rerender } = render(view('unavailable'))
  await waitFor(() => expect(replicaRequest).toHaveBeenCalledTimes(1))
  expect(fact('Status')).toBe('Unavailable on this device')
  rerender(view('observed'))
  await waitFor(() => expect(replicaRequest).toHaveBeenCalledTimes(2))
  expect(fact('Status')).toBe('In a bundle')
})
