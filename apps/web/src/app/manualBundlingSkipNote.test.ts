import { expect, test } from 'vitest'

import type { ManualBundleResult } from '../api/client'
import { withSkipNote } from './manualBundlingSkipNote'

function result(over: Partial<ManualBundleResult>): ManualBundleResult {
  return {
    bundle_id: 'b',
    files_added: 1,
    bundles_removed: 0,
    subtitles_linked: 0,
    created: true,
    skipped_non_media: 0,
    skipped_missing: 0,
    skipped_already_bundled: 0,
    files_skipped: 0,
    ...over,
  }
}

test('adds no note when nothing was skipped', () => {
  expect(withSkipNote('Created a bundle from 1 file.', result({}))).toBe(
    'Created a bundle from 1 file.',
  )
})

test('words each reason separately and pluralizes', () => {
  const note = withSkipNote(
    'Created a bundle from 1 file.',
    result({ skipped_already_bundled: 2, skipped_missing: 1, skipped_non_media: 1 }),
  )
  expect(note).toBe(
    'Created a bundle from 1 file. Skipped 2 already in another bundle, 1 missing file, 1 non-media item.',
  )
})

test('treats a missing field as zero rather than "undefined skipped"', () => {
  // A stale/partial payload (e.g. an old mock) must not render "undefined".
  const partial = { files_added: 1 } as unknown as ManualBundleResult
  expect(withSkipNote('Added 1 file to the bundle.', partial)).toBe('Added 1 file to the bundle.')
})
