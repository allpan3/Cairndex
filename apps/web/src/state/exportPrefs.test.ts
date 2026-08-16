import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'

import {
  DEFAULT_EXPORT_PREFS,
  getExportPrefs,
  reloadExportPrefsForTests,
  resetExportPrefsForTests,
  useExportPrefs,
} from './exportPrefs'

beforeEach(() => {
  resetExportPrefsForTests()
})

afterEach(() => {
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
  expect(result.current[0]).toEqual({
    ...DEFAULT_EXPORT_PREFS,
    watermarkEnabled: true,
    watermarkText: 'STUDIO',
  })
})

test('survives a reload', () => {
  const { result } = renderHook(() => useExportPrefs())
  act(() => result.current[1]({ watermarkEnabled: true, watermarkText: 'STUDIO' }))
  expect(JSON.parse(localStorage.getItem('cairndex.exportPrefs') ?? '{}')).toEqual({
    ...DEFAULT_EXPORT_PREFS,
    watermarkEnabled: true,
    watermarkText: 'STUDIO',
  })
})

// A value stored before a newer field existed must not read back as undefined.
test('merges a stored value over the defaults', () => {
  localStorage.setItem('cairndex.exportPrefs', JSON.stringify({ watermarkEnabled: true }))
  reloadExportPrefsForTests()
  const { result } = renderHook(() => useExportPrefs())
  // `reset` clears the in-memory snapshot; a fresh reader still sees a complete
  // object rather than one missing the field that was never stored.
  expect(result.current[0].watermarkText).toBe('CAIRNDEX')
})

test('unreadable storage falls back to the defaults', () => {
  localStorage.setItem('cairndex.exportPrefs', 'not json')
  reloadExportPrefsForTests()
  const { result } = renderHook(() => useExportPrefs())
  expect(result.current[0]).toEqual(DEFAULT_EXPORT_PREFS)
})
