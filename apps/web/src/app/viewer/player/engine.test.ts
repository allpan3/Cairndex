import { expect, test } from 'vitest'

import {
  createEngine,
  HlsEngine,
  NativeEngine,
  stageFailureOf,
  type PlaybackSource,
} from './engine'

function engineFor(source: PlaybackSource) {
  const video = document.createElement('video')
  return createEngine(video, source)
}

test('direct progressive sources use the native engine', () => {
  expect(engineFor({ src: '/f/stream', mimeType: 'video/mp4' })).toBeInstanceOf(NativeEngine)
  expect(engineFor({ src: '/f/stream', mimeType: 'video/mp4', kind: 'native' })).toBeInstanceOf(
    NativeEngine,
  )
})

test('native-HLS sources (Safari/WKWebView) use the native engine', () => {
  const engine = engineFor({
    src: '/s/index.m3u8',
    mimeType: 'application/vnd.apple.mpegurl',
    kind: 'hls',
    nativeHls: true,
  })
  expect(engine).toBeInstanceOf(NativeEngine)
})

test('MSE HLS sources use the hls.js engine', () => {
  const withFlag = engineFor({
    src: '/s/index.m3u8',
    mimeType: 'application/vnd.apple.mpegurl',
    kind: 'hls',
    nativeHls: false,
  })
  expect(withFlag).toBeInstanceOf(HlsEngine)
  // Absent nativeHls flag still means "not native" → hls.js.
  const noFlag = engineFor({
    src: '/s/index.m3u8',
    mimeType: 'application/vnd.apple.mpegurl',
    kind: 'hls',
  })
  expect(noFlag).toBeInstanceOf(HlsEngine)
})

test('base engine applies pitch preservation independently of playback rate', () => {
  const video = document.createElement('video')
  const engine = createEngine(video, { src: '/f/stream', mimeType: 'video/mp4' })
  engine.setRate(1.5)
  engine.setPreservesPitch(false)
  expect(video.playbackRate).toBe(1.5)
  expect(video.preservesPitch).toBe(false)
  engine.setPreservesPitch(true)
  expect(video.preservesPitch).toBe(true)
})

// --- why the engine gave up ---------------------------------------------

// The element's `MediaError` cannot carry this. hls.js delivers over
// MediaSource, so a reaped session whose segments 404 tears the source down and
// the browser reports `MEDIA_ERR_SRC_NOT_SUPPORTED` — a verdict about bytes
// that never arrived. Only the engine saw which kind of fatal hls.js raised.
test('reads the engine’s reason off a synthetic error event', () => {
  expect(stageFailureOf(new CustomEvent('error', { detail: 'session' }))).toBe('session')
  expect(stageFailureOf(new CustomEvent('error', { detail: 'decode' }))).toBe('decode')
})

// A browser-dispatched error carries no reason, and must not be mistaken for
// one: that is the case the player falls back to classifying by code.
test('reports no reason for an error the engine did not raise', () => {
  expect(stageFailureOf(new Event('error'))).toBeNull()
  expect(stageFailureOf(new CustomEvent('error'))).toBeNull()
  expect(stageFailureOf(new CustomEvent('error', { detail: 'something else' }))).toBeNull()
})

/** Drive `onHlsError` without loading hls.js, which the unit env has no MSE for. */
function fatalReason(type: string, alreadyRecovered = false): string | null {
  const video = document.createElement('video')
  const engine = new HlsEngine(video)
  let seen: string | null = null
  video.addEventListener('error', (event) => {
    seen = stageFailureOf(event)
  })
  const ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' }
  const hls = { recoverMediaError: () => undefined }
  const internals = engine as unknown as {
    recoveredMedia: boolean
    onHlsError: (ctor: unknown, hls: unknown, data: unknown) => void
  }
  internals.recoveredMedia = alreadyRecovered
  internals.onHlsError({ ErrorTypes }, hls, { fatal: true, type })
  return seen
}

// Segments 404ing because the session was reaped is the session's problem, and
// a fresh one fixes it — so the player must be told to re-attach, not to give
// up on the file.
test('calls a network fatal a session failure', () => {
  expect(fatalReason('networkError')).toBe('session')
})

// A media fatal gets one in-engine recovery attempt first; surviving that, it
// is a verdict about the bytes, and re-attaching would spend the budget
// reaching the same answer.
test('recovers a media fatal once, then calls it a decode failure', () => {
  expect(fatalReason('mediaError')).toBeNull() // recovered in-engine, nothing surfaced
  expect(fatalReason('mediaError', true)).toBe('decode')
})
