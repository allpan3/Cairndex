import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { fileStoryboardUrl, setActiveLibraryId } from '../api/client'
import { HoverPreview } from './HoverPreview'
import {
  HOVER_PREVIEW_DWELL_MS,
  HOVER_PREVIEW_PREFETCH_MS,
  HOVER_PREVIEW_REST_MS,
  hoverPreviewMode,
  hoverStartTime,
  hoverTimeForPointer,
  type HoverPreviewSource,
} from './hoverPreviewState'
import type { ClientCapabilities } from './viewer/player/caps'
import { parseStoryboardVtt, type StoryboardCue } from './viewer/player/storyboardVtt'

const DIRECT_SOURCE: HoverPreviewSource = {
  mediaKind: 'video',
  fileId: 'direct-file',
  mimeType: null,
  relativePath: 'clips/direct.mp4',
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  audioCodec: 'aac',
  duration: 100,
}

const VTT = `WEBVTT

00:00:00.000 --> 00:00:50.000
storyboard/sb_001.jpg?v=test#xywh=0,0,320,180

00:00:50.000 --> 00:01:40.000
storyboard/sb_001.jpg?v=test#xywh=320,0,320,180
`
const CUES = parseStoryboardVtt(VTT)

const CAPS: ClientCapabilities = {
  protocols: ['progressive'],
  containers: ['mp4'],
  video_codecs: ['h264'],
  audio_codecs: ['aac'],
  max_height: null,
  native_hls: false,
}

// Bind one isolated storyboard cache to a rendered preview
function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

// Render one direct-play card with a stable 100px hover width
function renderPreview(
  source: HoverPreviewSource = DIRECT_SOURCE,
  storyboard: StoryboardCue[] | null | 'fetch' = null,
) {
  const client = new QueryClient()
  if (storyboard !== 'fetch') {
    client.setQueryData(['storyboard-vtt', fileStoryboardUrl(source.fileId)], storyboard)
  }
  const rendered = render(
    <HoverPreview source={source} className="card__thumb">
      <span>cover</span>
    </HoverPreview>,
    { wrapper: wrapperFor(client) },
  )
  const card = rendered.container.querySelector('.card__thumb') as HTMLElement
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 100,
    top: 0,
    height: 100,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  return { ...rendered, card, client }
}

// Hold a media seek until a test releases the browser's seeked event
function holdSeek(video: HTMLVideoElement) {
  let currentTime = video.currentTime
  let seeking = true
  const targets: number[] = []
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value
      targets.push(value)
    },
  })
  Object.defineProperty(video, 'seeking', {
    configurable: true,
    get: () => seeking,
  })
  return {
    targets,
    ready: () => {
      seeking = false
    },
    finish: () => {
      seeking = false
      fireEvent(video, new Event('seeked'))
    },
  }
}

// Hold the compositor-frame signal so visibility can be asserted before paint
function holdPresentedFrame(video: HTMLVideoElement) {
  let callback: VideoFrameRequestCallback | null = null
  Object.defineProperty(video, 'requestVideoFrameCallback', {
    configurable: true,
    value: (next: VideoFrameRequestCallback) => {
      callback = next
      return 2
    },
  })
  return {
    present: (mediaTime?: number) => {
      const next = callback
      callback = null
      next?.(0, { mediaTime } as VideoFrameCallbackMetadata)
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  setActiveLibraryId('lib1')
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false }) as MediaQueryList),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type) =>
    type.startsWith('video/mp4') || type.startsWith('audio/mp4') ? 'probably' : '',
  )
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value: (callback: VideoFrameRequestCallback) => {
      window.queueMicrotask(() => callback(0, {} as VideoFrameCallbackMetadata))
      return 1
    },
  })
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value: vi.fn(),
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
})

afterEach(() => {
  cleanup()
  setActiveLibraryId(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLMediaElement.prototype as unknown as { fastSeek?: unknown }).fastSeek
  delete (HTMLMediaElement.prototype as unknown as { readyState?: unknown }).readyState
  delete (HTMLVideoElement.prototype as unknown as { requestVideoFrameCallback?: unknown })
    .requestVideoFrameCallback
  delete (HTMLVideoElement.prototype as unknown as { cancelVideoFrameCallback?: unknown })
    .cancelVideoFrameCallback
})

test('waits for dwell and cancels before mounting a stream', () => {
  const { card, queryByTestId } = renderPreview()

  fireEvent.pointerEnter(card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS - 1))
  expect(queryByTestId('hover-preview-video')).toBeNull()

  fireEvent.pointerLeave(card)
  act(() => vi.advanceTimersByTime(1_000))
  expect(queryByTestId('hover-preview-video')).toBeNull()
})

test('shows the cursor image as a still after dwell', async () => {
  const source: HoverPreviewSource = {
    mediaKind: 'image',
    fileId: 'photo-file',
    imageUrl: '/api/v1/libraries/lib1/bundles/b1/files/photo-file/thumbnail',
  }
  const { card, getByTestId, queryByTestId } = renderPreview(source)

  await act(async () => {
    fireEvent.pointerEnter(card)
    await Promise.resolve()
  })
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))

  const image = getByTestId('hover-preview-image')
  expect(image).toHaveAttribute('src', source.imageUrl)
  expect(card).toHaveAttribute('data-hover-preview-mode', 'image')
  expect(queryByTestId('hover-preview-video')).toBeNull()
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
})

test('keeps the sprite visible and resumes from its sampled cue time', async () => {
  const { card, getByTestId, queryByTestId } = renderPreview(DIRECT_SOURCE, CUES)

  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  const seek = holdSeek(video)
  const frame = holdPresentedFrame(video)
  expect(video).toBeVisible()
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)

  fireEvent.pointerMove(card, { clientX: 25 })
  expect(card).toHaveAttribute('data-hover-preview-state', 'skimming')
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS - 50))
  fireEvent.pointerMove(card, { clientX: 75 })
  expect(card.querySelector('.hover-preview__clock')).toHaveTextContent('1:15')
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
  expect(video.getAttribute('src')).toContain('/files/direct-file/stream')
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()
  expect(seek.targets).toEqual([])

  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS - 1))
  expect(seek.targets).toEqual([])
  act(() => vi.advanceTimersByTime(1))
  expect(card).toHaveAttribute('data-hover-preview-state', 'transitioning')
  expect(seek.targets).toEqual([50])
  expect(card.querySelector('.hover-preview__clock')).toHaveTextContent('0:50')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()

  await act(async () => {
    seek.finish()
    await Promise.resolve()
  })

  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()

  act(() => frame.present(49))

  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()

  act(() => frame.present(50))

  expect(card).toHaveAttribute('data-hover-preview-state', 'transitioning')
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)

  await act(async () => {
    vi.advanceTimersByTime(20)
    await Promise.resolve()
  })

  expect(card).toHaveAttribute('data-hover-preview-state', 'playing')
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
  expect(queryByTestId('hover-preview-storyboard')).toBeNull()
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
  expect(hoverTimeForPointer(-10, card.getBoundingClientRect(), 100)).toBe(0)
  expect(hoverTimeForPointer(120, card.getBoundingClientRect(), 100)).toBe(100)
})

test('tears down when pointer leave races the aligned-frame reveal', async () => {
  const { card, getByTestId, queryByTestId } = renderPreview(DIRECT_SOURCE, CUES)

  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  const seek = holdSeek(video)
  const frame = holdPresentedFrame(video)

  fireEvent.pointerMove(card, { clientX: 75 })
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS))
  await act(async () => {
    seek.finish()
    await Promise.resolve()
  })
  act(() => frame.present(50))

  expect(card).toHaveAttribute('data-hover-preview-state', 'transitioning')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)

  fireEvent.pointerLeave(card)
  expect(queryByTestId('hover-preview-video')).toBeNull()

  await act(async () => {
    vi.advanceTimersByTime(20)
    await Promise.resolve()
  })
  expect(queryByTestId('hover-preview-video')).toBeNull()
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
})

test('bounds a missing post-seek frame callback before resuming', async () => {
  const { card, getByTestId, queryByTestId } = renderPreview(DIRECT_SOURCE, CUES)

  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  const seek = holdSeek(video)
  holdPresentedFrame(video)

  fireEvent.pointerMove(card, { clientX: 75 })
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS))
  await act(async () => {
    seek.finish()
    await Promise.resolve()
  })

  act(() => vi.advanceTimersByTime(249))
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()

  await act(async () => {
    vi.advanceTimersByTime(1)
    await Promise.resolve()
  })
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()
  expect(card).toHaveAttribute('data-hover-preview-state', 'transitioning')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)

  await act(async () => {
    vi.advanceTimersByTime(20)
    await Promise.resolve()
  })
  expect(queryByTestId('hover-preview-storyboard')).toBeNull()
  expect(card).toHaveAttribute('data-hover-preview-state', 'playing')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
})

test('resolves a storyboard that arrives during the rest debounce before seeking', async () => {
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => undefined))
  const { card, client, getByTestId } = renderPreview(DIRECT_SOURCE, 'fetch')

  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  const seek = holdSeek(video)

  fireEvent.pointerMove(card, { clientX: 75 })
  expect(card.querySelector('.hover-preview__clock')).toHaveTextContent('1:15')
  expect(seek.targets).toEqual([])

  await act(async () => {
    client.setQueryData(['storyboard-vtt', fileStoryboardUrl(DIRECT_SOURCE.fileId)], CUES)
    vi.advanceTimersByTime(0)
    await Promise.resolve()
  })
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()

  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS))

  expect(seek.targets).toEqual([50])
  expect(card.querySelector('.hover-preview__clock')).toHaveTextContent('0:50')
})

test('masks the resting seek with the static cover when no storyboard exists', async () => {
  const { card, getByTestId, queryByTestId } = renderPreview(DIRECT_SOURCE, null)
  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  const seek = holdSeek(video)

  fireEvent.pointerMove(card, { clientX: 60 })

  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
  expect(video).toBeVisible()
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
  expect(video.getAttribute('src')).toContain('/files/direct-file/stream')
  expect(queryByTestId('hover-preview-storyboard')).toBeNull()
  expect(seek.targets).toEqual([])
  expect(card.querySelector('.hover-preview__clock')).toHaveTextContent('1:00')

  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS))
  expect(seek.targets).toEqual([60])
  expect(video).toHaveClass('hover-preview__video--sprite-hidden')
  expect(queryByTestId('hover-preview-storyboard')).toBeNull()
  expect(card.querySelector('.hover-preview__clock')).toHaveTextContent('1:00')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)

  await act(async () => {
    seek.finish()
    await Promise.resolve()
  })

  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
})

test('places the sound control before an independently right-anchored clock', async () => {
  const { card, container } = renderPreview(DIRECT_SOURCE, CUES)
  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })

  const controls = container.querySelector('.hover-preview__controls')
  expect(controls?.children[0]).toHaveClass('hover-preview__sound')
  expect(controls?.children[1]).toHaveClass('hover-preview__clock')
  expect(controls?.lastElementChild).toHaveClass('hover-preview__clock')
})

test('retries an unmuted resting resume without demoting the direct source', async () => {
  const { card, getByRole, getByTestId, queryByTestId } = renderPreview(DIRECT_SOURCE, CUES)
  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  fireEvent.click(getByRole('button', { name: 'Unmute preview' }))
  expect(video.muted).toBe(false)

  const seek = holdSeek(video)
  vi.mocked(HTMLMediaElement.prototype.play)
    .mockRejectedValueOnce(new DOMException('autoplay blocked', 'NotAllowedError'))
    .mockResolvedValueOnce()
  fireEvent.pointerMove(card, { clientX: 60 })
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS))

  await act(async () => {
    seek.finish()
    await Promise.resolve()
    await Promise.resolve()
  })
  await act(async () => {
    vi.advanceTimersByTime(20)
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(3)
  expect(video.muted).toBe(false)
  expect(video).toBeVisible()
  expect(queryByTestId('hover-preview-storyboard')).toBeNull()
  expect(card).toHaveAttribute('data-hover-preview-mode', 'direct')
})

test('resumes through the readiness check when seeked is omitted', async () => {
  const { card, getByTestId } = renderPreview(DIRECT_SOURCE, CUES)
  fireEvent.pointerEnter(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  const seek = holdSeek(video)
  fireEvent.pointerMove(card, { clientX: 55 })
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_REST_MS))
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)

  seek.ready()
  await act(async () => {
    vi.advanceTimersByTime(1_000)
    await Promise.resolve()
  })
  await act(async () => {
    vi.advanceTimersByTime(20)
    await Promise.resolve()
  })

  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2)
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
})

test('keeps direct mode when motion intentionally aborts the initial play promise', async () => {
  let rejectInitialPlay: (reason: unknown) => void = () => undefined
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectInitialPlay = reject
      }),
  )
  const { card, getByTestId } = renderPreview(DIRECT_SOURCE, CUES)
  fireEvent.pointerEnter(card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  const video = getByTestId('hover-preview-video') as HTMLVideoElement

  fireEvent.pointerMove(card, { clientX: 30 })
  await act(async () => {
    rejectInitialPlay(new DOMException('play interrupted by pause', 'AbortError'))
    await Promise.resolve()
  })

  expect(card).toHaveAttribute('data-hover-preview-mode', 'direct')
  expect(video).toBeInTheDocument()
  expect(video.getAttribute('src')).toContain('/files/direct-file/stream')
})

test('starts direct playback from incomplete saved progress', async () => {
  const { card, getByTestId } = renderPreview({ ...DIRECT_SOURCE, startTime: 42 }, CUES)
  fireEvent.pointerEnter(card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  const video = getByTestId('hover-preview-video') as HTMLVideoElement

  expect(video.currentTime).toBe(42)
  expect(card.querySelector('.hover-preview__clock')).toHaveTextContent('0:42')
  expect(video).toHaveClass('hover-preview__video--sprite-hidden')
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()

  await act(async () => {
    fireEvent(video, new Event('seeked'))
    await Promise.resolve()
  })

  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1)
  expect(video).not.toHaveClass('hover-preview__video--sprite-hidden')
})

test('prefetches the storyboard during dwell before mounting video', async () => {
  const fetchMock = vi.mocked(fetch)
  const { card, queryByTestId } = renderPreview(DIRECT_SOURCE, 'fetch')

  await act(async () => {
    fireEvent.pointerEnter(card)
    vi.advanceTimersByTime(HOVER_PREVIEW_PREFETCH_MS - 1)
    await Promise.resolve()
  })

  expect(fetchMock).not.toHaveBeenCalled()

  await act(async () => {
    vi.advanceTimersByTime(1)
    await Promise.resolve()
  })

  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/files/direct-file/storyboard.vtt'),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  )
  expect(queryByTestId('hover-preview-video')).toBeNull()
})

test('cancels storyboard prefetch during a rapid pointer sweep', async () => {
  const fetchMock = vi.mocked(fetch)
  const { card } = renderPreview(DIRECT_SOURCE, 'fetch')

  fireEvent.pointerEnter(card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_PREFETCH_MS - 1))
  fireEvent.pointerLeave(card)
  await act(async () => {
    vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS)
    await Promise.resolve()
  })

  expect(fetchMock).not.toHaveBeenCalled()
})

test('falls back when metadata never becomes ready for a resume seek', async () => {
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
    configurable: true,
    get: () => HTMLMediaElement.HAVE_NOTHING,
  })
  const { card, getByTestId, queryByTestId } = renderPreview(
    { ...DIRECT_SOURCE, startTime: 42 },
    CUES,
  )

  fireEvent.pointerEnter(card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  expect(getByTestId('hover-preview-video')).toBeInTheDocument()
  expect(card).toHaveAttribute('data-hover-preview-mode', 'direct')

  act(() => vi.advanceTimersByTime(4_999))
  expect(card).toHaveAttribute('data-hover-preview-mode', 'direct')

  await act(async () => {
    vi.advanceTimersByTime(1)
    await Promise.resolve()
  })

  expect(card).toHaveAttribute('data-hover-preview-mode', 'storyboard')
  expect(queryByTestId('hover-preview-video')).toBeNull()
  expect(getByTestId('hover-preview-storyboard')).toBeVisible()
})

test('transfers page-wide ownership to the latest dwelled card', () => {
  const first = renderPreview({ ...DIRECT_SOURCE, fileId: 'first' })
  const second = renderPreview({ ...DIRECT_SOURCE, fileId: 'second' })

  fireEvent.pointerEnter(first.card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  expect(first.container.querySelector('[data-testid="hover-preview-video"]')).not.toBeNull()

  fireEvent.pointerEnter(second.card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  expect(first.container.querySelector('[data-testid="hover-preview-video"]')).toBeNull()
  expect(second.container.querySelector('[data-testid="hover-preview-video"]')).not.toBeNull()
})

test('classifies direct, storyboard, and unavailable sources from caps', () => {
  expect(hoverPreviewMode(DIRECT_SOURCE, CAPS)).toBe('direct')
  expect(
    hoverPreviewMode(
      {
        ...DIRECT_SOURCE,
        mimeType: null,
        relativePath: 'movie.mkv',
        container: 'matroska,webm',
      },
      CAPS,
    ),
  ).toBe('storyboard')
  expect(hoverPreviewMode({ ...DIRECT_SOURCE, audioCodec: 'dts' }, CAPS)).toBe('storyboard')
  expect(hoverPreviewMode({ ...DIRECT_SOURCE, duration: 0 }, CAPS)).toBe('none')
  expect(hoverPreviewMode({ mediaKind: 'image', fileId: 'photo', imageUrl: '/photo' }, CAPS)).toBe(
    'image',
  )
  expect(hoverPreviewMode(null, CAPS)).toBe('none')
  expect(hoverStartTime({ ...DIRECT_SOURCE, startTime: 42 })).toBe(42)
  expect(hoverStartTime({ ...DIRECT_SOURCE, startTime: 120 })).toBe(100)
  expect(hoverStartTime({ ...DIRECT_SOURCE, startTime: null })).toBe(0)
})

test('resumes dwell when a menu or drag guard clears under the pointer', () => {
  const rendered = renderPreview()
  fireEvent.pointerEnter(rendered.card)
  rendered.rerender(
    <HoverPreview source={DIRECT_SOURCE} disabled className="card__thumb">
      <span>cover</span>
    </HoverPreview>,
  )
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  expect(rendered.queryByTestId('hover-preview-video')).toBeNull()

  rendered.rerender(
    <HoverPreview source={DIRECT_SOURCE} className="card__thumb">
      <span>cover</span>
    </HoverPreview>,
  )
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  expect(rendered.getByTestId('hover-preview-video')).toBeInTheDocument()
})

test('falls back to a storyboard when direct playback rejects', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(new Error('decode failed'))
  const { card, findByTestId, queryByTestId } = renderPreview(DIRECT_SOURCE, CUES)

  fireEvent.pointerEnter(card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  vi.useRealTimers()

  expect(await findByTestId('hover-preview-storyboard')).toBeInTheDocument()
  await expect.poll(() => card.getAttribute('data-hover-preview-mode')).toBe('storyboard')
  expect(queryByTestId('hover-preview-video')).toBeNull()
})

test('clears the video source and reloads it when unmounted mid-preview', () => {
  const { card, getByTestId, unmount } = renderPreview()
  fireEvent.pointerEnter(card)
  act(() => vi.advanceTimersByTime(HOVER_PREVIEW_DWELL_MS))
  const video = getByTestId('hover-preview-video') as HTMLVideoElement
  expect(video.getAttribute('src')).toContain('/files/direct-file/stream')

  unmount()

  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
  expect(video.hasAttribute('src')).toBe(false)
})
