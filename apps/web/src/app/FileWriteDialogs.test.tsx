import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileRead } from '../api/client'
import { BundleDropDestination } from './FileWriteDialogs'

// The bundle whose files decide where the picker opens.
let bundleFiles: FileRead[] = []
// Directory listings, keyed by the path being browsed ('' is the library root).
const listings: Record<string, string[]> = {
  '': ['Photos', 'Studios'],
  Studios: ['Alpha', 'Beta'],
  'Studios/Alpha': [],
}

vi.mock('../api/hooks', () => ({
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
