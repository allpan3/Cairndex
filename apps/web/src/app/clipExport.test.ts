import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  CLIP_FPS_CHOICES,
  DEFAULT_CLIP_FPS,
  DEFAULT_CLIP_WIDTH,
  clipFileName,
  clipWidthOptions,
  defaultClipWidth,
  isWidthCapped,
  outputHeight,
  saveClipGif,
} from './clipExport'

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

test('names the file from the title, without the source extension', () => {
  expect(clipFileName('bouncing pattern.mp4')).toBe('bouncing pattern.gif')
  expect(clipFileName('clip.mkv')).toBe('clip.gif')
  // A dot that is not an extension is part of the name.
  expect(clipFileName('Scene 2.5 rework')).toBe('Scene 2.5 rework.gif')
  expect(clipFileName('no extension')).toBe('no extension.gif')
  // What a filename cannot hold goes, and an empty result still names something.
  expect(clipFileName('a/b:c*d?.mkv')).toBe('a b c d.gif')
  expect(clipFileName('')).toBe('clip.gif')
})

test('saves under that name on desktop', async () => {
  isDesktop.mockReturnValue(true)
  await saveClipGif({ fileId: 'file-1', title: 'a/b:c*d?.mkv' }, RANGE, {}, vi.fn())
  expect(saveExport.mock.calls[0]?.[0]).toBe('a b c d.gif')
})

/** Compact view of the offered widths, for readable assertions. */
const widths = (source: number | null | undefined) =>
  clipWidthOptions(source).map((option) => `${option.label}:${option.value}`)

test('offers the fixed sizes below the source, then the source itself', () => {
  expect(widths(1920)).toEqual(['320px:320', '480px:480', '720px:720', 'Original:1920'])
  expect(widths(960)).toEqual(['320px:320', '480px:480', '720px:720', 'Original:960'])
})

// Nothing on offer should upscale, and nothing should appear twice — a 720p
// source must not show Original beside a redundant 720.
test('drops fixed sizes at or above the source', () => {
  expect(widths(720)).toEqual(['320px:320', '480px:480', 'Original:720'])
  expect(widths(640)).toEqual(['320px:320', '480px:480', 'Original:640'])
  expect(widths(400)).toEqual(['320px:320', 'Original:400'])
})

test('a source narrower than every fixed size still offers its own width', () => {
  expect(widths(300)).toEqual(['Original:300'])
  expect(widths(301)).toEqual(['Original:300'])
  // Never below the server's floor, even for a pathologically small source.
  expect(widths(64)).toEqual(['Original:120'])
})

// A 4K source exported at 1920 is not its original size, so it is not called
// that — the number is the honest label.
test('labels the top option by number when the source exceeds the maximum', () => {
  expect(widths(3840)).toEqual(['320px:320', '480px:480', '720px:720', '1920px:1920'])
  expect(isWidthCapped(3840)).toBe(true)
  expect(isWidthCapped(1920)).toBe(false)
  expect(isWidthCapped(null)).toBe(false)
})

test('offers the fixed sizes alone when the source has not been probed', () => {
  expect(widths(null)).toEqual(['320px:320', '480px:480', '720px:720'])
  expect(widths(0)).toEqual(['320px:320', '480px:480', '720px:720'])
})

test('starts on the default width, or the largest still offered', () => {
  expect(defaultClipWidth(clipWidthOptions(1920))).toBe(DEFAULT_CLIP_WIDTH)
  expect(defaultClipWidth(clipWidthOptions(640))).toBe(DEFAULT_CLIP_WIDTH)
  // Below the default, the source's own width is all that is left.
  expect(defaultClipWidth(clipWidthOptions(400))).toBe(400)
  expect(defaultClipWidth(clipWidthOptions(300))).toBe(300)
})

// A GIF's frame delay is stored in whole centiseconds, so only rates dividing
// 100 play back at the rate they were asked for. 10 is the one preset that
// does; 12 becomes 12.5 and 15 becomes 16.7, both measured on real output.
test('defaults to the one frame rate a GIF can represent exactly', () => {
  expect(DEFAULT_CLIP_FPS).toBe(10)
  expect(100 % DEFAULT_CLIP_FPS).toBe(0)
  expect(CLIP_FPS_CHOICES).toContain(DEFAULT_CLIP_FPS)
})

// Mirrors ffmpeg's `scale=W:-2`: aspect preserved, height rounded even.
test('derives the output height from the source aspect, always even', () => {
  expect(outputHeight(480, 1920, 1080)).toBe(270)
  expect(outputHeight(320, 1920, 1080)).toBe(180)
  // 4:3 at 240 is 180; an odd result rounds to even rather than failing in the
  // filter graph.
  expect(outputHeight(240, 640, 480)).toBe(180)
  expect(outputHeight(320, 1080, 1920)).toBe(568)
})

test('has no height to report for an unprobed source', () => {
  expect(outputHeight(480, null, null)).toBeNull()
  expect(outputHeight(480, 1920, null)).toBeNull()
  expect(outputHeight(480, 0, 0)).toBeNull()
})

test('reports a failed download without throwing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
  const report = vi.fn()

  await saveClipGif(TARGET, RANGE, {}, report)
  expect(report).toHaveBeenLastCalledWith('The GIF could not be fetched (HTTP 503).')
})
