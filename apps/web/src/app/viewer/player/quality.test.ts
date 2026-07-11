import { expect, test } from 'vitest'

import { qualityOptions } from './quality'

test('builds a source-aware resolution ladder', () => {
  expect(qualityOptions(2160).map((option) => option.label)).toEqual([
    'Auto',
    '2160p',
    '1440p',
    '1080p',
    '720p',
    '480p',
  ])
  expect(qualityOptions(1080).map((option) => option.label)).toEqual([
    'Auto',
    '1080p',
    '720p',
    '480p',
  ])
  expect(qualityOptions(720).some((option) => option.label === '1080p')).toBe(false)
})

test('keeps the complete ladder when source height is unavailable', () => {
  expect(qualityOptions(null).map((option) => option.value)).toEqual([
    null,
    2160,
    1440,
    1080,
    720,
    480,
  ])
})
