import { afterEach, expect, test, vi } from 'vitest'
import { setActiveLibraryId } from './client'
import { advanceConnectionScope } from './requestScope'
import {
  conversionTask,
  startConversion,
  readConversion,
  saveConversion,
} from './libraryConversion'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  setActiveLibraryId(null)
  advanceConnectionScope(null)
})

test('conversion survives a library switch and stops a late reply from another server', async () => {
  let reply!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          reply = resolve
        }),
    ),
  )
  setActiveLibraryId('synthetic-first')
  const pending = conversionTask('a'.repeat(32))
  setActiveLibraryId('synthetic-second')
  reply(new Response(JSON.stringify({ id: 'a'.repeat(32) }), { status: 200 }))
  await expect(pending).resolves.toMatchObject({ id: 'a'.repeat(32) })
  const previous = conversionTask('b'.repeat(32))
  advanceConnectionScope('synthetic-other-server')
  reply(new Response('{}', { status: 200 }))
  await expect(previous).rejects.toThrow('active connection')
})

test('conversion intent bypasses persisted metadata edits and stores only task identities', async () => {
  const request = {
    operation: 'c'.repeat(32),
    action: 'prepare' as const,
    root_path: '/srv/synthetic-legacy',
    confirm_stale_lease: false,
  }
  const fetch = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ id: request.operation }), { status: 202 })),
  )
  vi.stubGlobal('fetch', fetch)
  await expect(startConversion(request)).resolves.toMatchObject({ id: request.operation })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(Object.values(localStorage).join('')).not.toContain(request.root_path)
  const history = { task: request.operation, preparation: request.operation, activation: null }
  saveConversion('synthetic-conversion', history)
  expect(readConversion('synthetic-conversion')).toEqual(history)
  localStorage.setItem(
    'synthetic-conversion',
    JSON.stringify({ ...history, task: '../outside', activation: '/srv/private' }),
  )
  expect(readConversion('synthetic-conversion')).toEqual({
    task: null,
    preparation: request.operation,
    activation: null,
  })
})
