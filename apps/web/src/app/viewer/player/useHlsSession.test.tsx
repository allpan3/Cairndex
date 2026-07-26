import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ClientCapabilities, PlaybackDecisionResponse } from '../../../api/client'
import { runDesktopExitTasks } from '../../../desktop/exitTasks'
import { useHlsSession, type UseHlsSessionOptions } from './useHlsSession'

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
  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith('f1', 's1')
})

test('beacons the live session on web pagehide', async () => {
  const { result } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('hls'))

  act(() => window.dispatchEvent(new Event('pagehide')))

  expect(mocks.beaconTeardownSession).toHaveBeenCalledWith('f1', 's1')
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

  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith('f1', 's1')
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
  await waitFor(() => expect(mocks.deletePlaybackSession).toHaveBeenCalledWith('f1', 's1'))
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
  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith('f1', 's1')
})

test('a direct decision plays natively without starting a session', async () => {
  mocks.requestPlaybackDecision.mockImplementation(() => Promise.resolve(directDecision()))
  const { result, unmount } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('native'))
  expect(result.current.source?.src).toBe('/f/stream')

  unmount()
  expect(mocks.deletePlaybackSession).not.toHaveBeenCalled()
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
  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith('f1', 'orphan')
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

/** Options for a path with no `AssetFile` row — the File Browser's unindexed case. */
function pathOptions(streamUrl: string): UseHlsSessionOptions {
  return {
    fileId: null,
    enabled: true,
    directPlayable: true,
    directStreamUrl: streamUrl,
    directMimeType: 'video/mp4',
    caps: CAPS,
    getCurrentTime: () => 12.5,
  }
}

test('an unindexed path plays natively without requesting a decision', async () => {
  const { result } = renderHook(() => useHlsSession(pathOptions('/file?path=loose.mp4')))

  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.source).toMatchObject({
    kind: 'native',
    src: '/file?path=loose.mp4',
    mimeType: 'video/mp4',
    startAt: 0,
  })
  // There is no file row to decide on, so the round-trip must be skipped.
  expect(mocks.requestPlaybackDecision).not.toHaveBeenCalled()
  // Nothing to re-attach either — recovery falls to the native reload path.
  expect(result.current.reattach()).toBe(false)
})

test('stepping between unindexed paths does not carry the previous playhead', async () => {
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

  // Switching to a different path is a different file, so it starts at zero even
  // though both share a null file id.
  rerender({ url: '/file?path=b.mp4' })
  await waitFor(() => expect(result.current.source?.src).toBe('/file?path=b.mp4'))
  expect(result.current.source?.startAt).toBe(0)
})

test('an unindexed path with no readable URL stays idle', async () => {
  const { result } = renderHook(() => useHlsSession({ ...pathOptions(''), directStreamUrl: null }))

  await waitFor(() => expect(result.current.status).toBe('idle'))
  expect(result.current.source).toBeNull()
  expect(mocks.requestPlaybackDecision).not.toHaveBeenCalled()
})
