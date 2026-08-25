import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileRead, TargetSuggestion } from '../api/client'
import { BundleDropDestination, ConflictDialog, DirectoryPicker } from './FileWriteDialogs'

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

// Bundle suggestions per destination folder, so a test can prove the offer
// follows the folder being browsed rather than the one the picker opened in.
let bundleSuggestions: Record<string, TargetSuggestion[]> = {}
// Every selection the picker asked about, in order — the paths matter as much as
// the answers: they are what tells the server *where the file would land*.
const suggestionQueries: string[][] = []

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
  useTargetSuggestions: (sel: { relativePaths?: string[] }, enabled: boolean) => {
    const paths = sel.relativePaths ?? []
    if (!enabled || paths.length === 0) return { data: undefined, isLoading: false }
    suggestionQueries.push(paths)
    const folder = (paths[0] as string).split('/').slice(0, -1).join('/')
    return { data: bundleSuggestions[folder] ?? [], isLoading: false }
  },
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
  bundleSuggestions = {}
  suggestionQueries.length = 0
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
  expect(onChoose).toHaveBeenCalledWith('Studios/Alpha', null)
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
  expect(onChoose).toHaveBeenCalledWith('Studios/Beta', null)
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
  expect(onChoose).toHaveBeenCalledWith('', null)
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
  expect(onChoose).toHaveBeenCalledWith('Studios/Gamma', null)
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

// --- the collision dialog's third answer --------------------------------------
test('Skip is offered only where there is a rest of the batch to carry on with', () => {
  // For a single rename or move, skipping is what Cancel already does, so the
  // button would be two names for one outcome.
  const { rerender } = render(
    <ConflictDialog
      name="clip.mkv"
      onKeepBoth={vi.fn()}
      onReplace={vi.fn()}
      onCancel={vi.fn()}
      busy={false}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull()

  const onSkip = vi.fn()
  rerender(
    <ConflictDialog
      name="clip.mkv"
      onKeepBoth={vi.fn()}
      onReplace={vi.fn()}
      onSkip={onSkip}
      onCancel={vi.fn()}
      busy={false}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }))

  expect(onSkip).toHaveBeenCalledTimes(1)
})

test('the dialog distinguishes Skip from Cancel in words, not just buttons', () => {
  render(
    <ConflictDialog
      name="clip.mkv"
      onKeepBoth={vi.fn()}
      onReplace={vi.fn()}
      onSkip={vi.fn()}
      onCancel={vi.fn()}
      busy={false}
    />,
  )

  // Which one abandons the queue is the whole difference between them.
  expect(screen.getByText(/carries on with the rest/)).toBeTruthy()
  expect(screen.getByText(/does not copy what is left/)).toBeTruthy()
})

// --- "and add it to a bundle" ------------------------------------------------
// The destination folder is the strongest hint about which bundle a file joins,
// so the picker that already asks where can ask what it belongs to as well
// (owner, 2026-08-25). Opt-in, because Move to… asks a different question.
function suggestion(bundleId: string, title: string, reason: string): TargetSuggestion {
  return { bundle_id: bundleId, title, reason, confidence: 0.5 } as TargetSuggestion
}

test('the picker offers no bundle unless asked', () => {
  bundleSuggestions = { Studios: [suggestion('b1', 'Alpha Reel', 'same folder')] }
  renderPicker({ startIn: 'Studios' })

  expect(screen.queryByRole('heading', { name: 'Add to a bundle' })).toBeNull()
  // And it must not even ask: Move to… has no business generating suggestions.
  expect(suggestionQueries).toEqual([])
})

test('the offer asks about the path each file would land on', () => {
  renderPicker({ startIn: 'Studios', suggestBundleFor: ['behind.mp4', 'poster.jpg'] })

  expect(suggestionQueries[0]).toEqual(['Studios/behind.mp4', 'Studios/poster.jpg'])
})

test('a suggested bundle is named on the confirm button, not applied silently', () => {
  bundleSuggestions = { Studios: [suggestion('b1', 'Alpha Reel', 'same folder')] }
  const onChoose = renderPicker({
    startIn: 'Studios',
    confirmLabel: (where) => `Add to ${where}`,
    suggestBundleFor: ['behind.mp4'],
  })

  // Nothing is preselected: the file lands in the folder and joins nothing,
  // which is what every other add does.
  expect(screen.getByRole('button', { name: 'Add to Studios' })).toBeEnabled()
  expect(screen.getByRole('radio', { name: /Don’t add to a bundle/ })).toBeChecked()

  fireEvent.click(screen.getByRole('radio', { name: /Alpha Reel/ }))
  // The button says what will happen, so a bundle cannot be joined unnoticed.
  fireEvent.click(screen.getByRole('button', { name: 'Add to “Alpha Reel”' }))
  expect(onChoose).toHaveBeenCalledWith('Studios', 'b1')
})

test('declining a bundle hands back the destination alone', () => {
  bundleSuggestions = { Studios: [suggestion('b1', 'Alpha Reel', 'same folder')] }
  const onChoose = renderPicker({
    startIn: 'Studios',
    confirmLabel: (where) => `Add to ${where}`,
    suggestBundleFor: ['behind.mp4'],
  })

  fireEvent.click(screen.getByRole('radio', { name: /Alpha Reel/ }))
  fireEvent.click(screen.getByRole('radio', { name: /Don’t add to a bundle/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Add to Studios' }))
  expect(onChoose).toHaveBeenCalledWith('Studios', null)
})

test('a bundle chosen in one folder does not follow you to another', () => {
  // The dangerous case: pick a bundle, change your mind about where the file
  // goes, and confirm. The bundle belonged to the folder you left.
  bundleSuggestions = {
    Studios: [suggestion('b1', 'Alpha Reel', 'same folder')],
    'Studios/Beta': [suggestion('b2', 'Beta Reel', 'same folder')],
  }
  const onChoose = renderPicker({
    startIn: 'Studios',
    confirmLabel: (where) => `Add to ${where}`,
    suggestBundleFor: ['behind.mp4'],
  })

  fireEvent.click(screen.getByRole('radio', { name: /Alpha Reel/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Beta' }))

  expect(screen.getByRole('radio', { name: /Don’t add to a bundle/ })).toBeChecked()
  expect(screen.queryByRole('radio', { name: /Alpha Reel/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add to Beta' }))
  expect(onChoose).toHaveBeenCalledWith('Studios/Beta', null)
})

test('a folder with no plausible bundle says so, and still adds the file', () => {
  const onChoose = renderPicker({
    startIn: 'Studios',
    confirmLabel: (where) => `Add to ${where}`,
    suggestBundleFor: ['behind.mp4'],
  })

  expect(screen.getByText('No bundle here suits these files.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Add to Studios' }))
  expect(onChoose).toHaveBeenCalledWith('Studios', null)
})
