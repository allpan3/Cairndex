import { expect, test, vi } from 'vitest'

import { hostFileMenuEntries } from './hostActions'
import type { HostLabels } from '../platform'

const LABELS: HostLabels = {
  revealFile: 'Reveal in Finder',
  openFile: 'Open in Default App',
  locateLibrary: 'Locate on This Mac',
  deviceName: 'Cairndex Desktop for Mac',
}

test('a host that can act offers both entries, open first', () => {
  const onOpenFile = vi.fn()
  const onRevealFile = vi.fn()

  const entries = hostFileMenuEntries(LABELS, { onOpenFile, onRevealFile }, 'Set07/clip1.mp4')

  expect(entries.map((entry) => entry?.label)).toEqual(['Open in Default App', 'Reveal in Finder'])
  entries[1]?.onClick()
  expect(onRevealFile).toHaveBeenCalledWith('Set07/clip1.mp4')
})

test('a host that cannot act contributes nothing to the menu', () => {
  // Not disabled rows: the owner asked for none of those in a context menu
  // (2026-08-24). A plain browser has no Finder to reveal into, and a desktop
  // library the shell cannot resolve is now the rare case rather than the usual
  // one, since the local server's own path is adopted without asking.
  expect(hostFileMenuEntries(LABELS, {}, 'Set07/clip1.mp4')).toEqual([])
})
