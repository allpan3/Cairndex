import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { CollectionRead } from '../api/client'
import { CollectionFromFolderDialog } from './CollectionFromFolderDialog'

// "New Collection from Folder…" on a File Browser directory (owner,
// 2026-08-26): name it, choose a parent, and file the folder's bundles in.

const createMutate = vi.fn()
let collections: CollectionRead[] = []
let bundleCount: number | undefined = 3
let counting = false
let createState: { isPending: boolean; isError: boolean; error: unknown } = {
  isPending: false,
  isError: false,
  error: null,
}

vi.mock('../api/hooks', () => ({
  useCollections: () => ({ data: collections }),
  useDirectoryBundleCount: () => ({ data: bundleCount, isLoading: counting }),
  useCreateCollectionFromDirectory: () => ({ mutate: createMutate, ...createState }),
}))

/** The parent rows on screen, in order, as their visible names. */
const parentRows = () =>
  [...document.querySelectorAll('.cff-tree .pick-row__name')].map((e) => e.textContent)

const parentRow = (name: string) =>
  [...document.querySelectorAll('.cff-tree button.pick-row')].find(
    (b) => b.querySelector('.pick-row__name')?.textContent === name,
  ) as HTMLButtonElement

function coll(id: string, name: string, parentId: string | null = null): CollectionRead {
  return { id, name, parent_id: parentId } as CollectionRead
}

function renderDialog(directory = 'Shows/Alpha') {
  const onCreated = vi.fn()
  const onClose = vi.fn()
  render(
    <CollectionFromFolderDialog directory={directory} onClose={onClose} onCreated={onCreated} />,
  )
  return { onCreated, onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  collections = []
  bundleCount = 3
  counting = false
  createState = { isPending: false, isError: false, error: null }
})

test('the folder name is the default, and only the folder name', () => {
  // The default is the leaf, not the path: a collection called
  // "Shows/Alpha" would read as one name containing a slash.
  renderDialog('Shows/Alpha')

  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alpha')
})

test('it says how many bundles will join before anything is created', () => {
  // The same click may file two bundles or two hundred, and only the folder
  // knows which.
  renderDialog()

  expect(screen.getByText(/The 3 bundles in this folder and below join it/)).toBeTruthy()
})

test('a folder with no bundles says the collection starts empty', () => {
  bundleCount = 0
  renderDialog()

  expect(screen.getByText(/the collection starts empty/)).toBeTruthy()
})

test('one bundle is not described in the plural', () => {
  bundleCount = 1
  renderDialog()

  expect(screen.getByText(/The 1 bundle in this folder joins it/)).toBeTruthy()
})

test('the parent list offers the top level and the collection tree', () => {
  collections = [coll('c1', 'Shows'), coll('c2', 'Archive'), coll('c3', 'Nested', 'c1')]
  renderDialog()

  // Depth-first, so a child sits under its parent rather than alphabetically
  // adrift from it. Top level is the default.
  expect(parentRows()).toEqual(['Top level', 'Archive', 'Shows', 'Nested'])
  expect(parentRow('Top level')).toHaveAttribute('aria-checked', 'true')
})

test('a branch folds away its descendants', () => {
  // The reason this is not a native <select>: a long list is only legible when
  // you can close what you are not looking at (owner, 2026-08-28).
  collections = [coll('c1', 'Shows'), coll('c3', 'Nested', 'c1'), coll('c4', 'Deep', 'c3')]
  renderDialog()
  expect(parentRows()).toEqual(['Top level', 'Shows', 'Nested', 'Deep'])

  fireEvent.click(screen.getByRole('button', { name: 'Collapse Shows' }))

  expect(parentRows()).toEqual(['Top level', 'Shows'])
  // And back again, from the same control.
  fireEvent.click(screen.getByRole('button', { name: 'Expand Shows' }))
  expect(parentRows()).toEqual(['Top level', 'Shows', 'Nested', 'Deep'])
})

test('a leaf has no fold control', () => {
  collections = [coll('c1', 'Shows')]
  renderDialog()

  expect(screen.queryByRole('button', { name: /Collapse|Expand/ })).toBeNull()
})

test('searching reaches a match hidden inside a folded branch', () => {
  // Filtering flattens, so the answer the search just found is never behind a
  // fold the user would have to guess at.
  collections = [coll('c1', 'Shows'), coll('c3', 'Nested', 'c1')]
  renderDialog()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Shows' }))
  expect(parentRows()).toEqual(['Top level', 'Shows'])

  fireEvent.change(screen.getByLabelText('Inside'), { target: { value: 'nest' } })

  expect(parentRows()).toEqual(['Top level', 'Nested'])
})

test('a search matching nothing says so, and still offers the top level', () => {
  collections = [coll('c1', 'Shows')]
  renderDialog()

  fireEvent.change(screen.getByLabelText('Inside'), { target: { value: 'zzz' } })

  expect(screen.getByText(/No collection matches/)).toBeTruthy()
  expect(parentRows()).toEqual(['Top level'])
})

test('the rows are radios, because only one parent can be chosen', () => {
  // A tick box reads as "any number of these"; this field means "one of these"
  // (owner, 2026-08-28).
  collections = [coll('c1', 'Shows')]
  renderDialog()

  expect(screen.getByRole('radiogroup', { name: 'Parent collection' })).toBeTruthy()
  expect(screen.getAllByRole('radio')).toHaveLength(2)
})

test('choosing a parent marks it and unmarks the top level', () => {
  collections = [coll('c1', 'Shows')]
  renderDialog()

  fireEvent.click(parentRow('Shows'))

  expect(parentRow('Shows')).toHaveAttribute('aria-checked', 'true')
  expect(parentRow('Top level')).toHaveAttribute('aria-checked', 'false')
})

test('creating sends the folder, the trimmed name, and the chosen parent', () => {
  collections = [coll('c1', 'Shows')]
  renderDialog('Shows/Alpha')

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Alpha Reels  ' } })
  fireEvent.click(parentRow('Shows'))
  fireEvent.click(screen.getByRole('button', { name: 'Create Collection' }))

  expect(createMutate.mock.calls[0]?.[0]).toEqual({
    directory: 'Shows/Alpha',
    name: 'Alpha Reels',
    parent_id: 'c1',
  })
})

test('Enter in the name field creates it too', () => {
  renderDialog()

  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })

  expect(createMutate).toHaveBeenCalledTimes(1)
})

test('an empty name cannot be submitted', () => {
  renderDialog()

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })

  expect(screen.getByRole('button', { name: 'Create Collection' })).toBeDisabled()
  fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Enter' })
  expect(createMutate).not.toHaveBeenCalled()
})

test('a name already taken is reported without closing the dialog', () => {
  // Answered by editing the name; closing would throw away both it and the
  // parent choice.
  createState = {
    isPending: false,
    isError: true,
    error: new Error("a sibling collection named 'Alpha' already exists under this parent"),
  }
  const { onClose } = renderDialog()

  expect(screen.getByRole('alert')).toHaveTextContent(/already exists under this parent/)
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Name')).toBeTruthy()
})

test('the result is handed back once, with what it filed in', async () => {
  const { onCreated } = renderDialog()

  fireEvent.click(screen.getByRole('button', { name: 'Create Collection' }))
  const options = createMutate.mock.calls[0]?.[1] as {
    onSuccess: (r: { collection: CollectionRead; bundles_added: number }) => void
  }
  options.onSuccess({ collection: coll('new', 'Alpha'), bundles_added: 3 })

  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(coll('new', 'Alpha'), 3))
})

test('Escape closes it', () => {
  const { onClose } = renderDialog()

  fireEvent.keyDown(window, { key: 'Escape' })

  expect(onClose).toHaveBeenCalled()
})
