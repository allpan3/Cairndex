import { libraryStateKey } from '../state/useBundleDraft'
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

const originalEntries: FileBrowserEntry[] = [
  {
    ...linkedVideoEntry,
    file_id: 'b',
    name: 'b.mp4',
    relative_path: 'Movies/b.mp4',
    size_bytes: 300,
  },
  {
    ...linkedVideoEntry,
    file_id: 'a',
    name: 'a.mp4',
    relative_path: 'Movies/a.mp4',
    size_bytes: 100,
  },
  {
    ...linkedVideoEntry,
    file_id: 'c',
    name: 'c.mp4',
    relative_path: 'Movies/c.mp4',
    size_bytes: 200,
  },
]
let entries = originalEntries

vi.mock('./FileEntryViewer', () => ({
  FileEntryViewer: ({ files, index }: { files: FileBrowserEntry[]; index: number }) => (
    <div data-testid="viewing-file">{files[index]?.relative_path}</div>
  ),
}))

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
  const tree = () => (
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
    </QueryClientProvider>
  )
  const view = render(tree())
  return () => view.rerender(tree())
}

const names = () =>
  [...document.querySelectorAll('[data-relpath]')].map((el) => (el as HTMLElement).dataset.relpath)
const selectedNames = () =>
  [...document.querySelectorAll('.file-row--selected')].map(
    (el) => (el as HTMLElement).dataset.relpath,
  )

let libraryIndex = 0
beforeEach(() => {
  entries = originalEntries
  localStorage.clear()
  vi.clearAllMocks()
  // Thumbnail URLs are library-scoped; the rows build one per entry.
  setActiveLibraryId(`navigation-${++libraryIndex}`)
})

test('refresh follows a renamed indexed file in selection, inspector and viewer', () => {
  const refresh = renderBrowser()
  const row = document.querySelector('[data-relpath="Movies/b.mp4"]')!
  fireEvent.click(row)
  fireEvent.doubleClick(row)
  expect(screen.getByTestId('viewing-file')).toHaveTextContent('Movies/b.mp4')
  entries = originalEntries.map((entry) =>
    entry.file_id === 'b' ? { ...entry, name: 'z.mp4', relative_path: 'Movies/z.mp4' } : entry,
  )
  refresh()
  expect(selectedNames()).toEqual(['Movies/z.mp4'])
  expect(screen.getByTestId('viewing-file')).toHaveTextContent('Movies/z.mp4')
  expect(selected.at(-1)?.relative_path).toBe('Movies/z.mp4')
})

test('arrow keys walk the focused listing without selecting an item first', () => {
  renderBrowser()
  screen.getByRole('grid', { name: 'Files' }).focus()

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

  const stored = JSON.parse(localStorage.getItem(libraryStateKey('cairndex.filePrefs')) ?? '{}')
  expect(stored.folderSorts).toEqual({ Movies: { sort: 'size', order: 'asc' } })
  // The global sort is what an unscoped folder still falls back to.
  expect(stored.sort).toBe('name')
  expect(names()).toEqual(['Movies/a.mp4', 'Movies/c.mp4', 'Movies/b.mp4'])
})

test('without the scope, sorting stays global', () => {
  renderBrowser()
  fireEvent.click(screen.getByRole('button', { name: 'Sort by Size' }))

  const stored = JSON.parse(localStorage.getItem(libraryStateKey('cairndex.filePrefs')) ?? '{}')
  expect(stored.sort).toBe('size')
  expect(stored.folderSorts ?? {}).toEqual({})
})

// Focus and range anchor differ so reversing Shift direction shrinks the same selection
test('Shift arrows extend and shrink while command arrows only move focus', () => {
  renderBrowser()
  const list = screen.getByRole('grid', { name: 'Files' })
  list.focus()
  fireEvent.keyDown(list, { key: 'ArrowDown' })
  fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true })
  expect(selectedNames()).toEqual(['Movies/a.mp4', 'Movies/b.mp4'])
  fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true })
  expect(selectedNames()).toHaveLength(3)
  fireEvent.keyDown(list, { key: 'ArrowUp', shiftKey: true })
  expect(selectedNames()).toEqual(['Movies/a.mp4', 'Movies/b.mp4'])
  fireEvent.keyDown(list, { key: 'ArrowDown', metaKey: true })
  expect(selectedNames()).toEqual(['Movies/a.mp4', 'Movies/b.mp4'])
  fireEvent.keyDown(list, { key: 'a', metaKey: true })
  expect(selectedNames()).toHaveLength(3)
  fireEvent.keyDown(list, { key: 'Escape' })
  expect(selectedNames()).toEqual([])
})

// Page-level and editable content must never select a background file listing
test('unfocused lists and contenteditable retain keyboard ownership', () => {
  renderBrowser()
  fireEvent.keyDown(window, { key: 'a', metaKey: true })
  fireEvent.keyDown(window, { key: 'ArrowDown' })
  expect(selectedNames()).toEqual([])
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.setAttribute('contenteditable', 'true')
  screen.getByRole('grid', { name: 'Files' }).append(editor)
  fireEvent.keyDown(editor, { key: 'a', metaKey: true })
  expect(selectedNames()).toEqual([])
  editor.remove()
})
