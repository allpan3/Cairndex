import { expect, test } from 'vitest'

import { createEngine, HlsEngine, NativeEngine, type PlaybackSource } from './engine'

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
