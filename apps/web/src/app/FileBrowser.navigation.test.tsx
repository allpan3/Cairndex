import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileBrowserEntry } from '../api/client'
import { setActiveLibraryId } from '../api/client'
import { hostLabelsFor } from '../platform'
import { FileBrowser } from './FileBrowser'
import { linkedVideoEntry } from './testFixtures'
import { DEFAULT_PLAYER_PREFS } from './types'

// Keyboard navigation and header sorting in the File Browser listing (owner,
// 2026-09-01): the arrows used to reach the shell rather than the rows, and the
// only way to change the sort was the toolbar control.

const entries: FileBrowserEntry[] = [
  { ...linkedVideoEntry, name: 'b.mp4', relative_path: 'Movies/b.mp4', size_bytes: 300 },
  { ...linkedVideoEntry, name: 'a.mp4', relative_path: 'Movies/a.mp4', size_bytes: 100 },
  { ...linkedVideoEntry, name: 'c.mp4', relative_path: 'Movies/c.mp4', size_bytes: 200 },
]

vi.mock('../api/hooks', () => ({
  useFileBrowser: () => ({
    data: { entries, missing_files_updated: 0, path: 'Movies' },
    dataUpdatedAt: 1,
    error: null,
    isError: false,
    isLoading: false,
    isPlaceholderData: false,
  }),
  useUnbundledFiles: () => ({
    data: { pages: [] },
    error: null,
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isLoading: false,
  }),
  useFileOperations: () => ({
    rename: { mutate: vi.fn(), isPending: false },
    mkdir: { mutate: vi.fn(), isPending: false },
    undo: { mutate: vi.fn(), isPending: false },
    trash: { mutate: vi.fn(), isPending: false },
    move: { mutate: vi.fn(), isPending: false },
  }),
  useTargetSuggestions: () => ({ data: undefined, isLoading: false }),
}))

let selected: (FileBrowserEntry | null)[] = []

function renderBrowser() {
  selected = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <FileBrowser
        libraryName="Media"
        scope="browse"
        path="Movies"
        selectedPath={null}
        onNavigate={() => undefined}
        onSelectEntry={(entry) => selected.push(entry)}
        playerPrefs={DEFAULT_PLAYER_PREFS}
        onPlayerPrefs={() => undefined}
        onAddToBundle={() => undefined}
        onCreateBundle={() => undefined}
        hostLabels={hostLabelsFor('macos')}
      />
    </QueryClientProvider>,
  )
}

const names = () =>
  [...document.querySelectorAll('[data-relpath]')].map((el) => (el as HTMLElement).dataset.relpath)
const selectedNames = () =>
  [...document.querySelectorAll('.file-row--selected')].map(
    (el) => (el as HTMLElement).dataset.relpath,
  )

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  // Thumbnail URLs are library-scoped; the rows build one per entry.
  setActiveLibraryId('lib-1')
})

test('arrow keys walk the listing without anything having been clicked first', () => {
  renderBrowser()

  fireEvent.keyDown(window, { key: 'ArrowDown' })
  expect(selectedNames()).toEqual(['Movies/a.mp4'])
  expect(selected.at(-1)?.name).toBe('a.mp4')

  fireEvent.keyDown(window, { key: 'ArrowDown' })
  expect(selectedNames()).toEqual(['Movies/b.mp4'])

  fireEvent.keyDown(window, { key: 'ArrowUp' })
  expect(selectedNames()).toEqual(['Movies/a.mp4'])
})

test('arrow keys stay out of a text field', () => {
  renderBrowser()

  const search = screen.getByLabelText('Search files')
  fireEvent.keyDown(search, { key: 'ArrowDown' })

  expect(selectedNames()).toEqual([])
})

test('clicking a column header sorts by it, and clicking again reverses', () => {
  renderBrowser()

  // Name ascending is the default, so the listing starts a, b, c.
  expect(names()).toEqual(['Movies/a.mp4', 'Movies/b.mp4', 'Movies/c.mp4'])

  fireEvent.click(screen.getByRole('button', { name: 'Sort by Size' }))
  expect(names()).toEqual(['Movies/a.mp4', 'Movies/c.mp4', 'Movies/b.mp4'])

  fireEvent.click(screen.getByRole('button', { name: 'Sort by Size' }))
  expect(names()).toEqual(['Movies/b.mp4', 'Movies/c.mp4', 'Movies/a.mp4'])

  // The header says which column is in force, and which way.
  const header = screen
    .getByRole('button', { name: 'Sort by Size' })
    .closest('[role="columnheader"]')
  expect(header).toHaveAttribute('aria-sort', 'descending')
})

test('the toolbar sort control and the headers are one preference', () => {
  renderBrowser()

  fireEvent.click(screen.getByRole('button', { name: 'Sort by Date Modified' }))

  expect(screen.getByRole('button', { name: 'Sort' })).toHaveTextContent('Date Modified')
})

// --- per-folder sort (owner, 2026-09-01) ------------------------------------

/** Open the sort pane, run something inside it, then dismiss it. The pane's
 *  first outside click only dismisses — deliberately, so clicking away from a
 *  picker never also acts on what is underneath (see `usePopover`). */
const withSortPane = (inside: () => void) => {
  const button = screen.getByRole('button', { name: 'Sort' })
  fireEvent.click(button)
  inside()
  fireEvent.click(button)
}

test('the sort pane offers a per-folder scope, off by default', () => {
  renderBrowser()
  withSortPane(() => {
    expect(screen.getByLabelText('Remember sort per folder')).not.toBeChecked()
  })
})

test('with the scope on, a folder keeps its own sort and the global one is untouched', () => {
  renderBrowser()
  withSortPane(() => fireEvent.click(screen.getByLabelText('Remember sort per folder')))
  fireEvent.click(screen.getByRole('button', { name: 'Sort by Size' }))

  const stored = JSON.parse(localStorage.getItem('cairndex.filePrefs') ?? '{}')
  expect(stored.folderSorts).toEqual({ Movies: { sort: 'size', order: 'asc' } })
  // The global sort is what an unscoped folder still falls back to.
  expect(stored.sort).toBe('name')
  expect(names()).toEqual(['Movies/a.mp4', 'Movies/c.mp4', 'Movies/b.mp4'])
})

test('without the scope, sorting stays global', () => {
  renderBrowser()
  fireEvent.click(screen.getByRole('button', { name: 'Sort by Size' }))

  const stored = JSON.parse(localStorage.getItem('cairndex.filePrefs') ?? '{}')
  expect(stored.sort).toBe('size')
  expect(stored.folderSorts ?? {}).toEqual({})
})
