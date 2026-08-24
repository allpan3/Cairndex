import { expect, test, vi } from 'vitest'

import type { FileRead } from '../api/client'
import { bundleFileMenuEntries } from './bundleFileMenu'

/** One synthetic video with every menu capability available. */
const video = {
  id: 'file-one',
  bundle_id: 'bundle-one',
  relative_path: 'folder/video.mp4',
  display_title: 'video.mp4',
  media_kind: 'video',
  size_bytes: 1_000,
  tech_metadata: {},
} as FileRead

test('orders native, write, bundle, and export sections', () => {
  const entries = bundleFileMenuEntries({
    targets: [video],
    hostLabels: {
      openFile: 'Open in Default App',
      revealFile: 'Reveal in Finder',
      locateLibrary: 'Locate on This Mac',
      deviceName: 'Cairndex Desktop for Mac',
    },
    onOpenFile: vi.fn(),
    onRevealFile: vi.fn(),
    onTrash: vi.fn(),
    onRemoveFromBundle: vi.fn(),
    onLocateFile: vi.fn(),
    onContactSheet: vi.fn(),
  })

  expect(entries.map((entry) => entry?.label ?? null)).toEqual([
    'Open in Default App',
    'Reveal in Finder',
    null,
    'Move to Trash',
    null,
    'Remove from Bundle',
    'Locate in File Browser',
    null,
    'Save Contact Sheet…',
  ])
})

const missing = { ...video, id: 'file-gone', availability: 'missing' } as FileRead

test('a file that is gone offers Forget in place of Remove from Bundle', () => {
  // Detaching a dead file drops it too, so offering both would be one action
  // under two names — and only one of the names describes what happens.
  const onForgetMissing = vi.fn()
  const entries = bundleFileMenuEntries({
    targets: [missing],
    onRemoveFromBundle: vi.fn(),
    onForgetMissing,
  })

  expect(entries.map((entry) => entry?.label ?? null)).toEqual(['Forget Missing File'])
  entries[0]?.onClick()
  expect(onForgetMissing).toHaveBeenCalledWith([missing])
})

test('a selection that is not entirely gone keeps Remove from Bundle', () => {
  const entries = bundleFileMenuEntries({
    targets: [video, missing],
    onRemoveFromBundle: vi.fn(),
    onForgetMissing: vi.fn(),
  })

  expect(entries.map((entry) => entry?.label ?? null)).toEqual(['Remove 2 Files from Bundle'])
})

test('several gone files are forgotten together', () => {
  const entries = bundleFileMenuEntries({
    targets: [missing, { ...missing, id: 'file-gone-two' } as FileRead],
    onForgetMissing: vi.fn(),
  })

  expect(entries.map((entry) => entry?.label ?? null)).toEqual(['Forget 2 Missing Files'])
})

test('a host that cannot forget still offers the detach it has', () => {
  // No dead end: the row that exists keeps working, it just reads less exactly.
  const entries = bundleFileMenuEntries({ targets: [missing], onRemoveFromBundle: vi.fn() })

  expect(entries.map((entry) => entry?.label ?? null)).toEqual(['Remove from Bundle'])
})
