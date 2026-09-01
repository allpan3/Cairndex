import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ClientCapabilities, PlaybackDecisionResponse } from '../../../api/client'
import { runDesktopExitTasks } from '../../../desktop/exitTasks'
import { sessionTouchOutcome, useHlsSession, type UseHlsSessionOptions } from './useHlsSession'

const mocks = vi.hoisted(() => {
  class HttpErrorMock extends Error {
    readonly status: number
    constructor(status: number) {
      super(`HTTP ${status}`)
      this.status = status
    }
  }
  return {
    requestPlaybackDecision: vi.fn(),
    deletePlaybackSession: vi.fn(() => Promise.resolve()),
    beaconTeardownSession: vi.fn(() => true),
    HttpError: HttpErrorMock,
  }
})

vi.mock('../../../api/client', () => ({
  requestPlaybackDecision: mocks.requestPlaybackDecision,
  deletePlaybackSession: mocks.deletePlaybackSession,
  beaconTeardownSession: mocks.beaconTeardownSession,
  HttpError: mocks.HttpError,
}))

const CAPS: ClientCapabilities = {
  protocols: ['progressive', 'hls'],
  containers: ['mp4'],
  video_codecs: ['h264'],
  audio_codecs: ['aac'],
  max_height: null,
  native_hls: false,
}

function options(fileId: string | null): UseHlsSessionOptions {
  return {
    fileId,
    browserPath: null,
    enabled: fileId !== null,
    directPlayable: false,
    directStreamUrl: '/f/stream',
    directMimeType: 'video/x-matroska',
    caps: CAPS,
    getCurrentTime: () => 12.5,
  }
}

function remuxDecision(id: string): PlaybackDecisionResponse {
  return {
    method: 'remux',
    reason: 'mkv container not in client capabilities',
    stream_url: null,
    session: { id, playlist_url: `/s/${id}/index.m3u8` },
    duration: 120,
    audio_streams: [],
    subtitles: [],
    chapters: [],
    storyboard_url: null,
    progress: null,
  }
}

function directDecision(): PlaybackDecisionResponse {
  return {
    method: 'direct',
    reason: '',
    stream_url: '/f/stream',
    session: null,
    duration: 120,
    audio_streams: [],
    subtitles: [],
    chapters: [],
    storyboard_url: null,
    progress: null,
  }
}

function render(fileId: string | null = 'f1') {
  return renderHook(({ id }: { id: string | null }) => useHlsSession(options(id)), {
    initialProps: { id: fileId },
  })
}

beforeEach(() => {
  let seq = 0
  mocks.requestPlaybackDecision.mockReset()
  mocks.requestPlaybackDecision.mockImplementation(() =>
    Promise.resolve(remuxDecision(`s${++seq}`)),
  )
  mocks.deletePlaybackSession.mockReset()
  mocks.deletePlaybackSession.mockResolvedValue(undefined)
  mocks.beaconTeardownSession.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('a remux decision starts an HLS source and tears the session down on unmount', async () => {
  const { result, unmount } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('hls'))
  expect(result.current.source?.src).toBe('/s/s1/index.m3u8')
  expect(result.current.source?.nativeHls).toBe(false)

  unmount()
  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith({ kind: 'file', fileId: 'f1' }, 's1')
})

test('a saved-moment open starts the first HLS session at that moment', async () => {
  const { result } = renderHook(() =>
    useHlsSession({
      ...options('f1'),
      initialStartAt: 42.5,
    }),
  )

  await waitFor(() => expect(result.current.source?.kind).toBe('hls'))
  expect(mocks.requestPlaybackDecision.mock.calls[0]?.[1]).toMatchObject({
    force_hls: false,
    start_s: 42.5,
  })
  expect(result.current.source?.startAt).toBe(42.5)
})

test('beacons the live session on web pagehide', async () => {
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('hls'))

  act(() => window.dispatchEvent(new Event('pagehide')))

  expect(mocks.beaconTeardownSession).toHaveBeenCalledWith({ kind: 'file', fileId: 'f1' }, 's1')
})

test('awaits ordinary session teardown during desktop exit', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {})
  let resolveDelete!: () => void
  mocks.deletePlaybackSession.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolveDelete = resolve
      }),
  )
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('hls'))

  let settled = false
  const exiting = runDesktopExitTasks().then(() => {
    settled = true
  })
  await Promise.resolve()

  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith({ kind: 'file', fileId: 'f1' }, 's1')
  expect(settled).toBe(false)
  act(() => window.dispatchEvent(new Event('pagehide')))
  expect(mocks.beaconTeardownSession).not.toHaveBeenCalled()

  resolveDelete()
  await exiting
  expect(settled).toBe(true)
})

test('switching files tears down the previous file session', async () => {
  const { result, rerender } = render('f1')
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s1/index.m3u8'))

  rerender({ id: 'f2' })
  await waitFor(() =>
    expect(mocks.deletePlaybackSession).toHaveBeenCalledWith({ kind: 'file', fileId: 'f1' }, 's1'),
  )
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s2/index.m3u8'))
})

test('a quality switch re-decides and tears down the superseded session', async () => {
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s1/index.m3u8'))
  expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(1)

  act(() => result.current.setParam('maxHeight', 720))
  await waitFor(() => expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(2))
  // The new decision carried the requested cap and resumed at the playhead.
  const secondCall = mocks.requestPlaybackDecision.mock.calls[1]
  expect(secondCall?.[1]?.max_height).toBe(720)
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s2/index.m3u8'))
  expect(result.current.source?.startAt).toBe(12.5)
  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith({ kind: 'file', fileId: 'f1' }, 's1')
})

test('a direct decision plays natively without starting a session', async () => {
  mocks.requestPlaybackDecision.mockImplementation(() => Promise.resolve(directDecision()))
  const { result, unmount } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('native'))
  expect(result.current.source?.src).toBe('/f/stream')

  unmount()
  expect(mocks.deletePlaybackSession).not.toHaveBeenCalled()
})

test('an underfeeding direct source switches to copy-only HLS at the playhead', async () => {
  mocks.requestPlaybackDecision
    .mockResolvedValueOnce(directDecision())
    .mockResolvedValueOnce(remuxDecision('fallback'))
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('native'))

  act(() => expect(result.current.fallbackToHls()).toBe(true))
  await waitFor(() => expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(2))
  expect(mocks.requestPlaybackDecision.mock.calls[1]?.[1]).toMatchObject({
    force_hls: true,
    start_s: 12.5,
  })
  await waitFor(() => expect(result.current.source?.kind).toBe('hls'))
  expect(result.current.source).toMatchObject({
    src: '/s/fallback/index.m3u8',
    startAt: 12.5,
  })
})

test('a client without HLS keeps its direct source', async () => {
  mocks.requestPlaybackDecision.mockResolvedValue(directDecision())
  const progressiveCaps = { ...CAPS, protocols: ['progressive'] }
  const { result } = renderHook(() =>
    useHlsSession({
      ...options('f1'),
      caps: progressiveCaps,
    }),
  )
  await waitFor(() => expect(result.current.source?.kind).toBe('native'))

  act(() => expect(result.current.fallbackToHls()).toBe(false))
  expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(1)
})

test('reports the method the server chose, so the info panel can name it', async () => {
  const { result } = render('f1')
  await waitFor(() => expect(result.current.method).toBe('remux'))

  mocks.requestPlaybackDecision.mockImplementation(() => Promise.resolve(directDecision()))
  const direct = render('f2')
  await waitFor(() => expect(direct.result.current.method).toBe('direct'))
})

test('re-attach re-requests a fresh session at the current playhead', async () => {
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s1/index.m3u8'))

  let applied = false
  act(() => {
    applied = result.current.reattach()
  })
  expect(applied).toBe(true)
  await waitFor(() => expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s2/index.m3u8'))
  expect(result.current.source?.startAt).toBe(12.5)
})

test('reaps a session the server started for a decision the client aborted', async () => {
  // The response arrives after the effect was torn down (fast open→close): the
  // server may have started a session, so it must be reaped, not orphaned.
  let resolve!: (decision: PlaybackDecisionResponse) => void
  mocks.requestPlaybackDecision.mockImplementation(
    () => new Promise<PlaybackDecisionResponse>((res) => (resolve = res)),
  )
  const { unmount } = render('f1')
  unmount() // aborts the in-flight decision
  await act(async () => {
    resolve(remuxDecision('orphan'))
    await Promise.resolve()
  })
  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith({ kind: 'file', fileId: 'f1' }, 'orphan')
})

test('a double-error burst consumes a single re-attach slot', async () => {
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s1/index.m3u8'))
  expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(1)

  // Two stage errors in the same burst (before the re-attach resolves): the
  // first re-attaches, the second is swallowed — one budget slot, not a failure.
  let first = false
  let second = false
  act(() => {
    first = result.current.reattach()
    second = result.current.reattach()
  })
  expect(first).toBe(true)
  expect(second).toBe(true)
  await waitFor(() => expect(result.current.source?.src).toBe('/s/s2/index.m3u8'))
  // Only one extra decision fired — the second error did not bump the epoch.
  expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(2)

  // The burst spent one of three slots, so more re-attaches remain available.
  act(() => {
    expect(result.current.reattach()).toBe(true)
  })
  await waitFor(() => expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(3))
})

test('retries a capacity (429) decision once before surfacing it', async () => {
  let calls = 0
  mocks.requestPlaybackDecision.mockImplementation(() => {
    calls += 1
    if (calls === 1) return Promise.reject(new mocks.HttpError(429))
    return Promise.resolve(remuxDecision('after-retry'))
  })
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.src).toBe('/s/after-retry/index.m3u8'), {
    timeout: 2000,
  })
  expect(calls).toBe(2)
})

test('a server error on a non-degradable decision surfaces an unavailable state', async () => {
  // A remux/transcode file (not directly playable) whose decision fails with a
  // 5xx — e.g. the server's DB pool is exhausted — must show the distinct
  // "server unavailable" card, not the format "can't play" card.
  mocks.requestPlaybackDecision.mockRejectedValue(new mocks.HttpError(500))
  const { result } = render('f1')
  await waitFor(() => expect(result.current.status).toBe('unavailable'))
  expect(result.current.reason).toMatch(/unavailable/i)
})

test('an unanswered decision times out to a retryable unavailable state', async () => {
  vi.useFakeTimers()
  try {
    // A decision that never resolves until its request is aborted (as fetch does
    // when the client deadline fires).
    mocks.requestPlaybackDecision.mockImplementation(
      (_id: string, _payload: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const { result } = render('f1')

    // Before the deadline: still preparing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000)
    })
    expect(result.current.status).toBe('deciding')

    // Past the deadline: aborts and surfaces the unavailable card.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(result.current.status).toBe('unavailable')
    expect(result.current.reason).toMatch(/unavailable/i)

    // Retrying re-runs the decision; a now-healthy server plays.
    mocks.requestPlaybackDecision.mockResolvedValueOnce(remuxDecision('s-retry'))
    await act(async () => {
      result.current.retry()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.source?.src).toBe('/s/s-retry/index.m3u8')
  } finally {
    vi.useRealTimers()
  }
})

/**
 * Options for a source the server cannot be asked about: no row, and no path
 * either. What is left is the raw bytes and the media element's own verdict.
 */
function pathOptions(streamUrl: string): UseHlsSessionOptions {
  return {
    fileId: null,
    browserPath: null,
    enabled: true,
    directPlayable: true,
    directStreamUrl: streamUrl,
    directMimeType: 'video/mp4',
    caps: CAPS,
    getCurrentTime: () => 12.5,
  }
}

test('a source with nothing to decide about plays natively', async () => {
  const { result } = renderHook(() => useHlsSession(pathOptions('/file?path=loose.mp4')))

  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.source).toMatchObject({
    kind: 'native',
    src: '/file?path=loose.mp4',
    mimeType: 'video/mp4',
    startAt: 0,
  })
  // Neither a row nor a path, so there is nothing to ask the server about.
  expect(mocks.requestPlaybackDecision).not.toHaveBeenCalled()
  // Nothing to re-attach either — recovery falls to the native reload path.
  expect(result.current.reattach()).toBe(false)
})

test('stepping between undecidable sources does not carry the previous playhead', async () => {
  const { result, rerender } = renderHook(
    ({ url }: { url: string }) => useHlsSession(pathOptions(url)),
    {
      initialProps: { url: '/file?path=a.mp4' },
    },
  )
  await waitFor(() => expect(result.current.source?.src).toBe('/file?path=a.mp4'))

  // A recovery reload resumes this file at the live playhead.
  act(() => result.current.retry())
  await waitFor(() => expect(result.current.source?.startAt).toBe(12.5))

  // A different URL is a different file, so it starts at zero even though both
  // share a null file id and a null path.
  rerender({ url: '/file?path=b.mp4' })
  await waitFor(() => expect(result.current.source?.src).toBe('/file?path=b.mp4'))
  expect(result.current.source?.startAt).toBe(0)
})

test('a source with no readable URL at all stays idle', async () => {
  const { result } = renderHook(() => useHlsSession({ ...pathOptions(''), directStreamUrl: null }))

  await waitFor(() => expect(result.current.status).toBe('idle'))
  expect(result.current.source).toBeNull()
  expect(mocks.requestPlaybackDecision).not.toHaveBeenCalled()
})

test('an unindexed File Browser path still gets a decision, addressed by path', () => {
  // Before this, a path with no row skipped the decision entirely and played
  // natively, so a never-scanned library could show only what the browser
  // itself decodes (owner-reported, 2026-08-15).
  const { result } = renderHook(() =>
    useHlsSession({
      ...options('f1'),
      fileId: null,
      browserPath: 'Set07/clip1.mkv',
    }),
  )

  expect(mocks.requestPlaybackDecision).toHaveBeenCalledWith(
    { kind: 'path', path: 'Set07/clip1.mkv' },
    expect.anything(),
    expect.anything(),
  )
  expect(result.current).toBeDefined()
})

test('a row wins over a path, so an indexed entry keeps its subtitles and resume', () => {
  renderHook(() =>
    useHlsSession({ ...options('f1'), fileId: 'f1', browserPath: 'Set07/clip1.mkv' }),
  )

  expect(mocks.requestPlaybackDecision).toHaveBeenCalledWith(
    { kind: 'file', fileId: 'f1' },
    expect.anything(),
    expect.anything(),
  )
})

test('neither a row nor a path means no decision at all', () => {
  renderHook(() => useHlsSession({ ...options(null), fileId: null, browserPath: null }))

  expect(mocks.requestPlaybackDecision).not.toHaveBeenCalled()
})

// A paused video fetches no segments, so the server's idle reaper deleted the
// session underneath an open viewer — and seeking past the buffered region then
// found a hole that hls.js turned into a truncated duration rather than an error
// (owner-reported, 2026-08-16: 18:31 shown for a 68-minute video).
test('a held session is kept warm so the server does not reap it', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response))
  vi.stubGlobal('fetch', fetchMock)
  try {
    render('f1')
    await vi.advanceTimersByTimeAsync(0)

    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20_000)
    // The playlist, which refreshes last_access and costs nothing else.
    expect(fetchMock).toHaveBeenCalledWith('/s/s1/index.m3u8', expect.anything())
    await vi.advanceTimersByTimeAsync(40_000)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3)
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

test('a transient network failure on the touch is ignored', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  )
  try {
    render('f1')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)

    // Still one decision: a failed touch is not evidence the session is gone.
    expect(mocks.requestPlaybackDecision).toHaveBeenCalledTimes(1)
  } finally {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
})

// The policy the keepalive applies, named and tested on its own: fighting fake
// timers to observe it through the hook proved far less clear than this.
test('a keepalive response says alive, gone, or nothing at all', () => {
  // Definitive: the server has no such session, so a new one must be made.
  expect(sessionTouchOutcome(404)).toBe('gone')
  expect(sessionTouchOutcome(410)).toBe('gone')
  // Healthy.
  expect(sessionTouchOutcome(200)).toBe('alive')
  // A blip, or the server briefly refusing: no information about the session,
  // and throwing a working one away over it would be the worse mistake.
  expect(sessionTouchOutcome(null)).toBe('unknown')
  expect(sessionTouchOutcome(503)).toBe('alive')
  expect(sessionTouchOutcome(429)).toBe('alive')
})
