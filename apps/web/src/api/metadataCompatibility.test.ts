import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fetchMetadataRevision, setActiveLibraryId, setApiBaseUrl } from './client'
import { metadataCompatibility, metadataEditingBlocked } from './metadataCompatibility'
import { pendingEdits, sendMetadata, shownEdit, subscribeEdits } from './metadataEdits'

const basis = `${'a'.repeat(32)}:4:${'b'.repeat(32)}:0`
const response = () =>
  new Response(JSON.stringify({ basis }), { headers: { 'X-Cairndex-Basis': basis } })
beforeEach(() => {
  setApiBaseUrl(null)
  setActiveLibraryId(crypto.randomUUID())
})
afterEach(() => vi.unstubAllGlobals())

test.each([404, 405])(
  'missing edit protocol (%i) blocks even retained versioned writes without a retry dialog',
  async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status }))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchMetadataRevision()).rejects.toThrow()
    expect(metadataCompatibility()).toBe('unsupported')
    const unsubscribe = subscribeEdits(() => undefined)
    try {
      await expect(
        sendMetadata('/api/v1/libraries/test/bundles/amber', 'DELETE', undefined, basis),
      ).rejects.toThrow('Update the server')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(shownEdit()).toBeNull()
      expect(pendingEdits()).toHaveLength(1)
      expect(pendingEdits()[0]?.basis).toBe(basis)
    } finally {
      unsubscribe()
    }
  },
)

test.each([401, 403, 409, 423, 500, 503])(
  'HTTP %i is a temporary access failure, not proof of an old server',
  async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })))
    await expect(fetchMetadataRevision()).rejects.toThrow()
    expect(metadataCompatibility()).toBe('unavailable')
    expect(metadataEditingBlocked()).toBe(false)
  },
)

test('missing or invalid read headers cannot enable metadata editing', async () => {
  for (const header of [undefined, 'invalid']) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ basis }), {
          headers: header ? { 'X-Cairndex-Basis': header } : {},
        }),
      ),
    )
    await expect(fetchMetadataRevision()).rejects.toThrow('compatible metadata')
    expect(metadataEditingBlocked()).toBe(true)
  }
})

test('an outage preserves the last confirmed block and a later valid read recovers without changing a draft', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(response())
  vi.stubGlobal('fetch', fetcher)
  await expect(fetchMetadataRevision()).rejects.toThrow()
  await expect(
    sendMetadata('/api/v1/libraries/test/bundles/amber', 'DELETE', undefined, undefined),
  ).rejects.toThrow()
  const saved = JSON.stringify(pendingEdits())
  await expect(fetchMetadataRevision()).rejects.toThrow()
  expect(metadataCompatibility()).toBe('unavailable')
  expect(metadataEditingBlocked()).toBe(true)
  await fetchMetadataRevision()
  expect(metadataCompatibility()).toBe('supported')
  expect(metadataEditingBlocked()).toBe(false)
  expect(JSON.stringify(pendingEdits())).toBe(saved)
})

test.each(['library', 'connection'])(
  'late responses cannot classify a replacement %s',
  async (kind) => {
    let finish!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          }),
      ),
    )
    const read = fetchMetadataRevision()
    const rejection = expect(read).rejects.toThrow('connection or library changed')
    if (kind === 'library') setActiveLibraryId(crypto.randomUUID())
    else setApiBaseUrl('http://synthetic.invalid')
    finish(new Response('{}', { status: 404 }))
    await rejection
    expect(metadataCompatibility()).toBe('unknown')
    expect(metadataEditingBlocked()).toBe(false)
  },
)

test('cancelling a probe is not a compatibility failure', async () => {
  const controller = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }),
  )
  await expect(fetchMetadataRevision(controller.signal)).rejects.toThrow()
  expect(metadataCompatibility()).toBe('unknown')
})

test('an unavailable library is not classified as a missing server feature', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 'not_found',
          message: 'Library is unavailable',
        }),
        { status: 404 },
      ),
    ),
  )
  await expect(fetchMetadataRevision()).rejects.toThrow('Library is unavailable')
  expect(metadataCompatibility()).toBe('unavailable')
  expect(metadataEditingBlocked()).toBe(false)
})
