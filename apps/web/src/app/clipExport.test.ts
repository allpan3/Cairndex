import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { saveClipGif } from './clipExport'

const created = vi.fn()
const polled = vi.fn()
const deleted = vi.fn()

vi.mock('../api/client', () => ({
  createClipExport: (...args: unknown[]) => created(...args),
  fetchClipExport: (...args: unknown[]) => polled(...args),
  deleteClipExport: (...args: unknown[]) => deleted(...args),
  clipExportDownloadUrl: (fileId: string, exportId: string) =>
    `http://server/${fileId}/${exportId}/download`,
}))

const saveExport = vi.fn()
const isDesktop = vi.fn(() => false)
vi.mock('../platform', () => ({
  getHostPlatform: () => ({ saveExport }),
  isDesktopHost: () => isDesktop(),
}))

const TARGET = { fileId: 'file-1', title: 'A Clip' }
const RANGE = { start: 4, end: 9 }

beforeEach(() => {
  created.mockReset().mockResolvedValue({ export_id: 'x1', status: 'pending' })
  polled.mockReset().mockResolvedValue({ export_id: 'x1', status: 'done' })
  deleted.mockReset().mockResolvedValue(undefined)
  saveExport.mockReset().mockResolvedValue('/somewhere/A Clip.gif')
  isDesktop.mockReset().mockReturnValue(false)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['GIF89a']) }),
  )
  // jsdom has no object URLs, and the browser path builds one to download.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

test('creates the export from the marked range and reports progress', async () => {
  const report = vi.fn()
  await saveClipGif(TARGET, RANGE, {}, report)

  expect(created).toHaveBeenCalledWith('file-1', {
    kind: 'gif',
    start_s: 4,
    end_s: 9,
    width: null,
    fps: null,
  })
  // The ellipsis is how the viewer knows to leave the message up.
  expect(report.mock.calls[0]?.[0]).toBe('Building GIF…')
  expect(report).toHaveBeenLastCalledWith('GIF saved.')
})

test('passes size and rate through when given', async () => {
  await saveClipGif(TARGET, RANGE, { width: 320, fps: 15 }, vi.fn())
  expect(created).toHaveBeenCalledWith('file-1', expect.objectContaining({ width: 320, fps: 15 }))
})

test('polls until the export finishes', async () => {
  polled
    .mockResolvedValueOnce({ status: 'pending' })
    .mockResolvedValueOnce({ status: 'running' })
    .mockResolvedValueOnce({ status: 'done' })

  await saveClipGif(TARGET, RANGE, {}, vi.fn())
  expect(polled).toHaveBeenCalledTimes(3)
  expect(globalThis.fetch).toHaveBeenCalledOnce()
}, 10_000)

test('surfaces the server’s reason when the encode fails', async () => {
  polled.mockResolvedValue({ status: 'failed', error: 'The clip could not be encoded.' })
  const report = vi.fn()

  await saveClipGif(TARGET, RANGE, {}, report)
  expect(report).toHaveBeenLastCalledWith('The clip could not be encoded.')
  expect(globalThis.fetch).not.toHaveBeenCalled()
})

// The artifact is server-side state; leaving it behind after a failure means
// the data dir carries a dead export until the TTL sweeps it an hour later.
test('drops the artifact after both a success and a failure', async () => {
  await saveClipGif(TARGET, RANGE, {}, vi.fn())
  expect(deleted).toHaveBeenCalledWith('file-1', 'x1')

  deleted.mockClear()
  polled.mockResolvedValue({ status: 'failed', error: 'nope' })
  await saveClipGif(TARGET, RANGE, {}, vi.fn())
  expect(deleted).toHaveBeenCalledWith('file-1', 'x1')
})

test('hands the blob to the host on desktop rather than downloading', async () => {
  isDesktop.mockReturnValue(true)
  const report = vi.fn()

  await saveClipGif(TARGET, RANGE, {}, report)
  expect(saveExport).toHaveBeenCalledOnce()
  const [name, blob] = saveExport.mock.calls[0] as [string, Blob]
  expect(name).toBe('A Clip.gif')
  // A Blob, not a byte array: the seam sends it as a raw IPC body.
  expect(blob).toBeInstanceOf(Blob)
  expect(report).toHaveBeenLastCalledWith('GIF saved.')
})

// Cancelling the native dialog is a decision, not a failure — the viewer's
// notice is cleared rather than showing an error.
test('a cancelled native save clears the notice', async () => {
  isDesktop.mockReturnValue(true)
  saveExport.mockResolvedValue(null)
  const report = vi.fn()

  await saveClipGif(TARGET, RANGE, {}, report)
  expect(report).toHaveBeenLastCalledWith(null)
})

test('strips characters a filename cannot hold from the title', async () => {
  isDesktop.mockReturnValue(true)
  await saveClipGif({ fileId: 'file-1', title: 'a/b:c*d?.mkv' }, RANGE, {}, vi.fn())
  expect(saveExport.mock.calls[0]?.[0]).toBe('a b c d .mkv.gif')
})

test('reports a failed download without throwing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
  const report = vi.fn()

  await saveClipGif(TARGET, RANGE, {}, report)
  expect(report).toHaveBeenLastCalledWith('The GIF could not be fetched (HTTP 503).')
})
