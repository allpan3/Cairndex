import { afterEach, expect, test, vi } from 'vitest'

import {
  beaconPlaybackProgress,
  fetchPlaybackManifest,
  resolveApiUrl,
  setActiveLibraryId,
  setApiBaseUrl,
  thumbnailUrl,
} from './client'

afterEach(() => {
  setApiBaseUrl(null)
  setActiveLibraryId(null)
  vi.unstubAllGlobals()
})

// Same-origin browsers keep relative paths while desktop joins its configured base
test('resolves API and media paths only when a server base is configured', () => {
  expect(resolveApiUrl('/api/v1/health')).toBe('/api/v1/health')
  setApiBaseUrl('http://nas.local:8000/cairndex/')
  setActiveLibraryId('lib1')
  expect(resolveApiUrl('/api/v1/health')).toBe('http://nas.local:8000/cairndex/api/v1/health')
  expect(resolveApiUrl('https://cdn.example/video.mp4')).toBe('https://cdn.example/video.mp4')
  expect(thumbnailUrl('bundle1')).toBe(
    'http://nas.local:8000/cairndex/api/v1/libraries/lib1/bundles/bundle1/thumbnail',
  )
})

// Vite replaces this module without rerunning desktop connection activation
test('keeps the active desktop API base across a module reload', async () => {
  setApiBaseUrl('http://127.0.0.1:54321')

  vi.resetModules()
  const reloaded = await import('./client')

  expect(reloaded.resolveApiUrl('/api/v1/libraries')).toBe(
    'http://127.0.0.1:54321/api/v1/libraries',
  )
})

// Server-provided playback URLs are made usable by a custom-protocol webview
test('resolves nested playback URLs from the configured server', async () => {
  setApiBaseUrl('http://127.0.0.1:8000')
  setActiveLibraryId('lib1')
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          bundle_id: 'bundle1',
          videos: [
            {
              file_id: 'file1',
              display_title: 'Fixture',
              duration: 10,
              width: 640,
              height: 360,
              mime_type: 'video/mp4',
              playable: true,
              progress: null,
              reason: 'direct',
              stream_url: '/api/v1/libraries/lib1/files/file1/stream',
              storyboard_url: '/api/v1/libraries/lib1/files/file1/storyboard.vtt',
              subtitles: [
                {
                  id: 'sub1',
                  format: 'vtt',
                  is_default: true,
                  is_forced: false,
                  kind: 'external',
                  label: 'English',
                  language: 'en',
                  src: '/api/v1/libraries/lib1/subtitles/sub1/vtt',
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  )

  const manifest = await fetchPlaybackManifest('bundle1')
  expect(manifest.videos[0]?.stream_url).toBe(
    'http://127.0.0.1:8000/api/v1/libraries/lib1/files/file1/stream',
  )
  expect(manifest.videos[0]?.subtitles[0]?.src).toBe(
    'http://127.0.0.1:8000/api/v1/libraries/lib1/subtitles/sub1/vtt',
  )
})

// Pagehide progress beacons target the configured server, not the Tauri origin
test('resolves typed sendBeacon destinations', async () => {
  setApiBaseUrl('http://127.0.0.1:8000')
  setActiveLibraryId('lib1')
  const sendBeacon = vi.fn().mockReturnValue(true)
  vi.stubGlobal('navigator', { sendBeacon })

  expect(beaconPlaybackProgress('file1', { position_s: 3 })).toBe(true)
  expect(sendBeacon).toHaveBeenCalledWith(
    'http://127.0.0.1:8000/api/v1/libraries/lib1/files/file1/progress',
    expect.any(Blob),
  )
  const body = sendBeacon.mock.calls[0]?.[1]
  expect(body).toBeInstanceOf(Blob)
  expect((body as Blob).type).toBe('application/json')
  expect(await (body as Blob).text()).toBe(JSON.stringify({ position_s: 3 }))
})
