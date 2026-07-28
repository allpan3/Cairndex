import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileRead } from '../api/client'
import { MissingFileRepairAction } from './Inspector'

const hooks = vi.hoisted(() => ({
  candidate: {
    data: {
      missing_file_id: 'missing',
      replacement_file_id: 'current',
      replacement_bundle_id: 'replacement-bundle',
      relative_path: 'renamed/current.mp4',
      display_title: 'current.mp4',
    },
    isError: false,
  },
  repair: { mutate: vi.fn(), isPending: false, isError: false },
}))

vi.mock('../api/hooks', () => ({
  useBundle: vi.fn(),
  useBundleFiles: vi.fn(),
  useFileMutations: vi.fn(),
  useFileRepairCandidate: () => hooks.candidate,
  useRepairFile: () => hooks.repair,
  useUpdateBundle: vi.fn(),
}))

// The hook mocks live at module scope, so each test starts from a clean slate.
beforeEach(() => {
  hooks.repair.mutate.mockClear()
})

const missingFile = {
  id: 'missing',
  bundle_id: 'target-bundle',
  availability: 'missing',
} as FileRead

test('offers one compact relink action for the unique current-path match', () => {
  render(<MissingFileRepairAction bundleId="target-bundle" file={missingFile} />)

  fireEvent.click(screen.getByRole('button', { name: 'Relink to renamed/current.mp4' }))

  // Relinking asks first, in a rendered dialog. It used to use `window.confirm`,
  // which the desktop webview does not implement — there the question never
  // appeared and the click did nothing (owner, 2026-07-27).
  expect(hooks.repair.mutate).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Relink Missing File' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Relink' }))
  expect(hooks.repair.mutate).toHaveBeenCalledWith('current')
})

test('cancelling the relink prompt leaves the file alone', () => {
  render(<MissingFileRepairAction bundleId="target-bundle" file={missingFile} />)

  fireEvent.click(screen.getByRole('button', { name: 'Relink to renamed/current.mp4' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  expect(hooks.repair.mutate).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
