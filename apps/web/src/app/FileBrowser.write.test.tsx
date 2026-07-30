import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { PathConflictError, type FileBrowserEntry } from '../api/client'
import { hostLabelsFor } from '../platform'
import { FileBrowser } from './FileBrowser'
import { DEFAULT_PLAYER_PREFS } from './types'

// The File Browser's write affordances (ADR-0013 W1): inline rename, New
// Folder, the collision prompt, and the Undo a completed operation offers.
// Everything below the hook is mocked — what matters here is the interaction,
// and the operations themselves are covered by the server's own tests.

const rename = vi.fn()
const mkdir = vi.fn()
const undo = vi.fn()
const trashMutate = vi.fn()
const moveMutate = vi.fn()
const importOne = vi.fn()

const FOLDER: FileBrowserEntry = {
  name: 'Season 1',
  relative_path: 'Show/Season 1',
  kind: 'directory',
  size_bytes: null,
  modified_at: null,
  created_at: null,
  extension: null,
  mime_type: null,
  media_kind: null,
  supported: false,
  linked: false,
  bundle_id: null,
  file_id: null,
  container: null,
  video_codec: null,
  video_codec_tag: null,
  audio_codec: null,
  duration: null,
  resume_position: null,
  unbundled: false,
}

const FILE: FileBrowserEntry = {
  ...FOLDER,
  name: 'ep1.mkv',
  relative_path: 'Show/ep1.mkv',
  kind: 'file',
  extension: 'mkv',
  media_kind: 'video',
  supported: true,
  linked: true,
}

vi.mock('../api/hooks', () => ({
  useFileBrowser: () => ({
    data: { entries: [FOLDER, FILE], missing_files_updated: 0, path: 'Show' },
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
    rename: { mutate: rename, isPending: false },
    mkdir: { mutate: mkdir, isPending: false },
    undo: { mutate: undo, isPending: false },
    trash: { mutate: trashMutate, isPending: false },
    move: { mutate: moveMutate, isPending: false },
    importOne: { mutateAsync: importOne, isPending: false },
  }),
}))

let flashes: { message: string; undo?: () => void }[]

function renderBrowser(writeMode = true) {
  flashes = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <FileBrowser
        libraryName="Media"
        scope="browse"
        path="Show"
        selectedPath={null}
        onNavigate={() => undefined}
        onSelectEntry={() => undefined}
        playerPrefs={DEFAULT_PLAYER_PREFS}
        onPlayerPrefs={() => undefined}
        onAddToBundle={() => undefined}
        onCreateBundle={() => undefined}
        hostLabels={hostLabelsFor('macos')}
        writeMode={writeMode}
        onFlash={(message, undoAction) => flashes.push({ message, undo: undoAction })}
      />
    </QueryClientProvider>,
  )
}

const row = (name: string) => screen.getByText(name).closest('[data-relpath]') as HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
})

test('a read-only library looks exactly as it did before write mode existed', () => {
  renderBrowser(false)

  expect(screen.queryByRole('button', { name: 'New Folder' })).toBeNull()

  fireEvent.contextMenu(row('Season 1'))
  // A directory's context menu only exists because Rename does; without write
  // mode there is nothing to put in it.
  expect(screen.queryByText('Rename…')).toBeNull()
})

test('renaming a file sends the new name and offers to undo it', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Rename…'))

  const field = screen.getByLabelText('Rename ep1.mkv')
  fireEvent.change(field, { target: { value: 'Episode 1.mkv' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  expect(rename).toHaveBeenCalledWith(
    { path: 'Show/ep1.mkv', newName: 'Episode 1.mkv', onConflict: undefined },
    expect.anything(),
  )

  // Report what the server settled on, and hand back its inverse.
  const handlers = rename.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }
  handlers.onSuccess({
    path: 'Show/Episode 1.mkv',
    operation: { id: 'op-1' },
    files_updated: 1,
    skipped: false,
  })

  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Renamed to “Episode 1.mkv”.')
  flashes[0]?.undo?.()
  expect(undo).toHaveBeenCalledWith('op-1', expect.anything())
})

test('a rename box opens focused with the stem selected, and re-asserts it', async () => {
  // Renaming rarely retypes the type. Asserting the selection once on focus was
  // not enough: WebKit can settle its own double-click selection on the newly
  // focused input afterwards, which selected the extension in the desktop shell
  // and not in a browser (owner report, 2026-07-30). So it is asserted again on
  // the next frame — the property tested here is that a later frame does not
  // undo it.
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Rename…'))

  const field = screen.getByLabelText('Rename ep1.mkv') as HTMLInputElement
  expect(document.activeElement).toBe(field)
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'ep1'.length])

  // Whatever the engine did in between, the stem is still what is selected.
  field.setSelectionRange(0, field.value.length)
  await waitFor(() => expect(field.selectionEnd).toBe('ep1'.length))
})

test('a name with no extension is selected whole', () => {
  renderBrowser()

  fireEvent.contextMenu(row('Season 1'))
  fireEvent.click(screen.getByText('Rename…'))

  const field = screen.getByLabelText('Rename Season 1') as HTMLInputElement
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'Season 1'.length])
})

test('Escape abandons a rename without sending anything', () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Rename…'))
  const field = screen.getByLabelText('Rename ep1.mkv')
  fireEvent.change(field, { target: { value: 'oops.mkv' } })
  fireEvent.keyDown(field, { key: 'Escape' })

  expect(rename).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Rename ep1.mkv')).toBeNull()
})

test('an unchanged name is not a rename', () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Rename…'))
  fireEvent.keyDown(screen.getByLabelText('Rename ep1.mkv'), { key: 'Enter' })

  expect(rename).not.toHaveBeenCalled()
})

test('directories can be renamed too', () => {
  renderBrowser()

  fireEvent.contextMenu(row('Season 1'))
  fireEvent.click(screen.getByText('Rename…'))
  const field = screen.getByLabelText('Rename Season 1')
  fireEvent.change(field, { target: { value: 'Series 1' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  expect(rename).toHaveBeenCalledWith(
    { path: 'Show/Season 1', newName: 'Series 1', onConflict: undefined },
    expect.anything(),
  )
})

test('a collision asks instead of failing, and keeping both re-issues the rename', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Rename…'))
  const field = screen.getByLabelText('Rename ep1.mkv')
  fireEvent.change(field, { target: { value: 'ep2.mkv' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  const handlers = rename.mock.calls[0]?.[1] as { onError: (failure: unknown) => void }
  handlers.onError(new PathConflictError('exists', 'ep2.mkv', 'Show/ep2.mkv'))

  const dialog = await screen.findByRole('dialog', { name: 'Name already in use' })
  expect(dialog).toHaveTextContent('“ep2.mkv” already exists here')
  // The point of the default policy: the file has not moved while we ask.
  expect(rename).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Keep both' }))

  expect(rename).toHaveBeenNthCalledWith(
    2,
    { path: 'Show/ep1.mkv', newName: 'ep2.mkv', onConflict: 'suffix' },
    expect.anything(),
  )

  const second = rename.mock.calls[1]?.[1] as { onSuccess: (result: unknown) => void }
  second.onSuccess({
    path: 'Show/ep2 (2).mkv',
    operation: { id: 'op-2' },
    files_updated: 1,
    skipped: false,
  })

  // The toast names what it *landed on*, not what was asked for.
  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Renamed to “ep2 (2).mkv” to keep both.')
})

test('New Folder creates it inside the directory being browsed', async () => {
  renderBrowser()

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  const field = screen.getByLabelText('New folder name')
  fireEvent.change(field, { target: { value: 'Extras' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  expect(mkdir).toHaveBeenCalledWith('Show/Extras', expect.anything())

  const handlers = mkdir.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }
  handlers.onSuccess({ path: 'Show/Extras', operation: { id: 'op-3' }, files_updated: 0 })

  await waitFor(() => expect(flashes[0]?.message).toBe('Created “Extras”.'))
  flashes[0]?.undo?.()
  expect(undo).toHaveBeenCalledWith('op-3', expect.anything())
})

test('a failed operation reports the reason and offers no undo', async () => {
  renderBrowser()

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  fireEvent.keyDown(screen.getByLabelText('New folder name'), { key: 'Enter' })

  const handlers = mkdir.mock.calls[0]?.[1] as { onError: (failure: unknown) => void }
  handlers.onError(new Error('Write mode is off for this library.'))

  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Write mode is off for this library.')
  expect(flashes[0]?.undo).toBeUndefined()
})

// --- trash (ADR-0013 §3.2) ---------------------------------------------------

test('deleting says where the files go, and names the bundle impact', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Move to Trash'))

  const dialog = await screen.findByRole('dialog', { name: 'Move to Trash' })
  // The honest thing to confirm is *where it goes*, not "are you sure".
  expect(dialog).toHaveTextContent('can be put back until you empty it')
  // ep1.mkv is linked, so the bundle consequence is stated rather than implied.
  expect(dialog).toHaveTextContent('part of a bundle')
  expect(trashMutate).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))

  expect(trashMutate).toHaveBeenCalledWith(['Show/ep1.mkv'], expect.anything())
  const handlers = trashMutate.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }
  handlers.onSuccess({ path: 'Show/ep1.mkv', operation: { id: 'op-9' }, files_updated: 1 })

  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Moved “ep1.mkv” to the trash.')
  // A deletion is undoable like everything else — the toast is where that shows.
  flashes[0]?.undo?.()
  expect(undo).toHaveBeenCalledWith('op-9', expect.anything())
})

test('cancelling a delete sends nothing', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Move to Trash'))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

  expect(trashMutate).not.toHaveBeenCalled()
})

test('a folder is deleted whole, in one operation', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('Season 1'))
  fireEvent.click(screen.getByText('Move to Trash'))
  fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }))

  expect(trashMutate).toHaveBeenCalledWith(['Show/Season 1'], expect.anything())
})

test('Replace is offered, and says it is recoverable', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Rename…'))
  const field = screen.getByLabelText('Rename ep1.mkv')
  fireEvent.change(field, { target: { value: 'ep2.mkv' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  const handlers = rename.mock.calls[0]?.[1] as { onError: (failure: unknown) => void }
  handlers.onError(new PathConflictError('exists', 'ep2.mkv', 'Show/ep2.mkv'))

  const dialog = await screen.findByRole('dialog', { name: 'Name already in use' })
  // The word "Replace" is only honest because of what the sentence promises.
  expect(dialog).toHaveTextContent('moves the existing file to this library’s trash first')

  fireEvent.click(screen.getByRole('button', { name: 'Replace' }))

  expect(rename).toHaveBeenNthCalledWith(
    2,
    { path: 'Show/ep1.mkv', newName: 'ep2.mkv', onConflict: 'replace' },
    expect.anything(),
  )

  const second = rename.mock.calls[1]?.[1] as { onSuccess: (result: unknown) => void }
  second.onSuccess({
    path: 'Show/ep2.mkv',
    operation: { id: 'op-4' },
    files_updated: 1,
    skipped: false,
  })

  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Replaced “ep2.mkv”. The old file is in the trash.')
})

test('a read-only library offers no delete', () => {
  renderBrowser(false)

  fireEvent.contextMenu(row('ep1.mkv'))

  expect(screen.queryByText('Move to Trash')).toBeNull()
})

// --- import (ADR-0013 §7) ----------------------------------------------------

const dropFiles = (...files: File[]) => {
  const body = document.querySelector('.file-browser__body') as HTMLElement
  const dataTransfer = { types: ['Files'], files, dropEffect: '' }
  fireEvent.dragOver(body, { dataTransfer })
  fireEvent.drop(body, { dataTransfer })
}

test('dropping files copies them into the folder being browsed', async () => {
  importOne.mockResolvedValue({
    path: 'Show/clip.mkv',
    operation: { id: 'op-imp' },
    files_updated: 1,
    skipped: false,
    size_bytes: 4,
  })
  renderBrowser()

  dropFiles(new File(['data'], 'clip.mkv'))

  await waitFor(() => expect(importOne).toHaveBeenCalled())
  const call = importOne.mock.calls[0]?.[0] as { file: File; destDir: string }
  expect(call.file.name).toBe('clip.mkv')
  // The destination is the directory on screen, not the library root.
  expect(call.destDir).toBe('Show')

  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Copied “clip.mkv” into the library.')
  // An import is undoable like everything else.
  flashes[0]?.undo?.()
  expect(undo).toHaveBeenCalledWith('op-imp', expect.anything())
})

test('files are uploaded one at a time, not six at once', async () => {
  let resolveFirst: ((value: unknown) => void) | undefined
  importOne
    .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
    .mockResolvedValue({
      path: 'Show/b.mkv',
      operation: { id: 'op-2' },
      files_updated: 1,
      skipped: false,
      size_bytes: 1,
    })
  renderBrowser()

  dropFiles(new File(['a'], 'a.mkv'), new File(['b'], 'b.mkv'))

  // The second has not started while the first is still in flight — otherwise
  // they split the same bandwidth and everything finishes late.
  await waitFor(() => expect(importOne).toHaveBeenCalledTimes(1))
  // The copy-in indicator names the current file and its place in the batch.
  expect(await screen.findByText(/a\.mkv/)).toBeInTheDocument()
  expect(screen.getByText('1 of 2')).toBeInTheDocument()

  resolveFirst?.({
    path: 'Show/a.mkv',
    operation: { id: 'op-1' },
    files_updated: 1,
    skipped: false,
    size_bytes: 1,
  })

  await waitFor(() => expect(importOne).toHaveBeenCalledTimes(2))
})

test('a collision during an import asks, then resumes the rest of the batch', async () => {
  importOne
    .mockRejectedValueOnce(new PathConflictError('exists', 'a.mkv', 'Show/a.mkv'))
    .mockResolvedValue({
      path: 'Show/a (2).mkv',
      operation: { id: 'op-1' },
      files_updated: 1,
      skipped: false,
      size_bytes: 1,
    })
  renderBrowser()

  dropFiles(new File(['a'], 'a.mkv'), new File(['b'], 'b.mkv'))

  const dialog = await screen.findByRole('dialog', { name: 'Name already in use' })
  expect(dialog).toHaveTextContent('“a.mkv” already exists here')
  // The second file has not been sent — answering resumes the batch rather
  // than abandoning everything after the collision.
  expect(importOne).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Keep both' }))

  await waitFor(() => expect(importOne).toHaveBeenCalledTimes(3))
  const retried = importOne.mock.calls[1]?.[0] as { file: File; onConflict?: string }
  expect(retried.file.name).toBe('a.mkv')
  expect(retried.onConflict).toBe('suffix')
  // …and the untouched remainder goes back to asking, rather than inheriting
  // an answer that was about a different file.
  const resumed = importOne.mock.calls[2]?.[0] as { file: File; onConflict?: string }
  expect(resumed.file.name).toBe('b.mkv')
  expect(resumed.onConflict).toBeUndefined()
})

test('a read-only library has no way to copy files in', () => {
  renderBrowser(false)

  expect(screen.queryByRole('button', { name: 'Add Files…' })).toBeNull()
  dropFiles(new File(['x'], 'x.mkv'))
  expect(importOne).not.toHaveBeenCalled()
})

test('a partly failed delete reports what it could not take', async () => {
  renderBrowser()

  // Two items selected, because a single-item delete that fails is an error
  // rather than a partial success — only a batch can half-succeed.
  fireEvent.click(row('Season 1'))
  fireEvent.click(row('ep1.mkv'), { metaKey: true })
  fireEvent.keyDown(document.querySelector('.file-browser__body') as HTMLElement, {
    key: 'Delete',
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Move to Trash' }))

  const handlers = trashMutate.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }
  handlers.onSuccess({
    path: 'Show/ep1.mkv',
    operation: { id: 'op-p' },
    files_updated: 1,
    failed_paths: ['Show/locked.mkv'],
  })

  // A partial failure is still a success for what moved — and says which item
  // stayed put, rather than an error that leaves the owner guessing.
  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Moved “ep1.mkv” to the trash. “locked.mkv” could not be moved.')
  expect(flashes[0]?.undo).toBeDefined()
})

test('Move to… picks a destination folder and reports where it landed', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Move to…'))

  const dialog = await screen.findByRole('dialog', { name: 'Move to' })
  // Descend into a real folder from the library's own tree, then commit.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Season 1' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move here' }))

  expect(moveMutate).toHaveBeenCalledWith(
    { paths: ['Show/ep1.mkv'], destDir: 'Show/Season 1', onConflict: undefined },
    expect.anything(),
  )

  const handlers = moveMutate.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }
  handlers.onSuccess({
    path: 'Show/Season 1/ep1.mkv',
    operation: { id: 'op-m' },
    files_updated: 1,
    skipped: false,
    failed_paths: [],
  })

  await waitFor(() => expect(flashes).toHaveLength(1))
  // The toast names the folder it landed in, and a move is undoable.
  expect(flashes[0]?.message).toBe('Moved “ep1.mkv” to “Season 1”.')
  flashes[0]?.undo?.()
  expect(undo).toHaveBeenCalledWith('op-m', expect.anything())
})

test('a folder cannot be moved into itself, so the picker never offers it', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('Season 1'))
  fireEvent.click(screen.getByText('Move to…'))

  const dialog = await screen.findByRole('dialog', { name: 'Move to' })
  // The only folder in the tree is the one being moved, so there is nowhere to
  // descend — the library root is the one place left to put it.
  expect(within(dialog).queryByRole('button', { name: 'Season 1' })).toBeNull()
  expect(dialog).toHaveTextContent('No subfolders here')

  fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Library root' }))

  expect(moveMutate).toHaveBeenCalledWith(
    { paths: ['Show/Season 1'], destDir: '', onConflict: undefined },
    expect.anything(),
  )
})

test('a move collision asks, and Replace re-issues the whole batch', async () => {
  renderBrowser()

  fireEvent.contextMenu(row('ep1.mkv'))
  fireEvent.click(screen.getByText('Move to…'))
  const dialog = await screen.findByRole('dialog', { name: 'Move to' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Move to Library root' }))

  const handlers = moveMutate.mock.calls[0]?.[1] as { onError: (failure: unknown) => void }
  handlers.onError(new PathConflictError('exists', 'ep1.mkv', 'ep1.mkv'))

  const prompt = await screen.findByRole('dialog', { name: 'Name already in use' })
  expect(prompt).toHaveTextContent('moves the existing file to this library’s trash first')

  fireEvent.click(screen.getByRole('button', { name: 'Replace' }))

  // One request for the batch, re-issued with the chosen policy applied to all.
  expect(moveMutate).toHaveBeenNthCalledWith(
    2,
    { paths: ['Show/ep1.mkv'], destDir: '', onConflict: 'replace' },
    expect.anything(),
  )
})

test('a read-only library offers no way to move', () => {
  renderBrowser(false)

  fireEvent.contextMenu(row('ep1.mkv'))
  expect(screen.queryByText('Move to…')).toBeNull()
})
