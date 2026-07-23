import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { hostLabelsFor } from '../platform'
import { FileBrowser } from './FileBrowser'

vi.mock('../api/hooks', async () => {
  const { linkedVideoEntry } = await import('./testFixtures')
  return {
    useFileBrowser: () => ({
      data: { entries: [linkedVideoEntry], missing_files_updated: 0, path: '' },
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
    // The write affordances are inert in these tests (no `writeMode` prop), but
    // the hook is still called, so it needs mutations that exist.
    useFileOperations: () => ({
      rename: { mutate: vi.fn(), isPending: false },
      mkdir: { mutate: vi.fn(), isPending: false },
      undo: { mutate: vi.fn(), isPending: false },
      trash: { mutate: vi.fn(), isPending: false },
      importOne: { mutateAsync: vi.fn(), isPending: false },
    }),
  }
})

const labels = hostLabelsFor('macos')

// Renders the file surface with isolated query state
function renderFileBrowser(hostActions: boolean, onStartFileDrag?: (paths: string[]) => void) {
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
        onStartFileDrag={onStartFileDrag}
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

test('makes a list row a drag-out source only once it is selected (keeps marquee)', () => {
  const onStartFileDrag = vi.fn()
  renderFileBrowser(true, onStartFileDrag)
  const row = () => screen.getByText('movie.mp4').closest('[role="row"]') as HTMLElement

  // Unselected: not draggable, so a press-drag on the row still starts the marquee.
  expect(row()).toHaveAttribute('draggable', 'false')

  // Selecting the row (selection-first) makes it a drag-out source.
  fireEvent.click(row())
  expect(row()).toHaveAttribute('draggable', 'true')
  fireEvent.dragStart(row())
  expect(onStartFileDrag).toHaveBeenCalledWith(['Movies/movie.mp4'])
})

test('hides file context host actions without a mapping', () => {
  renderFileBrowser(false)
  fireEvent.contextMenu(screen.getByText('movie.mp4').closest('[role="row"]') as HTMLElement)

  expect(screen.queryByRole('menuitem', { name: 'Open in Default App' })).not.toBeInTheDocument()
  expect(screen.queryByRole('menuitem', { name: 'Reveal in Finder' })).not.toBeInTheDocument()
})
