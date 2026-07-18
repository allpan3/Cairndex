import { afterEach, expect, test, vi } from 'vitest'

import {
  getHostLabels,
  getHostPlatform,
  hostFetch,
  hostLabelsFor,
  isDesktopHost,
  resetHostPlatformForTests,
  resolveHostAssetUrl,
} from './index'

afterEach(() => {
  resetHostPlatformForTests()
  vi.unstubAllGlobals()
})

test('uses byte-compatible browser request and URL fallbacks', async () => {
  const response = new Response('{}', { status: 200 })
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)

  expect(getHostPlatform().kind).toBe('web')
  expect(getHostLabels().revealFile).toBe('Show in File Manager')
  expect(resolveHostAssetUrl('/api/v1/file')).toBe('/api/v1/file')
  await expect(hostFetch('/api/v1/health')).resolves.toBe(response)
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/health', undefined)
})

test('detects the Tauri host only from its runtime marker', () => {
  expect(isDesktopHost()).toBe(false)
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  expect(isDesktopHost()).toBe(true)
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
})

test('provides desktop OS labels without leaking host checks into the SPA', () => {
  expect(hostLabelsFor('macos').revealFile).toBe('Reveal in Finder')
  expect(hostLabelsFor('windows').revealFile).toBe('Show in File Explorer')
})
