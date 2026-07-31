import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { setActiveLibraryId, type BundleRead, type FileRead } from '../api/client'
import {
  BUNDLE_INSPECTOR_ACTION_KEYS,
  BundleInspectorActionsContext,
  useMergedBundleInspectorActions,
  type BundleInspectorActions,
} from './bundleInspectorActions'
import { Inspector } from './Inspector'

const hooks = vi.hoisted(() => ({
  bundle: undefined as unknown,
  files: [] as unknown[],
  reorder: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  update: { mutate: vi.fn(), error: null },
}))

vi.mock('../api/hooks', () => ({
  useBundle: () => ({ data: hooks.bundle }),
  useBundleFiles: () => ({ data: hooks.files }),
  useFileMutations: () => ({ reorder: hooks.reorder, remove: hooks.remove }),
  useFileRepairCandidate: vi.fn(),
  useRepairFile: vi.fn(),
  useUpdateBundle: () => hooks.update,
}))

// The tag and collection pickers each read a fistful of library-wide queries and
// have nothing to do with what this file is asserting.
vi.mock('./TagEditor', () => ({ TagEditor: () => null }))
vi.mock('./CollectionPicker', () => ({ CollectionPicker: () => null }))

function file(id: string): FileRead {
  return {
    id,
    bundle_id: 'bundle',
    relative_path: `folder/${id}.mp4`,
    original_filename: `${id}.mp4`,
    display_title: `${id}.mp4`,
    role: 'primary_video',
    media_kind: 'video',
    mime_type: 'video/mp4',
    sequence: 0,
    size_bytes: 1_000,
    availability: 'available',
    supported: true,
    tech_metadata: {},
    created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-30T00:00:00Z',
  } as FileRead
}

/** Everything the shell wires up, with every entry present. */
const shellActions: BundleInspectorActions = {
  hostLabels: {
    revealFile: 'Reveal in Finder',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This Mac',
    deviceName: 'Cairndex Desktop for Mac',
  },
  onAddFiles: vi.fn(),
  onPlayBundle: vi.fn(),
  onPlayFile: vi.fn(),
  onOpenFile: vi.fn(),
  onRevealFile: vi.fn(),
  onLocateFile: vi.fn(),
  onTrashFiles: vi.fn(),
  onStartFileDrag: vi.fn(),
  onFlash: vi.fn(),
  onFilterByTags: vi.fn(),
  onOpenCollection: vi.fn(),
}

/**
 * The shape of what `ViewerShell` does: replace the handful it must reinterpret
 * inside an open viewer, and say nothing at all about the rest.
 */
function ViewerOverrides({ children }: { children: ReactNode }) {
  const merged = useMergedBundleInspectorActions({
    onPlayBundle: vi.fn(),
    onPlayFile: vi.fn(),
    onLocateFile: vi.fn(),
    onAddFiles: vi.fn(),
    onFilterByTags: vi.fn(),
    onOpenCollection: vi.fn(),
    onFlash: vi.fn(),
  })
  return <BundleInspectorActionsContext value={merged}>{children}</BundleInspectorActionsContext>
}

/** Right-click the one file row and read back the menu labels. */
function fileRowMenuLabels(): string[] {
  const row = screen.getAllByRole('listitem')[0]
  if (!row) throw new Error('expected a file row')
  fireEvent.contextMenu(row)
  const menu = screen.getByRole('menu')
  return within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '')
}

/** A confirmed bundle, so the inspector renders its editor rather than a state. */
const bundle = {
  id: 'bundle',
  title: 'clip',
  notes: [],
  rating: null,
  version: 1,
  cover_file_id: null,
  grouping_state: 'confirmed',
  created_at: '2026-07-30T00:00:00Z',
  updated_at: '2026-07-30T00:00:00Z',
} as unknown as BundleRead

beforeEach(() => {
  // The cover thumbnail URL is library-scoped, so the inspector needs one.
  setActiveLibraryId('library-one')
  hooks.bundle = bundle
  hooks.files = [file('clip')]
})

/** Reports which actions are in scope, and whether each is the shell's own. */
function ActionProbe({ overrides }: { overrides: BundleInspectorActions }) {
  const merged = useMergedBundleInspectorActions(overrides)
  return (
    <ul>
      {BUNDLE_INSPECTOR_ACTION_KEYS.map((key) => (
        <li key={key} data-key={key} data-inherited={String(merged[key] === shellActions[key])}>
          {merged[key] === undefined ? 'missing' : 'present'}
        </li>
      ))}
    </ul>
  )
}

test('the viewer inherits every inspector action the shell provides', () => {
  // The property that keeps the two surfaces from drifting: a viewer that only
  // reinterprets `onPlayBundle` still gets everything else, so an action added
  // to the shell later cannot go missing in the viewer by omission.
  const overridden = vi.fn()
  render(
    <BundleInspectorActionsContext value={shellActions}>
      <ActionProbe overrides={{ onPlayBundle: overridden }} />
    </BundleInspectorActionsContext>,
  )

  for (const key of BUNDLE_INSPECTOR_ACTION_KEYS) {
    const row = document.querySelector(`[data-key="${key}"]`)
    expect(row?.textContent, `${key} should reach the viewer's inspector`).toBe('present')
    // Only the action the viewer deliberately reinterprets is its own.
    expect(row?.getAttribute('data-inherited')).toBe(String(key !== 'onPlayBundle'))
  }
})

test('the docked inspector offers the same file menu as the shell inspector', () => {
  const shell = render(
    <BundleInspectorActionsContext value={shellActions}>
      <Inspector bundleId="bundle" />
    </BundleInspectorActionsContext>,
  )
  const shellLabels = fileRowMenuLabels()
  shell.unmount()

  render(
    <BundleInspectorActionsContext value={shellActions}>
      <ViewerOverrides>
        <Inspector bundleId="bundle" />
      </ViewerOverrides>
    </BundleInspectorActionsContext>,
  )

  expect(fileRowMenuLabels()).toEqual(shellLabels)
  // Guard against the assertion passing on two equally *empty* menus, which is
  // exactly what the viewer used to show.
  expect(shellLabels).toContain('Locate in File Browser')
  expect(shellLabels).toContain('Reveal in Finder')
  expect(shellLabels).toContain('Move to Trash')
})

test('the write-mode menu action trashes the clicked inspector file', () => {
  const onTrashFiles = vi.fn()
  render(
    <BundleInspectorActionsContext value={{ ...shellActions, onTrashFiles }}>
      <Inspector bundleId="bundle" />
    </BundleInspectorActionsContext>,
  )

  fileRowMenuLabels()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

  expect(onTrashFiles).toHaveBeenCalledWith(['folder/clip.mp4'])
})

test('an inspector with no actions in scope loses the handler-gated entries', () => {
  // The regression this file exists for: the viewer rendered `<Inspector>` with
  // nothing but a bundle id, so every entry below was silently absent there
  // while the shell's menu had them (owner, 2026-07-30).
  render(<Inspector bundleId="bundle" />)
  const labels = fileRowMenuLabels()

  expect(labels).not.toContain('Locate in File Browser')
  expect(labels).not.toContain('Reveal in Finder')
  expect(labels).not.toContain('Move to Trash')
})
