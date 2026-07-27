import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import type { CollectionRead } from '../api/client'
import { Sidebar, type SidebarProps } from './Sidebar'

function collection(id: string, name: string, parentId: string | null = null): CollectionRead {
  return {
    id,
    parent_id: parentId,
    name,
    note: null,
    cover_bundle_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  }
}

const COLLECTIONS = [collection('c1', 'Films'), collection('c2', 'Nested', 'c1')]

/** Render the sidebar with a collection open, capturing create payloads. */
function renderSidebar(
  overrides: {
    collectionId?: string | null
    newCollectionRequest?: { parentId: string | null } | null
    onNewCollectionHandled?: () => void
  } = {},
) {
  return renderSidebarWith(COLLECTIONS, overrides)
}

/** Same, with an explicit collection set. */
function renderSidebarWith(
  collections: CollectionRead[],
  overrides: {
    collectionId?: string | null
    newCollectionRequest?: { parentId: string | null } | null
    onNewCollectionHandled?: () => void
  } = {},
) {
  const onCreateCollection = vi.fn(
    (
      _payload: { name: string; parent_id: string | null },
      callbacks: { onSuccess: (created: CollectionRead) => void; onError: (err: unknown) => void },
    ) => callbacks.onSuccess(collection('new', 'New Collection')),
  )
  render(
    <Sidebar
      mode="collection"
      onMode={() => undefined}
      libraries={[]}
      libraryId="lib1"
      onChangeLibrary={() => undefined}
      onManageLibraries={() => undefined}
      onOpenSettings={() => undefined}
      onUpdateLibrary={() => undefined}
      onScanFiles={() => undefined}
      onProbe={() => undefined}
      onGenerateStoryboards={() => undefined}
      onReviewGrouping={() => undefined}
      selection={{
        view: 'all',
        collectionId: overrides.collectionId ?? 'c1',
      }}
      onSelect={() => undefined}
      collections={collections}
      onDeleteCollection={() => undefined}
      onCreateCollection={onCreateCollection}
      onRenameCollection={() => undefined}
      onReorderCollections={() => undefined}
      onCleanupCollections={() => undefined}
      newCollectionRequest={overrides.newCollectionRequest ?? null}
      onNewCollectionHandled={overrides.onNewCollectionHandled}
      smartCollections={[]}
      onNewSmartCollection={() => undefined}
      onEditSmartCollection={() => undefined}
      onDeleteSmartCollection={() => undefined}
    />,
  )
  return onCreateCollection
}

/** Sidebar with a caller-controlled pending request and no clear callback. */
function RequestHarness({
  request,
  collections,
  onCreateCollection,
}: {
  request: { parentId: string | null } | null
  collections: CollectionRead[]
  onCreateCollection: SidebarProps['onCreateCollection']
}) {
  return (
    <Sidebar
      mode="collection"
      onMode={() => undefined}
      libraries={[]}
      libraryId="lib1"
      onChangeLibrary={() => undefined}
      onManageLibraries={() => undefined}
      onOpenSettings={() => undefined}
      onUpdateLibrary={() => undefined}
      onScanFiles={() => undefined}
      onProbe={() => undefined}
      onGenerateStoryboards={() => undefined}
      onReviewGrouping={() => undefined}
      selection={{ view: 'all', collectionId: null }}
      onSelect={() => undefined}
      collections={collections}
      onDeleteCollection={() => undefined}
      onCreateCollection={onCreateCollection}
      onRenameCollection={() => undefined}
      onReorderCollections={() => undefined}
      newCollectionRequest={request}
      smartCollections={[]}
      onNewSmartCollection={() => undefined}
      onEditSmartCollection={() => undefined}
      onDeleteSmartCollection={() => undefined}
    />
  )
}

/**
 * Sidebar over a live collection list, so a created collection actually appears
 * in the tree the way a refetch would deliver it. The mocks elsewhere in this
 * file answer `onSuccess` without adding the row, which is enough to assert a
 * payload but not to see what the user sees next.
 */
function StatefulHarness({ request = null }: { request?: { parentId: string | null } | null }) {
  const [collections, setCollections] = useState<CollectionRead[]>(COLLECTIONS)
  const onCreateCollection: SidebarProps['onCreateCollection'] = (payload, callbacks) => {
    const created = collection('cNew', payload.name, payload.parent_id)
    setCollections((previous) => [...previous, created])
    callbacks.onSuccess(created)
  }
  return (
    <Sidebar
      mode="collection"
      onMode={() => undefined}
      libraries={[]}
      libraryId="lib1"
      onChangeLibrary={() => undefined}
      onManageLibraries={() => undefined}
      onOpenSettings={() => undefined}
      onUpdateLibrary={() => undefined}
      onScanFiles={() => undefined}
      onProbe={() => undefined}
      onGenerateStoryboards={() => undefined}
      onReviewGrouping={() => undefined}
      selection={{ view: 'all', collectionId: 'c1' }}
      onSelect={() => undefined}
      collections={collections}
      onDeleteCollection={() => undefined}
      onCreateCollection={onCreateCollection}
      onRenameCollection={() => undefined}
      onReorderCollections={() => undefined}
      newCollectionRequest={request}
      smartCollections={[]}
      onNewSmartCollection={() => undefined}
      onEditSmartCollection={() => undefined}
      onDeleteSmartCollection={() => undefined}
    />
  )
}

afterEach(() => vi.restoreAllMocks())

test('a created collection lands in the rename box ready to be named', () => {
  render(<StatefulHarness />)
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'New collection' }))

  // The name is a placeholder, so the point of creating one is typing over it.
  const input = screen.getByRole('textbox')
  expect(input).toHaveValue('New Collection')
})

test('a collection created from the grid also lands in the rename box', () => {
  // The grid and the native menu deliver a parent rather than a click, and the
  // user is not looking at the sidebar — so the row still has to open for typing.
  render(<StatefulHarness request={{ parentId: 'c1' }} />)

  expect(screen.getByRole('textbox')).toHaveValue('New Collection')
})

test('the + button creates at the top level even with a collection open', () => {
  const onCreateCollection = renderSidebar({ collectionId: 'c1' })

  fireEvent.click(screen.getByRole('button', { name: 'New collection' }))

  // The reported bug: this used to nest under whatever was selected, leaving no
  // way to ask for a top-level collection while browsing one.
  expect(onCreateCollection).toHaveBeenCalledOnce()
  expect(onCreateCollection.mock.calls[0]?.[0]).toEqual({
    name: 'New Collection',
    parent_id: null,
  })
})

test('right-clicking a collection offers a subcollection under it', () => {
  const onCreateCollection = renderSidebar()

  fireEvent.contextMenu(screen.getByText('Films'))
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Subcollection' }))

  expect(onCreateCollection.mock.calls[0]?.[0]).toEqual({
    name: 'New Collection',
    parent_id: 'c1',
  })
})

test('right-clicking the Collections heading offers a top-level collection', () => {
  const onCreateCollection = renderSidebar()

  fireEvent.contextMenu(screen.getByText('Collections'))
  expect(screen.getByRole('menuitem', { name: 'Clean Up Order…' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Collection' }))

  expect(onCreateCollection.mock.calls[0]?.[0]).toEqual({
    name: 'New Collection',
    parent_id: null,
  })
})

test('a request from outside the sidebar creates and is cleared once', () => {
  const onNewCollectionHandled = vi.fn()
  const onCreateCollection = renderSidebar({
    newCollectionRequest: { parentId: null },
    onNewCollectionHandled,
  })

  // The grid menu and the native File menu both arrive this way.
  expect(onCreateCollection).toHaveBeenCalledOnce()
  expect(onCreateCollection.mock.calls[0]?.[0]).toEqual({
    name: 'New Collection',
    parent_id: null,
  })
  expect(onNewCollectionHandled).toHaveBeenCalledOnce()
})

test('the same request is consumed once even if the caller never clears it', () => {
  // Creating a collection refetches the list, which changes the create helper's
  // identity and re-runs the effect. Without identity tracking that would create
  // in a loop for any caller that forgot the clear callback.
  const onCreateCollection = vi.fn(
    (
      _payload: { name: string; parent_id: string | null },
      callbacks: { onSuccess: (created: CollectionRead) => void; onError: (err: unknown) => void },
    ) => callbacks.onSuccess(collection('new', 'New Collection')),
  )
  const request = { parentId: null }
  const props = { request, onCreateCollection }

  const { rerender } = render(<RequestHarness {...props} collections={COLLECTIONS} />)
  expect(onCreateCollection).toHaveBeenCalledOnce()

  // A refetch delivers a new collections array — same pending request object.
  rerender(<RequestHarness {...props} collections={[...COLLECTIONS, collection('c3', 'More')]} />)
  expect(onCreateCollection).toHaveBeenCalledOnce()
})

test('creating unfolds the Collections section so the rename box is visible', () => {
  // A folded section hides the new row entirely, which would leave a collection
  // named 'New Collection' and no visible way to type the name that was the
  // point of creating it — most likely when the request came from the grid, where
  // the user is not even looking at the sidebar.
  const onCreateCollection = renderSidebar()
  const heading = screen.getByRole('button', { name: /^Collections/ })

  fireEvent.click(heading)
  expect(screen.queryByText('Films')).not.toBeInTheDocument()

  fireEvent.contextMenu(heading)
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Collection' }))

  expect(onCreateCollection).toHaveBeenCalledOnce()
  expect(screen.getByText('Films')).toBeInTheDocument()
})

test('a new name avoids colliding with its own siblings only', () => {
  // A top-level 'New Collection' already exists, and one under c1 as well, so the
  // suffix must count per parent rather than library-wide.
  const onCreateCollection = renderSidebarWith([
    collection('c1', 'Films'),
    collection('c9', 'New Collection'),
  ])

  fireEvent.click(screen.getByRole('button', { name: 'New collection' }))
  expect(onCreateCollection.mock.calls[0]?.[0].name).toBe('New Collection 2')

  // The same default is still free inside Films.
  fireEvent.contextMenu(screen.getByText('Films'))
  fireEvent.click(screen.getByRole('menuitem', { name: 'New Subcollection' }))
  expect(onCreateCollection.mock.calls[1]?.[0]).toEqual({
    name: 'New Collection',
    parent_id: 'c1',
  })
})
