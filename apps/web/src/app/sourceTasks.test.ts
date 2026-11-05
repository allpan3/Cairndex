import { expect, test } from 'vitest'
import { mostCommonFolder, suggestBundleTitle } from './sourceTasks'

test('a bundle is named after the stem its files share, else its largest file', () => {
  expect(
    suggestBundleTitle([
      { name: 'Harbor at dusk.mp4', size: 900 },
      { name: 'Harbor at dusk.srt', size: 2 },
    ]),
  ).toBe('Harbor at dusk')
  expect(
    suggestBundleTitle([
      { name: 'clip-01.mov', size: 900 },
      { name: 'clip-02.mov', size: 800 },
    ]),
  ).toBe('clip')
  expect(
    suggestBundleTitle([
      { name: 'notes.txt', size: 3 },
      { name: 'Lighthouse.mp4', size: 900 },
    ]),
  ).toBe('Lighthouse')
  expect(suggestBundleTitle([])).toBe('')
})

test('the suggested folder is the one most of the bundles sit in', () => {
  expect(mostCommonFolder(['Trips/a.mp4', 'Trips/b.mp4', 'Home/c.mp4', null])).toBe('Trips')
  expect(mostCommonFolder(['root.mp4'])).toBe('')
  expect(mostCommonFolder([null, undefined])).toBeNull()
})
