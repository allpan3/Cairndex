import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  DEFAULT_EXPORT_PREFS,
  getExportPrefs,
  resetExportPrefsForTests,
  useExportPrefs,
} from './exportPrefs'

/**
 * jsdom is configured here without a storage origin, so `localStorage` is
 * undefined rather than empty — the store copes with that on purpose (private
 * mode behaves the same), but persistence itself needs somewhere to persist.
 */
const store = new Map<string, string>()
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size
  },
} satisfies Storage

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage)
  store.clear()
  resetExportPrefsForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetExportPrefsForTests()
})

// A watermark is branding, not a default courtesy: these are the owner's own
// files, so nothing is stamped until they ask for it.
test('starts off, with text ready for when it is switched on', () => {
  expect(DEFAULT_EXPORT_PREFS.watermarkEnabled).toBe(false)
  expect(DEFAULT_EXPORT_PREFS.watermarkText).toBe('CAIRNDEX')
})

test('a change reaches every reader, not just the one that made it', () => {
  const writer = renderHook(() => useExportPrefs())
  const reader = renderHook(() => useExportPrefs())

  act(() => writer.result.current[1]({ watermarkEnabled: true, watermarkText: 'STUDIO' }))

  expect(reader.result.current[0].watermarkEnabled).toBe(true)
  expect(reader.result.current[0].watermarkText).toBe('STUDIO')
})

// The export paths are plain functions called from menu handlers, so they read
// the store directly rather than having the mark threaded down to them.
test('is readable outside React', () => {
  const { result } = renderHook(() => useExportPrefs())
  act(() => result.current[1]({ watermarkEnabled: true }))
  expect(getExportPrefs().watermarkEnabled).toBe(true)
})

test('a partial update leaves the other answers alone', () => {
  const { result } = renderHook(() => useExportPrefs())
  act(() => result.current[1]({ watermarkText: 'STUDIO' }))
  act(() => result.current[1]({ watermarkEnabled: true }))
  expect(result.current[0]).toEqual({ watermarkEnabled: true, watermarkText: 'STUDIO' })
})

test('survives a reload', () => {
  const { result } = renderHook(() => useExportPrefs())
  act(() => result.current[1]({ watermarkEnabled: true, watermarkText: 'STUDIO' }))
  expect(JSON.parse(localStorage.getItem('cairndex.exportPrefs') ?? '{}')).toEqual({
    watermarkEnabled: true,
    watermarkText: 'STUDIO',
  })
})

// A value stored before a newer field existed must not read back as undefined.
test('merges a stored value over the defaults', () => {
  localStorage.setItem('cairndex.exportPrefs', JSON.stringify({ watermarkEnabled: true }))
  resetExportPrefsForTests()
  const { result } = renderHook(() => useExportPrefs())
  // `reset` clears the in-memory snapshot; a fresh reader still sees a complete
  // object rather than one missing the field that was never stored.
  expect(result.current[0].watermarkText).toBe('CAIRNDEX')
})

test('unreadable storage falls back to the defaults', () => {
  localStorage.setItem('cairndex.exportPrefs', 'not json')
  resetExportPrefsForTests()
  const { result } = renderHook(() => useExportPrefs())
  expect(result.current[0]).toEqual(DEFAULT_EXPORT_PREFS)
})
