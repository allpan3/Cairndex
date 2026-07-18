import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { FileBrowserEntry } from '../api/client'
import type { HostLabels } from '../platform'
import { FileInspector } from './FileInspector'

const labels: HostLabels = {
  revealFile: 'Reveal in Finder',
  openFile: 'Open in Default App',
  locateLibrary: 'Locate on This Mac',
  deviceName: 'Cairndex Desktop for Mac',
}

const entry: FileBrowserEntry = {
  audio_codec: null,
  bundle_id: 'bundle-one',
  container: 'mov,mp4',
  created_at: '2026-07-18T00:00:00Z',
  duration: 60,
  extension: 'mp4',
  file_id: 'file-one',
  kind: 'file',
  linked: true,
  media_kind: 'video',
  mime_type: 'video/mp4',
  modified_at: '2026-07-18T00:00:00Z',
  name: 'movie.mp4',
  relative_path: 'Movies/movie.mp4',
  resume_position: 0,
  size_bytes: 100,
  supported: true,
  unbundled: false,
  video_codec: 'h264',
}

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
