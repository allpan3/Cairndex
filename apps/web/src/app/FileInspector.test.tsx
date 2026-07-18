import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { hostLabelsFor } from '../platform'
import { FileInspector } from './FileInspector'
import { linkedVideoEntry as entry } from './testFixtures'

const labels = hostLabelsFor('macos')

test('passes only the server relative path to mapped FileInspector actions', () => {
  const onRevealFile = vi.fn()
  const onOpenFile = vi.fn()
  render(
    <FileInspector
      entry={entry}
      hostLabels={labels}
      onRevealFile={onRevealFile}
      onOpenFile={onOpenFile}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Open in Default App' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }))

  expect(onOpenFile).toHaveBeenCalledWith('Movies/movie.mp4')
  expect(onRevealFile).toHaveBeenCalledWith('Movies/movie.mp4')
})

test('hides FileInspector host actions for an unmapped library', () => {
  render(<FileInspector entry={entry} hostLabels={labels} />)

  expect(screen.queryByRole('button', { name: 'Open in Default App' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).not.toBeInTheDocument()
})
