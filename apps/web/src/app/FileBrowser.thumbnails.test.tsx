import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { FileBrowserEntry } from '../api/client'
import { setActiveLibraryId } from '../api/client'
import { hostLabelsFor } from '../platform'
import { FileBrowser } from './FileBrowser'
import { linkedVideoEntry } from './testFixtures'
import { DEFAULT_PLAYER_PREFS } from './types'

const entries: FileBrowserEntry[] = [
  // Indexed video: the server can extract a frame for it.
  linkedVideoEntry,
  // Indexed image, e.g. everything in the Unbundled queue.
  {
    ...linkedVideoEntry,
    name: 'poster.jpg',
    relative_path: 'Movies/poster.jpg',
    media_kind: 'image',
    mime_type: 'image/jpeg',
    extension: 'jpg',
    file_id: 'file-img',
    bundle_id: 'bundle-two',
    duration: null,
  },
  // Never indexed, so no file row — but its bytes are readable by path.
  {
    ...linkedVideoEntry,
    name: 'loose.png',
    relative_path: 'Movies/loose.png',
    media_kind: 'image',
    mime_type: 'image/png',
    extension: 'png',
    file_id: null,
    bundle_id: null,
    linked: false,
    duration: null,
  },
  // Neither indexed nor previewable: an icon is the only honest answer.
  {
    ...linkedVideoEntry,
    name: 'notes.srt',
    relative_path: 'Movies/notes.srt',
    media_kind: 'subtitle',
    mime_type: null,
    extension: 'srt',
    file_id: null,
    bundle_id: null,
    linked: false,
    supported: false,
    duration: null,
  },
  {
    ...linkedVideoEntry,
    name: 'Extras',
    relative_path: 'Movies/Extras',
    kind: 'directory',
    media_kind: null,
    file_id: null,
    bundle_id: null,
    size_bytes: null,
    duration: null,
  },
]

vi.mock('../api/hooks', () => ({
  useFileBrowser: () => ({
    data: { entries, missing_files_updated: 0, path: 'Movies' },
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
  useFileOperations: () => ({
    rename: { mutate: vi.fn(), isPending: false },
    mkdir: { mutate: vi.fn(), isPending: false },
    undo: { mutate: vi.fn(), isPending: false },
    trash: { mutate: vi.fn(), isPending: false },
    move: { mutate: vi.fn(), isPending: false },
    importOne: { mutateAsync: vi.fn(), isPending: false },
  }),
}))

beforeEach(() => {
  setActiveLibraryId('lib1')
  window.localStorage?.clear?.()
})

afterEach(() => {
  setActiveLibraryId(null)
  vi.restoreAllMocks()
})

function renderBrowser() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <FileBrowser
        libraryName="Media"
        scope="browse"
        path="Movies"
        selectedPath={null}
        onNavigate={() => undefined}
        onSelectEntry={() => undefined}
        onAddToBundle={() => undefined}
        onCreateBundle={() => undefined}
        hostLabels={hostLabelsFor('macos')}
        playerPrefs={DEFAULT_PLAYER_PREFS}
        onPlayerPrefs={() => undefined}
      />
    </QueryClientProvider>,
  )
}

/** The thumbnail `<img>` rendered inside a row, or null when it fell back. */
function thumbSrcFor(name: string): string | null {
  const row = screen.getByText(name).closest('.file-row')
  return row?.querySelector('img')?.getAttribute('src') ?? null
}

test('an indexed file shows the thumbnail its file row can produce', () => {
  renderBrowser()

  // A video's still is a frame the server extracts — the reason the Unbundled
  // queue was a wall of identical icons is that nothing asked for it.
  expect(thumbSrcFor('movie.mp4')).toContain('/bundles/bundle-one/files/file-one/thumbnail')
  expect(thumbSrcFor('poster.jpg')).toContain('/bundles/bundle-two/files/file-img/thumbnail')
})

test('an unindexed image falls back to its path-scoped preview', () => {
  renderBrowser()

  // No file row to hang a thumbnail on, but the bytes are readable by path.
  const src = thumbSrcFor('loose.png')
  expect(src).toContain('/file/preview')
  expect(src).toContain('path=Movies%2Floose.png')
})

test('entries with no possible still keep their icon', () => {
  renderBrowser()

  // A subtitle has no image, and a directory is not a file — an icon is the
  // honest answer rather than a broken image.
  expect(thumbSrcFor('notes.srt')).toBeNull()
  expect(thumbSrcFor('Extras')).toBeNull()
})
