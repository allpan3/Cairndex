import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  CLIP_FPS_CHOICES,
  DEFAULT_CLIP_FPS,
  DEFAULT_CLIP_WIDTH,
  clipFileName,
  clipFpsOptions,
  clipWidthOptions,
  defaultClipFps,
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

test('offers every rung the source can fill, ending at its own width', () => {
  const options = clipWidthOptions(1920)
  // A segmented row fit three or four; the wheel is what allows a real ladder.
  expect(options.length).toBeGreaterThan(8)
  expect(options.at(-1)).toEqual({ value: 1920, label: '1920px', note: 'native' })
  // Ascending, so the wheel reads left to right as smaller to larger.
  const values = options.map((option) => option.value)
  expect(values).toEqual([...values].sort((a, b) => a - b))
})

// Nothing on offer should upscale.
test('drops rungs at or above the source', () => {
  expect(widths(720).at(-1)).toBe('720px:720')
  expect(widths(720)).not.toContain('854px:854')
  expect(widths(400).at(-1)).toBe('400px:400')
  expect(widths(400)).not.toContain('480px:480')
})

// The native width joins the ladder rather than being rounded away — this is
// how a clip is exported at its own size now there is no "Original" button.
test('adds the source’s own width when it falls between rungs', () => {
  expect(widths(1100).at(-1)).toBe('1100px:1100')
  // Already a rung: marked native, not added a second time.
  expect(widths(960).filter((entry) => entry === '960px:960')).toHaveLength(1)
  expect(clipWidthOptions(960).at(-1)?.note).toBe('native')
})

test('a small source keeps the rungs it can fill, plus its own width', () => {
  expect(widths(300)).toEqual(['160px:160', '240px:240', '300px:300'])
  // Odd widths round down to even, for ffmpeg's `scale=W:-2`.
  expect(widths(301)).toEqual(['160px:160', '240px:240', '300px:300'])
  // Below every rung *and* below the server's floor: only the floor is left.
  expect(widths(64)).toEqual(['120px:120'])
})

test('stops at the exporter ceiling for a source above it', () => {
  expect(widths(3840).at(-1)).toBe('1920px:1920')
  expect(isWidthCapped(3840)).toBe(true)
  expect(isWidthCapped(1920)).toBe(false)
  expect(isWidthCapped(null)).toBe(false)
})

// Nothing to filter against and no native width to mark.
test('offers the whole ladder, unmarked, when the source has not been probed', () => {
  const options = clipWidthOptions(null)
  expect(options.length).toBeGreaterThan(8)
  expect(options.every((option) => option.note === undefined)).toBe(true)
  expect(clipWidthOptions(0)).toEqual(options)
})

test('starts on the default width, or the largest still offered', () => {
  expect(defaultClipWidth(clipWidthOptions(1920))).toBe(DEFAULT_CLIP_WIDTH)
  expect(defaultClipWidth(clipWidthOptions(640))).toBe(DEFAULT_CLIP_WIDTH)
  // Below the default, the source's own width is all that is left.
  expect(defaultClipWidth(clipWidthOptions(400))).toBe(400)
  expect(defaultClipWidth(clipWidthOptions(300))).toBe(300)
})

// A GIF's frame delay is stored in whole centiseconds, so the only rates it
// can represent are 100/n. Every rung must be one of those, or the clip plays
// at a speed nobody asked for: 12 becomes 12.5, 15 becomes 14.29, 30 becomes
// 33.33 — all measured off real output's frame control blocks.
test('offers only rates a GIF can hold exactly', () => {
  for (const rate of CLIP_FPS_CHOICES) {
    expect(100 % rate, `${rate} fps is not a whole number of centiseconds`).toBe(0)
  }
  expect(CLIP_FPS_CHOICES).toContain(DEFAULT_CLIP_FPS)
  // 50 fps is a 2cs delay; 1cs is the value historic viewers reinterpret.
  expect(Math.max(...CLIP_FPS_CHOICES)).toBe(50)
})

// Substantially more frames a second than the source has produces duplicates,
// not smoother motion — measured: a 25 fps source at 50 gained 50 frames and
// 1 KB, and a 30 fps source at 50 gained 67% duplicates for a fifth more bytes.
test('withholds rates the source cannot meaningfully supply', () => {
  expect(rates(25)).toEqual([5, 10, 20, 25])
  expect(rates(30)).toEqual([5, 10, 20, 25])
  expect(rates(60)).toEqual([5, 10, 20, 25, 50])
  // Unprobed: nothing to filter against.
  expect(rates(null)).toEqual([5, 10, 20, 25, 50])
  // Slower than every rung, but a choice is still needed.
  expect(rates(2)).toEqual([5])
})

// No exact rate lands on 24 fps, the commonest source rate there is. Cutting
// off at the source strands it at 20, which drops 17% of the motion, when 25
// duplicates two frames in forty-eight and is otherwise one for one. Both
// measured on real output.
test('lets a 24 fps source reach 25, which fits it far better than 20', () => {
  expect(rates(24)).toEqual([5, 10, 20, 25])
  // NTSC film, the same case one decimal over.
  expect(rates(23.976)).toEqual([5, 10, 20, 25])
  // …and 48 reaches 50 for the same reason.
  expect(rates(48)).toEqual([5, 10, 20, 25, 50])
  // The overshoot is a hair's breadth, not a licence: 30 still cannot reach 50.
  expect(rates(30)).not.toContain(50)
  expect(rates(25)).not.toContain(50)
})

// Marked only when the format can actually match the source. For 24 and 30 fps
// nothing can, and saying nothing is the honest version of that.
test('marks a rate as native only when it really is the source’s', () => {
  const noted = (source: number) =>
    clipFpsOptions(source)
      .filter((option) => option.note)
      .map((option) => `${option.value}:${option.note}`)
  expect(noted(25)).toEqual(['25:native'])
  expect(noted(10)).toEqual(['10:native'])
  expect(noted(24)).toEqual([])
  expect(noted(30)).toEqual([])
})

test('starts on the default rate, or the fastest still offered', () => {
  // 20 is reachable by every ordinary source, 24 and 30 included.
  expect(defaultClipFps(clipFpsOptions(24))).toBe(DEFAULT_CLIP_FPS)
  expect(defaultClipFps(clipFpsOptions(30))).toBe(DEFAULT_CLIP_FPS)
  expect(defaultClipFps(clipFpsOptions(null))).toBe(DEFAULT_CLIP_FPS)
  // Below the default, the fastest the source can supply.
  expect(defaultClipFps(clipFpsOptions(12))).toBe(10)
  expect(defaultClipFps(clipFpsOptions(2))).toBe(5)
})

/** Compact view of the offered rates. */
function rates(source: number | null): number[] {
  return clipFpsOptions(source).map((option) => option.value)
}

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
