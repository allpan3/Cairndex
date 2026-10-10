import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  approveDevicePairing,
  configureLibraryAccess,
  setActiveLibraryId,
  unlockLibrary,
} from './client'
import { pendingEdits } from './metadataEdits'

const secret = 'synthetic-passphrase-7Q'
let library: string

beforeEach(() => {
  library = crypto.randomUUID()
  setActiveLibraryId(library)
})
afterEach(() => vi.unstubAllGlobals())

// Every value in localStorage, so that one check covers every store
const stored = () =>
  Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.getItem(localStorage.key(index)!),
  ).join('\n')

const requests = [
  ['unlock', () => unlockLibrary(library, secret)],
  ['access settings', () => configureLibraryAccess(library, secret, secret)],
  ['pairing approval', () => approveDevicePairing(secret, [library])],
] as const

// The edit queue stores a request before it sends it and keeps it after a failure
test.each(requests)('%s sends its secret directly and stores nothing', async (_name, request) => {
  const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  vi.stubGlobal('fetch', fetch)
  await expect(request()).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(String(fetch.mock.calls[0]![1]?.body)).toContain(secret)
  expect(stored()).not.toContain(secret)
  expect(JSON.stringify(pendingEdits())).not.toContain(secret)
})
