import { expect, test } from 'vitest'

import type { BundleSummary, FileBrowserEntry, FileRead } from '../api/client'
import { bundleHostPath, hostFileTargetFor, type HostFileTargetContext } from './hostFileTarget'

const EMPTY: HostFileTargetContext = {
  mode: 'collection',
  fileEntry: null,
  albumFile: null,
  selectedBundlePath: null,
}

function entry(relativePath: string, kind: 'file' | 'directory' = 'file'): FileBrowserEntry {
  return { relative_path: relativePath, name: relativePath, kind } as FileBrowserEntry
}

function bundleFile(relativePath: string): FileRead {
  return { id: 'f1', relative_path: relativePath } as FileRead
}

test('the File Browser acts on its selected entry', () => {
  expect(
    hostFileTargetFor({ ...EMPTY, mode: 'file', fileEntry: entry('Set07/clip1.mp4') }),
  ).toEqual({
    kind: 'file',
    relativePath: 'Set07/clip1.mp4',
  })
})

test('a selected folder is refused with its own reason', () => {
  // Distinct from "nothing selected" so the message can say which it is: a
  // folder is a reasonable thing to have selected and not a thing this reveals.
  expect(
    hostFileTargetFor({ ...EMPTY, mode: 'file', fileEntry: entry('Set07', 'directory') }),
  ).toEqual({ kind: 'none', reason: 'directory' })
})

test('the Bundle Browser acts on the selected bundle’s cursor file', () => {
  expect(hostFileTargetFor({ ...EMPTY, selectedBundlePath: 'Set07/clip1.mp4' })).toEqual({
    kind: 'file',
    relativePath: 'Set07/clip1.mp4',
  })
})

test('a file selected inside a bundle wins over the bundle around it', () => {
  // When the album view has a file selected the inspector is already describing
  // *that* file, so revealing the bundle's cursor instead would contradict it.
  expect(
    hostFileTargetFor({
      ...EMPTY,
      albumFile: bundleFile('Set07/clip2.mp4'),
      selectedBundlePath: 'Set07/clip1.mp4',
    }),
  ).toEqual({ kind: 'file', relativePath: 'Set07/clip2.mp4' })
})

test('the visible surface decides, so a stale selection elsewhere is ignored', () => {
  // Standing in the File Browser with nothing picked must not reveal whatever
  // was left selected in the Bundle Browser — the file that opens in Finder
  // should be one that is on screen.
  expect(
    hostFileTargetFor({
      ...EMPTY,
      mode: 'file',
      albumFile: bundleFile('Set07/clip2.mp4'),
      selectedBundlePath: 'Set07/clip1.mp4',
    }),
  ).toEqual({ kind: 'none', reason: 'no-selection' })
})

test('nothing selected anywhere is refused rather than guessed at', () => {
  expect(hostFileTargetFor(EMPTY)).toEqual({ kind: 'none', reason: 'no-selection' })
  expect(hostFileTargetFor({ ...EMPTY, mode: 'file' })).toEqual({
    kind: 'none',
    reason: 'no-selection',
  })
  // All Tags shows no files, so a bundle selection carried over from the Bundle
  // Browser is off screen — revealing it would open something the owner cannot
  // see they had selected.
  expect(
    hostFileTargetFor({ ...EMPTY, mode: 'tags', selectedBundlePath: 'Set07/clip1.mp4' }),
  ).toEqual({ kind: 'none', reason: 'no-selection' })
})

function summary(fields: Partial<BundleSummary>): BundleSummary {
  return fields as BundleSummary
}

test('a bundle hands over its file whether or not the viewer can play it', () => {
  // The two agree for a playable file...
  expect(
    bundleHostPath(
      summary({
        primary_relative_path: 'Set07/clip1.mp4',
        resume_relative_path: 'Set07/clip1.mp4',
      }),
    ),
  ).toBe('Set07/clip1.mp4')
  // ...and the OS still gets a path when the viewer has nothing to stage, which
  // is the case that was silently dropping Open and Reveal from the card menu:
  // an unsupported format, or a file recorded as missing (owner, 2026-08-24).
  expect(
    bundleHostPath(
      summary({ primary_relative_path: 'Set07/scan.psd', resume_relative_path: null }),
    ),
  ).toBe('Set07/scan.psd')
})

test('a bundle with no file, and no bundle at all, hand over nothing', () => {
  expect(bundleHostPath(summary({ primary_relative_path: null }))).toBeNull()
  // `find` misses while a page is loading, or when the selection outlives it.
  expect(bundleHostPath(undefined)).toBeNull()
})
