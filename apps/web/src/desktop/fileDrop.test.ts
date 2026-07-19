import { expect, test, vi } from 'vitest'

import type { ReverseMapResult } from '../platform'
import {
  DROP_BLOCKED_MESSAGE,
  DROP_DIRECTORY_MESSAGE,
  DROP_OUTSIDE_MESSAGE,
  DROP_PENDING_MESSAGE,
  DROP_UNMAPPED_MESSAGE,
  type FileDropRouting,
  handleFileDrop,
} from './fileDrop'

// Builds a routing whose reverse-map returns one canned categorized result,
// keeping direct handles to the observable side-effect mocks.
function routing(overrides: Partial<FileDropRouting> & { result?: Partial<ReverseMapResult> }) {
  const result: ReverseMapResult = {
    inside: [],
    outside: [],
    directories: 0,
    ...overrides.result,
  }
  const onFastAdd = vi.fn()
  const onFlash = vi.fn()
  const reverseMap = overrides.reverseMap ?? vi.fn().mockResolvedValue(result)
  const config: FileDropRouting = {
    libraryId: 'lib-one',
    mappingState: 'mapped',
    reverseMap,
    onFastAdd,
    onFlash,
    ...overrides,
  }
  return { config, onFastAdd, onFlash, reverseMap: vi.mocked(reverseMap), result }
}

test('ignores an empty drop', async () => {
  const r = routing({})
  await handleFileDrop([], r.config)
  expect(r.reverseMap).not.toHaveBeenCalled()
  expect(r.onFlash).not.toHaveBeenCalled()
})

test('explains a drop blocked by a modal/menu/viewer without re-seeding', async () => {
  const r = routing({ result: { inside: ['Movies/a.mp4'] } })
  await handleFileDrop(['/Volumes/Media/Movies/a.mp4'], r.config, 'modal')
  expect(r.reverseMap).not.toHaveBeenCalled()
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_BLOCKED_MESSAGE)
})

test('silently ignores a self-drag (the app’s own drag-out dropped back on us)', async () => {
  const r = routing({ result: { inside: ['Movies/a.mp4'] } })
  await handleFileDrop(['/Volumes/Media/Movies/a.mp4'], r.config, 'self-drag')
  expect(r.reverseMap).not.toHaveBeenCalled()
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).not.toHaveBeenCalled() // no flash for our own drag
})

test('defers a drop while the library mapping is still resolving', async () => {
  const r = routing({ mappingState: 'pending' })
  await handleFileDrop(['/Volumes/Media/a.mp4'], r.config)
  expect(r.reverseMap).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_PENDING_MESSAGE)
})

test('explains how to locate an unmapped library instead of reverse-mapping', async () => {
  const r = routing({ mappingState: 'unmapped' })
  await handleFileDrop(['/Volumes/Media/a.mp4'], r.config)
  expect(r.reverseMap).not.toHaveBeenCalled()
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_UNMAPPED_MESSAGE)
})

test('routes in-library files into the fast-add flow', async () => {
  const r = routing({ result: { inside: ['Movies/a.mp4', 'Movies/b.mp4'] } })
  await handleFileDrop(['/Volumes/Media/Movies/a.mp4', '/Volumes/Media/Movies/b.mp4'], r.config)
  expect(r.reverseMap).toHaveBeenCalledWith('lib-one', [
    '/Volumes/Media/Movies/a.mp4',
    '/Volumes/Media/Movies/b.mp4',
  ])
  expect(r.onFastAdd).toHaveBeenCalledWith(['Movies/a.mp4', 'Movies/b.mp4'])
  expect(r.onFlash).not.toHaveBeenCalled()
})

test('adds the in-library files and notes the ones left outside', async () => {
  const r = routing({ result: { inside: ['Movies/a.mp4'], outside: ['/tmp/x.mp4', '/tmp/y.mp4'] } })
  await handleFileDrop(['/Volumes/Media/Movies/a.mp4', '/tmp/x.mp4', '/tmp/y.mp4'], r.config)
  expect(r.onFastAdd).toHaveBeenCalledWith(['Movies/a.mp4'])
  expect(r.onFlash).toHaveBeenCalledOnce()
  expect(r.onFlash.mock.calls[0]?.[0]).toContain('2 items couldn’t be added')
})

test('gives a dropped in-library folder its own folder-specific message', async () => {
  const r = routing({ result: { directories: 1 } })
  await handleFileDrop(['/Volumes/Media/Season 1'], r.config)
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_DIRECTORY_MESSAGE)
})

test('explains in-place linking when every dropped file is outside the library', async () => {
  const r = routing({ result: { outside: ['/tmp/x.mp4'] } })
  await handleFileDrop(['/tmp/x.mp4'], r.config)
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_OUTSIDE_MESSAGE)
})

test('hands the W5 seam exactly the outside absolute paths of a mixed drop', async () => {
  const onCopyIntoLibrary = vi.fn().mockReturnValue(true)
  const r = routing({
    result: { inside: ['Movies/a.mp4'], outside: ['/tmp/x.mp4', '/tmp/y.mp4'] },
    onCopyIntoLibrary,
  })
  await handleFileDrop(['/Volumes/Media/Movies/a.mp4', '/tmp/x.mp4', '/tmp/y.mp4'], r.config)
  expect(r.onFastAdd).toHaveBeenCalledWith(['Movies/a.mp4'])
  // Exactly the outside subset, not the whole drop.
  expect(onCopyIntoLibrary).toHaveBeenCalledWith(['/tmp/x.mp4', '/tmp/y.mp4'], r.result)
  expect(r.onFlash).not.toHaveBeenCalled()
})

test('never offers a dropped folder to the seam, and still notes it', async () => {
  const onCopyIntoLibrary = vi.fn().mockReturnValue(true)
  const r = routing({ result: { outside: ['/tmp/x.mp4'], directories: 1 }, onCopyIntoLibrary })
  await handleFileDrop(['/tmp/x.mp4', '/Volumes/Media/Season 1'], r.config)
  // The seam took the outside file; the folder still gets its own message.
  expect(onCopyIntoLibrary).toHaveBeenCalledWith(['/tmp/x.mp4'], r.result)
  expect(r.onFlash).toHaveBeenCalledWith(DROP_DIRECTORY_MESSAGE)
})

test('still explains when the seam declines the outside files', async () => {
  const onCopyIntoLibrary = vi.fn().mockReturnValue(false)
  const r = routing({ result: { outside: ['/tmp/x.mp4'] }, onCopyIntoLibrary })
  await handleFileDrop(['/tmp/x.mp4'], r.config)
  expect(onCopyIntoLibrary).toHaveBeenCalledOnce()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_OUTSIDE_MESSAGE)
})

test('surfaces a structured reverse-map failure (e.g. the mount went offline)', async () => {
  const r = routing({
    reverseMap: vi.fn().mockRejectedValue({ code: 'volume_not_mounted', message: 'ignored' }),
  })
  await handleFileDrop(['/Volumes/Media/a.mp4'], r.config)
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith('Volume not mounted. Reconnect it and try again.')
})
