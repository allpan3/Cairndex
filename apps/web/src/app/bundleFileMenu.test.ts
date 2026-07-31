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
