import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { hostLabelsFor } from '../platform'
import { FileInspector } from './FileInspector'
import { factsFromEntry } from './fileFacts'
import { linkedVideoEntry as entry } from './testFixtures'

const labels = hostLabelsFor('macos')

test('passes only the server relative path to mapped FileInspector actions', () => {
  const onRevealFile = vi.fn()
  const onOpenFile = vi.fn()
  render(
    <FileInspector
      entry={factsFromEntry(entry)}
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
  render(<FileInspector entry={factsFromEntry(entry)} hostLabels={labels} />)

  expect(screen.queryByRole('button', { name: 'Open in Default App' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).not.toBeInTheDocument()
})

test('keeps in-app location available without desktop host actions', () => {
  const onLocate = vi.fn()
  render(
    <FileInspector
      entry={factsFromEntry(entry)}
      hostLabels={labels}
      locateLabel="Locate in Bundle Browser"
      onLocate={onLocate}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Locate in Bundle Browser' }))

  expect(onLocate).toHaveBeenCalledWith('Movies/movie.mp4')
  expect(screen.queryByRole('button', { name: 'Open in Default App' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).not.toBeInTheDocument()
})

test('drags the selected file out by its relative path when drag-out is enabled', () => {
  const onStartFileDrag = vi.fn()
  const { container } = render(
    <FileInspector
      entry={factsFromEntry(entry)}
      hostLabels={labels}
      onStartFileDrag={onStartFileDrag}
    />,
  )

  const title = container.querySelector('.inspector__title') as HTMLElement
  expect(title).toHaveAttribute('draggable', 'true')
  fireEvent.dragStart(title)

  expect(onStartFileDrag).toHaveBeenCalledWith(['Movies/movie.mp4'])
})

test('leaves the FileInspector title inert without drag-out', () => {
  const { container } = render(<FileInspector entry={factsFromEntry(entry)} hostLabels={labels} />)

  expect(container.querySelector('.inspector__title')).toHaveAttribute('draggable', 'false')
})
