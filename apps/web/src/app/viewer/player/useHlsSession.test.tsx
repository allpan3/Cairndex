import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ClientCapabilities, PlaybackDecisionResponse } from '../../../api/client'
import { useHlsSession, type UseHlsSessionOptions } from './useHlsSession'

const mocks = vi.hoisted(() => ({
  requestPlaybackDecision: vi.fn(),
  deletePlaybackSession: vi.fn(() => Promise.resolve()),
  beaconTeardownSession: vi.fn(() => true),
}))

vi.mock('../../../api/client', () => ({
  requestPlaybackDecision: mocks.requestPlaybackDecision,
  deletePlaybackSession: mocks.deletePlaybackSession,
  beaconTeardownSession: mocks.beaconTeardownSession,
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
  mocks.deletePlaybackSession.mockClear()
  mocks.beaconTeardownSession.mockClear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('a remux decision starts an HLS source and tears the session down on unmount', async () => {
  const { result, unmount } = render('f1')
  await waitFor(() => expect(result.current.source?.kind).toBe('hls'))
  expect(result.current.method).toBe('remux')
  expect(result.current.source?.src).toBe('/s/s1/index.m3u8')
  expect(result.current.source?.nativeHls).toBe(false)

  unmount()
  expect(mocks.deletePlaybackSession).toHaveBeenCalledWith('f1', 's1')
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

  act(() => result.current.setMaxHeight(720))
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
