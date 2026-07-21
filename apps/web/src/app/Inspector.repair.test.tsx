import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

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

const missingFile = {
  id: 'missing',
  bundle_id: 'target-bundle',
  availability: 'missing',
} as FileRead

test('offers one compact relink action for the unique current-path match', () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<MissingFileRepairAction bundleId="target-bundle" file={missingFile} />)

  const button = screen.getByRole('button', { name: 'Relink to renamed/current.mp4' })
  fireEvent.click(button)
  expect(hooks.repair.mutate).toHaveBeenCalledWith('current')
})
