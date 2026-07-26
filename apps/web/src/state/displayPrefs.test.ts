import { expect, test } from 'vitest'

import { displayName } from './displayPrefs'

// Hiding extensions is a *display* choice, so the rule that matters is that it
// only ever shortens a label — never in a way that loses which file is which.

test('hides a trailing extension when asked', () => {
  expect(displayName('Holiday.mkv', false, true)).toBe('Holiday')
})

test('leaves the name alone when the preference is off', () => {
  expect(displayName('Holiday.mkv', false, false)).toBe('Holiday.mkv')
})

test('keeps a directory name whole', () => {
  // A folder has no extension to hide; `Season 1.5` must not become `Season 1`.
  expect(displayName('Season 1.5', true, true)).toBe('Season 1.5')
})

test('only drops the last extension', () => {
  expect(displayName('archive.tar.gz', false, true)).toBe('archive.tar')
})

test('keeps a dotfile-shaped name whole', () => {
  // Nothing before the dot means the dot is not an extension separator; dropping
  // it would leave an empty label.
  expect(displayName('.env', false, true)).toBe('.env')
})

test('keeps a name with no extension', () => {
  expect(displayName('README', false, true)).toBe('README')
})
