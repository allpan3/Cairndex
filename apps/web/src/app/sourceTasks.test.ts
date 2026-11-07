import { expect, test } from 'vitest'
import { bundleHome, folderNameFor, suggestBundleTitle } from './sourceTasks'

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

test('bundles sharing a folder put a new bundle beside them in it', () => {
  expect(bundleHome(['Trips/a.mp4', 'Trips/b.mp4', 'Home/c.mp4', null])).toEqual({
    folder: 'Trips',
    perBundle: false,
  })
  expect(bundleHome(['root.mp4'])).toEqual({ folder: '', perBundle: false })
  expect(bundleHome([null, undefined])).toBeNull()
})

test('bundles with a folder each put a new bundle in a new folder under their parent', () => {
  expect(bundleHome(['Films/Alpha/alpha.mp4', 'Films/Beta/beta.mkv'])).toEqual({
    folder: 'Films',
    perBundle: true,
  })
  // Never inside the one existing bundle's own folder
  expect(bundleHome(['Films/Alpha/alpha.mp4'])).toEqual({ folder: 'Films', perBundle: true })
  // Bundles of child collections meet at their common parent
  expect(bundleHome(['Films/Comedy/One/one.mp4', 'Films/Drama/Two/two.mp4'])).toEqual({
    folder: 'Films',
    perBundle: true,
  })
})

test('a bundle name becomes one folder name', () => {
  expect(folderNameFor('Harbor at dusk')).toBe('Harbor at dusk')
  expect(folderNameFor('a/b')).toBe('a-b')
  expect(folderNameFor(' .hidden. ')).toBe('hidden')
  expect(folderNameFor('  ')).toBeNull()
  expect(folderNameFor('/')).toBeNull()
})
