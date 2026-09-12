import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { setActiveLibraryId } from './client'
import {
  chooseEdit,
  pendingEdits,
  sendMetadata,
  shownEdit,
  subscribeEdits,
  MetadataEditError,
} from './metadataEdits'
import {
  basisOf,
  clearEditBases,
  editBasis,
  minimumBasis,
  rememberBasis,
  rememberVersionBases,
} from './editBasis'
import { libraryStateKey } from '../state/useBundleDraft'

const opening = `${'a'.repeat(32)}:4:${'b'.repeat(32)}:0`
const later = `${'a'.repeat(32)}:9:${'b'.repeat(32)}:0`
let url: string
let unsubscribe: (() => void) | undefined

// Each test owns a separate synthetic library and durable draft namespace
beforeEach(() => {
  setActiveLibraryId(crypto.randomUUID())
  const library = crypto.randomUUID()
  setActiveLibraryId(library)
  url = `/api/v1/libraries/${library}/bundles/${'A'.repeat(26)}`
  clearEditBases()
})
afterEach(() => {
  unsubscribe?.()
  unsubscribe = undefined
  vi.unstubAllGlobals()
})

// Response metadata represents one immutable server snapshot
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'X-Cairndex-Basis': later } })

test('version compatibility and transformed data never acquire a newer baseline', () => {
  const row = { id: 'A'.repeat(26), version: 1, notes: ['old'] }
  rememberVersionBases(url, row, opening)
  rememberVersionBases(url, row, later)
  expect(editBasis(url, 1)).toBe(opening)
  rememberBasis(row, opening)
  expect(basisOf({ data: [row] })).toBe(opening)
  expect(minimumBasis([opening, later])).toBe(opening)
  expect(minimumBasis([opening, opening.replace('a', 'c')])).toBe('incompatible-read-bases')
})

test('transformed cyclic data retains its oldest represented read without recursion', () => {
  const child = rememberBasis({ name: 'opening' }, opening)
  const value: { child: object; self?: object } = { child }
  value.self = value
  expect(basisOf(value)).toBe(opening)
  rememberBasis(value, later)
  expect(basisOf(value)).toBe(later)
})

test('completed orphan requests clear only their matching scoped draft generations', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => reply({})),
  )
  const bundleKey = libraryStateKey(`cairndex.bundleDraft:${'A'.repeat(26)}`)
  localStorage.setItem(
    bundleKey,
    JSON.stringify({ version: 1, patch: { title: 'submitted', notes: ['note', ''] } }),
  )
  await sendMetadata(url, 'PATCH', { title: 'submitted', notes: ['note'] }, opening)
  expect(JSON.parse(localStorage.getItem(bundleKey)!)).toMatchObject({
    patch: { notes: ['note', ''] },
  })
  const fieldKey = libraryStateKey('cairndex.fieldDraft:collection:aster:note')
  const newerKey = libraryStateKey('cairndex.fieldDraft:collection:aster:name')
  localStorage.setItem(fieldKey, JSON.stringify({ value: 'submitted', basis: opening }))
  localStorage.setItem(newerKey, JSON.stringify({ value: 'newer draft', basis: opening }))
  await sendMetadata(
    url.replace(/\/bundles\/[^/]+$/, '/collections/aster'),
    'PATCH',
    { note: 'submitted', name: 'old' },
    opening,
  )
  expect(localStorage.getItem(fieldKey)).toBeNull()
  expect(JSON.parse(localStorage.getItem(newerKey)!)).toMatchObject({ value: 'newer draft' })
})

test('missing baselines cannot reach an old server that would accept unversioned writes', async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ id: 'unexpected' }))
  vi.stubGlobal('fetch', fetcher)
  await expect(
    sendMetadata(`${url}/moments`, 'POST', { comment: 'draft' }, undefined),
  ).rejects.toBeInstanceOf(MetadataEditError)
  expect(fetcher).not.toHaveBeenCalled()
  expect(pendingEdits()).toHaveLength(1)
})

test('uncertain retries and concurrent duplicate invocations share one stable operation', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValue(reply({ id: 'saved' }))
  vi.stubGlobal('fetch', fetcher)
  unsubscribe = subscribeEdits(() => undefined)
  const first = sendMetadata(url, 'PATCH', { title: 'draft' }, opening)
  const duplicate = sendMetadata(url, 'PATCH', { title: 'draft' }, opening)
  await waitFor(() => expect(shownEdit()).not.toBeNull())
  await chooseEdit(shownEdit()!, 'retry')
  await expect(first).resolves.toEqual({ id: 'saved' })
  await expect(duplicate).resolves.toEqual({ id: 'saved' })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[0]?.[1]).toEqual(fetcher.mock.calls[1]?.[1])
  expect(pendingEdits()).toHaveLength(0)
})

test('review acknowledges only the displayed unit revision and retains the opening basis', async () => {
  const conflict = {
    unit: 'main/asset_bundles/id/title',
    revision: 8,
    current: 'current',
    proposed: 'draft',
    reviewable: true,
  }
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      reply({ code: 'version_conflict', message: 'Review', details: conflict }, 409),
    )
    .mockResolvedValue(reply({ title: 'draft' }))
  vi.stubGlobal('fetch', fetcher)
  unsubscribe = subscribeEdits(() => undefined)
  const pending = sendMetadata(url, 'PATCH', { title: 'draft' }, opening)
  await waitFor(() => expect(shownEdit()?.conflict).toEqual(conflict))
  await chooseEdit(shownEdit()!, 'reviewed')
  await pending
  const options = fetcher.mock.calls[1]![1] as RequestInit
  const headers = options.headers as Record<string, string>
  expect(headers['X-Cairndex-Basis']).toBe(opening)
  expect(JSON.parse(headers['X-Cairndex-Review']!)).toEqual({ [conflict.unit]: 8 })
  expect(headers['X-Cairndex-Operation']).not.toBe(
    (fetcher.mock.calls[0]![1].headers as Record<string, string>)['X-Cairndex-Operation'],
  )
})

test('historical scalar drafts require explicit review of every submitted field', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(reply({ title: 'current', notes: ['current note'] }))
    .mockResolvedValue(reply({ title: 'draft', notes: ['draft note'] }))
  vi.stubGlobal('fetch', fetcher)
  unsubscribe = subscribeEdits(() => undefined)
  const pending = sendMetadata(
    url,
    'PATCH',
    { title: 'draft', notes: ['draft note'] },
    'unversioned-draft',
  )
  await waitFor(() => expect(shownEdit()?.recovery?.basis).toBe(later))
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(shownEdit()?.recovery?.current).toEqual({ title: 'current', notes: ['current note'] })
  await chooseEdit(shownEdit()!, 'reviewed')
  await pending
  expect(fetcher.mock.calls[1]![1].headers['X-Cairndex-Basis']).toBe(later)
})
