import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileRead } from '../api/client'
import { BundleDropDestination, DirectoryPicker } from './FileWriteDialogs'

// The bundle whose files decide where the picker opens.
let bundleFiles: FileRead[] = []
// Directory listings, keyed by the path being browsed ('' is the library root).
const listings: Record<string, string[]> = {
  '': ['Photos', 'Studios'],
  Studios: ['Alpha', 'Beta'],
  'Studios/Alpha': [],
}

// The mkdir mutation the picker's New Folder drives.
const mkdir = { mutate: vi.fn(), isPending: false, isError: false, error: null as unknown }

vi.mock('../api/hooks', () => ({
  useFileOperations: () => ({ mkdir }),
  useBundleFiles: () => ({ data: bundleFiles, isLoading: false }),
  useFileBrowser: (path: string | null) => ({
    data: {
      entries: (listings[path ?? ''] ?? []).map((name) => ({
        name,
        relative_path: path ? `${path}/${name}` : name,
        kind: 'directory',
      })),
    },
    isLoading: false,
  }),
}))

function fileAt(relativePath: string): FileRead {
  return { relative_path: relativePath } as FileRead
}

beforeEach(() => {
  bundleFiles = []
  mkdir.mutate = vi.fn()
  mkdir.isPending = false
  mkdir.isError = false
  mkdir.error = null
})

test('a drop onto a bundle opens where the bundle’s first file lives', () => {
  // Dropping used to copy straight into the library root, so a file arrived
  // linked but filed in the wrong folder (owner report, 2026-07-30).
  bundleFiles = [fileAt('Studios/Alpha/part1.mp4'), fileAt('Studios/Alpha/part2.mp4')]
  const onChoose = vi.fn()
  render(
    <BundleDropDestination
      bundleId="b1"
      fileCount={1}
      onChoose={onChoose}
      onCancel={() => undefined}
      busy={false}
    />,
  )

  // Already inside the bundle's own folder, with the trail back out visible.
  expect(screen.getByRole('button', { name: 'Studios' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Copy into Alpha' })).toBeEnabled()

  fireEvent.click(screen.getByRole('button', { name: 'Copy into Alpha' }))
  expect(onChoose).toHaveBeenCalledWith('Studios/Alpha')
})

test('somewhere else is still one click away', () => {
  bundleFiles = [fileAt('Studios/Alpha/part1.mp4')]
  const onChoose = vi.fn()
  render(
    <BundleDropDestination
      bundleId="b1"
      fileCount={2}
      onChoose={onChoose}
      onCancel={() => undefined}
      busy={false}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Copy 2 files into…' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Studios' }))
  fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy into Beta' }))
  expect(onChoose).toHaveBeenCalledWith('Studios/Beta')
})

test('a bundle whose file sits at the root opens at the root', () => {
  bundleFiles = [fileAt('loose.mp4')]
  const onChoose = vi.fn()
  render(
    <BundleDropDestination
      bundleId="b1"
      fileCount={1}
      onChoose={onChoose}
      onCancel={() => undefined}
      busy={false}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Copy into Library root' }))
  expect(onChoose).toHaveBeenCalledWith('')
})

// --- New Folder inside the picker --------------------------------------------
// Choosing where to *add* a file is often the moment you notice the folder does
// not exist yet. It is opt-in because this dialog is shared with Move to…, which
// should not gain an affordance by side effect.
function renderPicker(props: Partial<Parameters<typeof DirectoryPicker>[0]> = {}) {
  const onChoose = vi.fn()
  render(<DirectoryPicker onChoose={onChoose} onCancel={vi.fn()} busy={false} {...props} />)
  return onChoose
}

test('the picker offers no New Folder unless asked', () => {
  renderPicker()

  expect(screen.queryByRole('button', { name: 'New Folder' })).toBeNull()
})

test('a folder is created under the directory currently open', () => {
  // Via the button, because a dialog needs a visible way to commit — the inline
  // list editor's Enter-or-blur convention left the owner with "only this text
  // box" and no obvious action (2026-08-23).
  renderPicker({ allowNewFolder: true, startIn: 'Studios' })

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Gamma' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))

  expect(mkdir.mutate).toHaveBeenCalledTimes(1)
  expect(mkdir.mutate.mock.calls[0]?.[0]).toBe('Studios/Gamma')
})

test('Enter in the name box creates the folder too', () => {
  renderPicker({ allowNewFolder: true, startIn: 'Studios' })

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  const input = screen.getByLabelText('New folder name')
  fireEvent.change(input, { target: { value: 'Gamma' } })
  fireEvent.submit(input)

  expect(mkdir.mutate.mock.calls[0]?.[0]).toBe('Studios/Gamma')
})

test('nothing is created by clicking away from the name box', () => {
  // The inline editor commits on blur, which in a dialog meant clicking the
  // confirm button created the folder *and* imported into its parent.
  renderPicker({ allowNewFolder: true, startIn: 'Studios' })

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  const input = screen.getByLabelText('New folder name')
  fireEvent.change(input, { target: { value: 'Gamma' } })
  fireEvent.blur(input)

  expect(mkdir.mutate).not.toHaveBeenCalled()
})

test('the name box can be abandoned', () => {
  renderPicker({ allowNewFolder: true })

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel new folder' }))

  expect(screen.queryByLabelText('New folder name')).toBeNull()
  expect(screen.getByRole('button', { name: 'New Folder' })).toBeTruthy()
})

test('a folder created at the root has no leading slash', () => {
  renderPicker({ allowNewFolder: true })

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Inbox' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))

  expect(mkdir.mutate.mock.calls[0]?.[0]).toBe('Inbox')
})

test('the picker steps into the folder it just created', () => {
  // It was created to be the destination, so leaving the picker outside it would
  // make every caller navigate in by hand.
  const onChoose = renderPicker({ allowNewFolder: true, startIn: 'Studios' })

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Gamma' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  const options = mkdir.mutate.mock.calls[0]?.[1] as { onSuccess: () => void }
  act(() => options.onSuccess())

  fireEvent.click(screen.getByRole('button', { name: /^Choose|^Move|^Add|Select/ }))
  expect(onChoose).toHaveBeenCalledWith('Studios/Gamma')
})

test('an empty name cannot be submitted', () => {
  renderPicker({ allowNewFolder: true })

  fireEvent.click(screen.getByRole('button', { name: 'New Folder' }))
  fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: '   ' } })

  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(mkdir.mutate).not.toHaveBeenCalled()
})

test('a refused folder says why and leaves the picker where it was', () => {
  mkdir.isError = true
  mkdir.error = new Error('A folder with that name is already here.')
  renderPicker({ allowNewFolder: true, startIn: 'Studios' })

  expect(screen.getByRole('alert')).toHaveTextContent('already here')
})
