import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { setActiveLibraryId } from '../api/client'
import { CatalogBundleBrowser } from './CatalogBundleBrowser'
import { emptyAdHocFilters } from './adHocFilters'
import type { CatalogCollections } from './useCatalogCollections'

const fixture = vi.hoisted(() => ({
  browseVersion: 18,
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 40,
        size: 40,
      })),
    measure: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}))

vi.mock('../api/useReplicaStatus', () => ({
  useReplicaStatus: () => ({
    data: {
      browse_version: fixture.browseVersion,
      selection_version: 2,
      album_version: 2,
      inspector_version: 2,
    },
  }),
}))

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
}))

vi.mock('./CatalogBundleAlbum', () => ({
  CatalogBundleAlbum: ({ bundle, onBack }: { bundle: string; onBack: () => void }) => (
    <div role="region" aria-label="Mock bundle album">
      <span>{bundle}</span>
      <button onClick={onBack}>Back to library</button>
    </div>
  ),
}))

vi.mock('./CatalogBundleInspector', () => ({
  CatalogBundleInspector: () => <aside className="inspector" aria-label="Bundle inspector" />,
}))
vi.mock('./CatalogMultiBundleInspector', () => ({
  CatalogMultiBundleInspector: () => <aside className="inspector" />,
}))
vi.mock('./CatalogCollectionInspector', () => ({
  CatalogCollectionInspector: () => <aside className="inspector" />,
}))
vi.mock('./CatalogBundleMoments', () => ({
  CatalogBundleMoments: () => null,
}))

const collections: CatalogCollections = {
  items: [],
  error: null,
  retry: vi.fn(),
  refresh: vi.fn(async () => {}),
  run: vi.fn(),
  arrange: vi.fn(),
  moveBundlesInto: vi.fn(),
  removeBundlesFromOpen: vi.fn(),
  leaving: new Set(),
  requestDelete: vi.fn(),
  requestCleanup: vi.fn(),
  dialogs: null,
}

beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('library')
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  fixture.browseVersion = 18
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation(async (_library, path) => {
      if (path === '/bundles/browse') {
        return {
          total: 2,
          offset: 0,
          limit: 50,
          items: [
            {
              id: 'bundle-1',
              title: 'First bundle',
              file_count: 3,
              rating: 0,
              cover_file_id: null,
              date_added: '2026-01-01T00:00:00Z',
            },
            {
              id: 'bundle-2',
              title: 'Second bundle',
              file_count: 1,
              rating: 0,
              cover_file_id: null,
              date_added: '2026-01-02T00:00:00Z',
            },
          ],
        } as never
      }
      if (path.startsWith('/entities/asset_bundles/')) {
        const id = path.split('/').at(-1)!
        return {
          family: 'asset_bundles',
          id,
          fields: {
            $alive: { unit: `asset_bundles/${id}/$alive`, value: 'true', basis: ['r1'] },
            title: { unit: `asset_bundles/${id}/title`, value: '"First bundle"', basis: ['r1'] },
          },
          observed: {},
          parents: ['r1'],
          has_conflicts: false,
        } as never
      }
      return { items: [] } as never
    })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function setup({ albumEnabled = true }: { albumEnabled?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <CatalogBundleBrowser
        library="library"
        locateRequest={0}
        selection={{ view: 'all', collectionId: null, smartCollectionId: null }}
        filters={emptyAdHocFilters()}
        onFilters={vi.fn()}
        editor="editor-1"
        inspectorEnabled
        albumEnabled={albumEnabled}
        selectionEnabled
        systemViewsEnabled
        blocked={false}
        selected={null}
        onSelect={vi.fn()}
        onReview={vi.fn()}
        onOpen={vi.fn()}
        onOpenFile={vi.fn()}
        collections={collections}
        showSubContents={false}
        onShowSubContents={vi.fn()}
        onOpenCollection={vi.fn()}
        onRenameCollection={vi.fn()}
        dragItem={null}
        onDragItem={vi.fn()}
        bundleMovesEnabled
        onNotice={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

test('Cmd+Down on Mac and Alt+Down on non-Mac opens the selected single bundle album and returns cleanly', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  const macView = setup({ albumEnabled: true })
  const firstRow = await screen.findByText('First bundle')
  const card = firstRow.closest<HTMLElement>('[data-bundle-id="bundle-1"]')!
  fireEvent.click(card)
  card.focus()

  // Non-shortcut Alt+Down on Mac does not open album (instead navigating down in grid)
  fireEvent.keyDown(card, { key: 'ArrowDown', altKey: true })
  expect(screen.queryByRole('region', { name: 'Mock bundle album' })).not.toBeInTheDocument()

  // Reselect first bundle and press Cmd+Down to open album on Mac
  fireEvent.click(card)
  fireEvent.keyDown(card, { key: 'ArrowDown', metaKey: true })
  const album = await screen.findByRole('region', { name: 'Mock bundle album' })
  expect(album).toHaveTextContent('bundle-1')

  // Multi-selection ignores Cmd+Down after returning
  fireEvent.click(screen.getByRole('button', { name: 'Back to library' }))
  expect(screen.queryByRole('region', { name: 'Mock bundle album' })).not.toBeInTheDocument()
  const secondCard = screen
    .getByText('Second bundle')
    .closest<HTMLElement>('[data-bundle-id="bundle-2"]')!
  fireEvent.click(secondCard, { metaKey: true })
  fireEvent.keyDown(secondCard, { key: 'ArrowDown', metaKey: true })
  expect(screen.queryByRole('region', { name: 'Mock bundle album' })).not.toBeInTheDocument()
  macView.unmount()

  // Non-Mac uses Alt+Down
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
  const linuxView = setup({ albumEnabled: true })
  const linuxCard = (await screen.findByText('First bundle')).closest<HTMLElement>(
    '[data-bundle-id="bundle-1"]',
  )!
  fireEvent.click(linuxCard)
  fireEvent.keyDown(linuxCard, { key: 'ArrowDown', metaKey: true })
  expect(screen.queryByRole('region', { name: 'Mock bundle album' })).not.toBeInTheDocument()
  // Reselect single bundle first (Meta+ArrowDown on Linux acts as a modifier key)
  fireEvent.click(linuxCard)
  fireEvent.keyDown(linuxCard, { key: 'ArrowDown', altKey: true })
  expect(await screen.findByRole('region', { name: 'Mock bundle album' })).toHaveTextContent(
    'bundle-1',
  )
  linuxView.unmount()

  // Disabled albumEnabled never opens album
  setup({ albumEnabled: false })
  const disabledCard = (await screen.findByText('First bundle')).closest<HTMLElement>(
    '[data-bundle-id="bundle-1"]',
  )!
  fireEvent.click(disabledCard)
  fireEvent.keyDown(disabledCard, { key: 'ArrowDown', altKey: true })
  expect(screen.queryByRole('region', { name: 'Mock bundle album' })).not.toBeInTheDocument()
})

test('Toolbar Starred files chip is passed only when browse_version >= 18', async () => {
  fixture.browseVersion = 17
  const oldServer = setup()
  await screen.findByText('First bundle')
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  expect(screen.queryByRole('button', { name: 'Filter by starred files' })).not.toBeInTheDocument()
  oldServer.unmount()

  fixture.browseVersion = 18
  setup()
  await screen.findByText('First bundle')
  fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Filter by starred files' })).toBeInTheDocument(),
  )
})
