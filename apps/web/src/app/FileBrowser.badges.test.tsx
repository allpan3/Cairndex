import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileBrowserEntry } from '../api/client'
import { setActiveLibraryId } from '../api/client'
import { hostLabelsFor } from '../platform'
import { FileBrowser } from './FileBrowser'
import { linkedVideoEntry } from './testFixtures'
import { DEFAULT_PLAYER_PREFS } from './types'

// Rows keep the earlier badge-only status (owner): no dotted availability text,
// nothing for a present file, one plain badge for a file this device did not find.
const entries: FileBrowserEntry[] = [
  {
    ...linkedVideoEntry,
    kind: 'directory',
    name: 'Folder',
    relative_path: 'Movies/Folder',
    file_id: null,
    bundle_id: null,
    linked: false,
    local_state: 'observed',
  },
  { ...linkedVideoEntry, local_state: 'observed' },
  {
    ...linkedVideoEntry,
    file_id: 'gone',
    name: 'gone.mp4',
    relative_path: 'Movies/gone.mp4',
    local_state: 'unavailable',
  },
  {
    ...linkedVideoEntry,
    file_id: null,
    bundle_id: null,
    linked: false,
    name: 'new.mp4',
    relative_path: 'Movies/new.mp4',
    local_state: 'observed',
  },
]

vi.mock('./FileEntryViewer', () => ({ FileEntryViewer: () => null }))

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

const item = (path: string) => document.querySelector<HTMLElement>(`[data-relpath="${path}"]`)!

beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('badges')
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileBrowser
        libraryName="Media"
        scope="browse"
        path="Movies"
        selectedPath={null}
        onNavigate={() => undefined}
        onSelectEntry={() => undefined}
        playerPrefs={DEFAULT_PLAYER_PREFS}
        onPlayerPrefs={() => undefined}
        onAddToBundle={() => undefined}
        onCreateBundle={() => undefined}
        hostLabels={hostLabelsFor('macos')}
      />
    </QueryClientProvider>,
  )
})

test('list rows show only status badges, never ordinary availability text', () => {
  const grid = screen.getByRole('grid', { name: 'Files' })
  expect(within(grid).queryByText(/Observed|Cataloged|Availability|·/)).toBeNull()
  expect(within(item('Movies/movie.mp4')).queryByText('missing')).toBeNull()
  expect(within(item('Movies/gone.mp4')).getByText('missing')).toHaveAttribute(
    'title',
    'Not found on this device',
  )
  expect(within(item('Movies/new.mp4')).getAllByText(/unlinked/i)).toHaveLength(1)
  // A folder has no catalog identity of its own, so it is never "unlinked"
  expect(within(item('Movies/Folder')).queryByText(/unlinked/i)).toBeNull()
})

test('cards keep one corner badge, with a missing file first', () => {
  fireEvent.click(screen.getByRole('button', { name: 'Card' }))
  expect(within(item('Movies/gone.mp4')).getByText('missing')).toBeVisible()
  expect(within(item('Movies/new.mp4')).getByText('unlinked')).toBeVisible()
  expect(within(item('Movies/movie.mp4')).queryByText(/missing|unlinked/)).toBeNull()
  expect(within(item('Movies/Folder')).queryByText(/missing|unlinked/)).toBeNull()
})
