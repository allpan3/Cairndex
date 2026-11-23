import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import * as platform from '../platform'
import { acquireCoverBlobUrl, clearCoverBlobCache, getCachedCoverBlobUrl } from './coverMemoryCache'

beforeEach(() => {
  clearCoverBlobCache()
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:synthetic-${Math.random()}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
})

afterEach(() => {
  clearCoverBlobCache()
  vi.restoreAllMocks()
})

test('caps concurrent cover fetches at 4 and drops unmounted queued cards without fetching', async () => {
  let active = 0
  let maxActive = 0
  const resolvers: Array<{ url: string; resolve: () => void; signal?: AbortSignal }> = []

  vi.spyOn(platform, 'hostFetch').mockImplementation((input, init) => {
    const url = String(input)
    active += 1
    maxActive = Math.max(maxActive, active)
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        active -= 1
        reject(new DOMException('Aborted', 'AbortError'))
      })
      resolvers.push({
        url,
        signal: init?.signal ?? undefined,
        resolve: () => {
          active -= 1
          resolve(new Response('img', { headers: { 'Content-Type': 'image/png' } }))
        },
      })
    })
  })

  const handles = Array.from({ length: 10 }, (_, idx) =>
    acquireCoverBlobUrl(`/api/v1/libraries/lib1/bundles/b-${idx}/thumbnail`),
  )

  expect(maxActive).toBe(4)
  expect(resolvers).toHaveLength(4)

  // Unmounting queued cards before their slot starts never sends HTTP requests for them
  handles[0]!.release()
  handles[1]!.release()

  // Unmounting an in-flight card aborts its fetch immediately and frees the slot
  const abortedSignal = resolvers[0]!.signal
  handles[9]!.release()
  expect(abortedSignal?.aborted).toBe(true)

  await Promise.resolve()
  await Promise.resolve()

  while (resolvers.length > 0) {
    const next = resolvers.shift()!
    if (!next.signal?.aborted) next.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }

  expect(maxActive).toBeLessThanOrEqual(4)
  expect(getCachedCoverBlobUrl('/api/v1/libraries/lib1/bundles/b-0/thumbnail')).toBeUndefined()
  expect(getCachedCoverBlobUrl('/api/v1/libraries/lib1/bundles/b-1/thumbnail')).toBeUndefined()
  expect(getCachedCoverBlobUrl('/api/v1/libraries/lib1/bundles/b-2/thumbnail')).toMatch(
    /^blob:synthetic-/,
  )
})

test('a remounted card starts a fresh request before its cancelled fetch settles', async () => {
  const requests: Array<(response: Response) => void> = []
  const fetch = vi
    .spyOn(platform, 'hostFetch')
    .mockImplementation(() => new Promise<Response>((resolve) => requests.push(resolve)))
  const src = '/covers/one'
  const first = acquireCoverBlobUrl(src)
  first.release()
  const second = acquireCoverBlobUrl(src)
  expect(fetch).toHaveBeenCalledTimes(2)

  // A late response to the cancelled fetch cannot cache its bytes or drop the replacement.
  requests[0]!(new Response('old'))
  await expect(first.promise).resolves.toBeNull()
  expect(getCachedCoverBlobUrl(src)).toBeUndefined()
  const shared = acquireCoverBlobUrl(src)
  expect(shared.promise).toBe(second.promise)
  second.release()
  expect(fetch.mock.calls[1]![1]?.signal?.aborted).toBe(false)
  requests[1]!(new Response('new'))
  await expect(shared.promise).resolves.toMatch(/^blob:synthetic-/)
  shared.release()
})

test('visible covers bypass nearby work and share an already requested cover', async () => {
  const replies: Array<() => void> = []
  const fetch = vi
    .spyOn(platform, 'hostFetch')
    .mockImplementation(
      () => new Promise<Response>((resolve) => replies.push(() => resolve(new Response('img')))),
    )
  const near = acquireCoverBlobUrl('/near', false)
  const next = acquireCoverBlobUrl('/next', false)
  const promoted = acquireCoverBlobUrl('/promoted', false)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/near'])
  promoted.setVisible(true)
  const visible = acquireCoverBlobUrl('/visible')
  const shared = acquireCoverBlobUrl('/near')
  expect(shared.promise).toBe(near.promise)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/near', '/promoted', '/visible'])
  replies.splice(0).forEach((resolve) => resolve())
  await Promise.all([near.promise, visible.promise, promoted.promise])
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/next')
  replies[0]!()
  await next.promise
  for (const handle of [near, next, promoted, visible, shared]) handle.release()
})
