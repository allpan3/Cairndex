import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { FileBrowserEntry } from '../api/client'
import type { HostLabels } from '../platform'
import { FileBrowser } from './FileBrowser'

const entry: FileBrowserEntry = {
  audio_codec: null,
  bundle_id: 'bundle-one',
  container: 'mov,mp4',
  created_at: '2026-07-18T00:00:00Z',
  duration: 60,
  extension: 'mp4',
  file_id: 'file-one',
  kind: 'file',
  linked: true,
  media_kind: 'video',
  mime_type: 'video/mp4',
  modified_at: '2026-07-18T00:00:00Z',
  name: 'movie.mp4',
  relative_path: 'Movies/movie.mp4',
  resume_position: 0,
  size_bytes: 100,
  supported: true,
  unbundled: false,
  video_codec: 'h264',
}

vi.mock('../api/hooks', () => ({
  useFileBrowser: () => ({
    data: { entries: [entry], missing_files_updated: 0, path: '' },
    dataUpdatedAt: 1,
    error: null,
    isError: false,
    isLoading: false,
  }),
  useUnbundledFiles: () => ({
    data: { pages: [] },
    error: null,
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isLoading: false,
  }),
}))

const labels: HostLabels = {
  revealFile: 'Reveal in Finder',
  openFile: 'Open in Default App',
  locateLibrary: 'Locate on This Mac',
  deviceName: 'Cairndex Desktop for Mac',
}

// Renders the file surface with isolated query state
function renderFileBrowser(hostActions: boolean) {
  const onRevealFile = vi.fn()
  const onOpenFile = vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <FileBrowser
        libraryName="Media"
        scope="browse"
        path=""
        selectedPath={null}
        onNavigate={() => undefined}
        onSelectEntry={() => undefined}
        onAddToBundle={() => undefined}
        onCreateBundle={() => undefined}
        hostLabels={labels}
        onRevealFile={hostActions ? onRevealFile : undefined}
        onOpenFile={hostActions ? onOpenFile : undefined}
      />
    </QueryClientProvider>,
  )
  return { onOpenFile, onRevealFile }
}

test('shows mapped file context actions and passes only the relative path', async () => {
  const actions = renderFileBrowser(true)
  fireEvent.contextMenu(screen.getByText('movie.mp4').closest('[role="row"]') as HTMLElement)

  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in Default App' }))
  expect(actions.onOpenFile).toHaveBeenCalledWith('Movies/movie.mp4')

  fireEvent.contextMenu(screen.getByText('movie.mp4').closest('[role="row"]') as HTMLElement)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in Finder' }))
  expect(actions.onRevealFile).toHaveBeenCalledWith('Movies/movie.mp4')
})

test('hides file context host actions without a mapping', () => {
  renderFileBrowser(false)
  fireEvent.contextMenu(screen.getByText('movie.mp4').closest('[role="row"]') as HTMLElement)

  expect(screen.queryByRole('menuitem', { name: 'Open in Default App' })).not.toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).not.toBeInTheDocument()
})
