import { afterEach, expect, test, vi } from 'vitest'

import {
  getHostLabels,
  getHostPlatform,
  hostFetch,
  hostLabelsFor,
  hostOperationErrorMessage,
  isDesktopHost,
  listenHostFileDrop,
  resetHostPlatformForTests,
  resolveHostAssetUrl,
  reverseMapHostPaths,
} from './index'

test('formats structured native host failures without assuming Error instances', () => {
  // A known code wins over the shell-authored message: copy is web-owned
  expect(
    hostOperationErrorMessage({
      code: 'volume_not_mounted',
      message: 'rust-side wording that should not surface',
    }),
  ).toBe('Volume not mounted. Reconnect it and try again.')
  // Unknown codes fall back to the shell message, then to the generic copy
  expect(
    hostOperationErrorMessage({ code: 'future_code', message: 'A newer shell said this.' }),
  ).toBe('A newer shell said this.')
  expect(hostOperationErrorMessage(null)).toBe('The desktop action could not be completed.')
})

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

  // Drag-in reverse-mapping and file-drop subscription are inert in the browser.
  await expect(reverseMapHostPaths('lib', ['/abs/path.mp4'])).resolves.toEqual({
    inside: [],
    outsideCount: 0,
  })
  await expect(listenHostFileDrop(() => undefined)).resolves.toBeInstanceOf(Function)
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
