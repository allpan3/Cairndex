import { expect, test, vi } from 'vitest'

import {
  DROP_OUTSIDE_MESSAGE,
  DROP_UNMAPPED_MESSAGE,
  type FileDropRouting,
  handleFileDrop,
} from './fileDrop'

// Builds a routing whose reverse-map returns one canned partition, keeping direct
// handles to the observable side-effect mocks.
function routing(
  overrides: Partial<FileDropRouting> & { partition?: { inside: string[]; outsideCount: number } },
) {
  const partition = overrides.partition ?? { inside: [], outsideCount: 0 }
  const onFastAdd = vi.fn()
  const onFlash = vi.fn()
  const reverseMap = overrides.reverseMap ?? vi.fn().mockResolvedValue(partition)
  const config: FileDropRouting = {
    libraryId: 'lib-one',
    libraryMapped: true,
    reverseMap,
    onFastAdd,
    onFlash,
    ...overrides,
  }
  return { config, onFastAdd, onFlash, reverseMap: vi.mocked(reverseMap) }
}

test('ignores an empty drop', async () => {
  const r = routing({})
  await handleFileDrop([], r.config)
  expect(r.reverseMap).not.toHaveBeenCalled()
  expect(r.onFlash).not.toHaveBeenCalled()
})

test('explains how to locate an unmapped library instead of reverse-mapping', async () => {
  const r = routing({ libraryMapped: false })
  await handleFileDrop(['/Volumes/Media/a.mp4'], r.config)
  expect(r.reverseMap).not.toHaveBeenCalled()
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_UNMAPPED_MESSAGE)
})

test('routes in-library files into the fast-add flow', async () => {
  const r = routing({ partition: { inside: ['Movies/a.mp4', 'Movies/b.mp4'], outsideCount: 0 } })
  await handleFileDrop(['/Volumes/Media/Movies/a.mp4', '/Volumes/Media/Movies/b.mp4'], r.config)
  expect(r.reverseMap).toHaveBeenCalledWith('lib-one', [
    '/Volumes/Media/Movies/a.mp4',
    '/Volumes/Media/Movies/b.mp4',
  ])
  expect(r.onFastAdd).toHaveBeenCalledWith(['Movies/a.mp4', 'Movies/b.mp4'])
  expect(r.onFlash).not.toHaveBeenCalled()
})

test('adds the in-library files and notes the ones left outside', async () => {
  const r = routing({ partition: { inside: ['Movies/a.mp4'], outsideCount: 2 } })
  await handleFileDrop(['/Volumes/Media/Movies/a.mp4', '/tmp/x.mp4', '/tmp/y.mp4'], r.config)
  expect(r.onFastAdd).toHaveBeenCalledWith(['Movies/a.mp4'])
  expect(r.onFlash).toHaveBeenCalledOnce()
  expect(r.onFlash.mock.calls[0]?.[0]).toContain('2 files were outside')
})

test('explains in-place linking when every dropped file is outside the library', async () => {
  const r = routing({ partition: { inside: [], outsideCount: 1 } })
  await handleFileDrop(['/tmp/x.mp4'], r.config)
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith(DROP_OUTSIDE_MESSAGE)
})

test('hands outside files to the W5 copy-in seam when it takes over', async () => {
  const onCopyIntoLibrary = vi.fn().mockReturnValue(true)
  const r = routing({ partition: { inside: [], outsideCount: 2 }, onCopyIntoLibrary })
  await handleFileDrop(['/tmp/x.mp4', '/tmp/y.mp4'], r.config)
  expect(onCopyIntoLibrary).toHaveBeenCalledWith(['/tmp/x.mp4', '/tmp/y.mp4'], 2)
  // The seam handled the drop, so no explanation is shown.
  expect(r.onFlash).not.toHaveBeenCalled()
})

test('surfaces a structured reverse-map failure (e.g. the mount went offline)', async () => {
  const r = routing({
    reverseMap: vi.fn().mockRejectedValue({ code: 'volume_not_mounted', message: 'ignored' }),
  })
  await handleFileDrop(['/Volumes/Media/a.mp4'], r.config)
  expect(r.onFastAdd).not.toHaveBeenCalled()
  expect(r.onFlash).toHaveBeenCalledWith('Volume not mounted. Reconnect it and try again.')
})
