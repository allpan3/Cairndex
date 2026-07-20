import { afterEach, expect, test, vi } from 'vitest'

import { buildDeepLinkUri, copyText } from './deepLinkUri'

afterEach(() => {
  vi.restoreAllMocks()
})

test('builds a URI the shell can parse back', () => {
  expect(buildDeepLinkUri('bundle', 'b1', 'lib-1')).toBe('cairndex://bundle/b1?library=lib-1')
  expect(buildDeepLinkUri('collection', 'c9', 'lib-1')).toBe(
    'cairndex://collection/c9?library=lib-1',
  )
})

test('always carries the library id', () => {
  // A copied link is typically pasted and opened later, by which point the active
  // library may differ; without the id it would silently resolve against the
  // wrong one and open the wrong thing.
  expect(buildDeepLinkUri('bundle', 'b1', 'lib-2')).toContain('?library=lib-2')
})

test('percent-encodes both segments', () => {
  // The shell percent-decodes path segments, so an id containing a separator or a
  // space must survive the round trip rather than changing the parsed shape.
  expect(buildDeepLinkUri('bundle', 'a b/c', 'lib 1')).toBe(
    'cairndex://bundle/a%20b%2Fc?library=lib%201',
  )
})

test('copies through the clipboard API when available', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  await expect(copyText('cairndex://bundle/b1')).resolves.toBe(true)
  expect(writeText).toHaveBeenCalledWith('cairndex://bundle/b1')
})

test('falls back when the clipboard API is unavailable or rejects', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) } })
  const exec = vi.fn().mockReturnValue(true)
  ;(document as unknown as { execCommand: unknown }).execCommand = exec

  await expect(copyText('cairndex://bundle/b1')).resolves.toBe(true)
  expect(exec).toHaveBeenCalledWith('copy')
  // The scratch textarea must not be left behind in the DOM.
  expect(document.querySelector('textarea')).toBeNull()
})

test('reports failure rather than claiming a copy that did not happen', async () => {
  vi.stubGlobal('navigator', {})
  ;(document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false)
  await expect(copyText('cairndex://bundle/b1')).resolves.toBe(false)
})
