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

// --- renaming (owner, 2026-09-01) -------------------------------------------

test('clicking away confirms a rename in progress', () => {
  const onRename = vi.fn()
  render(<FileInspector entry={factsFromEntry(entry)} hostLabels={labels} onRename={onRename} />)

  fireEvent.doubleClick(screen.getByText('movie.mp4'))
  fireEvent.change(screen.getByLabelText('Rename movie.mp4'), {
    target: { value: 'feature.mp4' },
  })
  // A pointerdown outside, and *not* a blur: a mousedown on a draggable row in
  // the listing is preventDefault-ed, so focus never leaves the field there.
  fireEvent.pointerDown(document.body)

  expect(onRename).toHaveBeenCalledWith('Movies/movie.mp4', 'feature.mp4')
  expect(screen.queryByLabelText('Rename movie.mp4')).not.toBeInTheDocument()
})

test('renames once when the click away also blurs the field', () => {
  const onRename = vi.fn()
  render(<FileInspector entry={factsFromEntry(entry)} hostLabels={labels} onRename={onRename} />)

  fireEvent.doubleClick(screen.getByText('movie.mp4'))
  const field = screen.getByLabelText('Rename movie.mp4')
  fireEvent.change(field, { target: { value: 'feature.mp4' } })
  fireEvent.pointerDown(document.body)
  fireEvent.blur(field)

  expect(onRename).toHaveBeenCalledTimes(1)
})

test('Escape abandons the rename, and clicking away then changes nothing', () => {
  const onRename = vi.fn()
  render(<FileInspector entry={factsFromEntry(entry)} hostLabels={labels} onRename={onRename} />)

  fireEvent.doubleClick(screen.getByText('movie.mp4'))
  const field = screen.getByLabelText('Rename movie.mp4')
  fireEvent.change(field, { target: { value: 'feature.mp4' } })
  fireEvent.keyDown(field, { key: 'Escape' })
  fireEvent.pointerDown(document.body)

  expect(onRename).not.toHaveBeenCalled()
})
