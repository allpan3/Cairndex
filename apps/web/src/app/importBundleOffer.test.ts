import { beforeEach, expect, test, vi } from 'vitest'

import type { TargetSuggestion } from '../api/client'
import {
  announceImport,
  importedSummary,
  offerableBundle,
  type LandedFile,
} from './importBundleOffer'

const suggest = vi.fn<(paths: string[]) => Promise<TargetSuggestion[]>>()
const addToBundle = vi.fn<(bundleId: string, paths: string[]) => Promise<unknown>>()
const undoOperation = vi.fn<(operationId: string) => void>()
const onLinked = vi.fn<(bundleId: string) => void>()
const openPicker = vi.fn<(paths: string[]) => void>()
const openCreate = vi.fn<(paths: string[]) => void>()

/** Every toast the announcement asked for, in order. */
interface Shown {
  message: string
  undo?: () => void
  offers: { label: string; run: () => void }[]
}
let shown: Shown[] = []
/** The offer with this label, for asserting one action without index juggling. */
const offer = (index: number, label: string) => shown[index]?.offers.find((o) => o.label === label)

function deps() {
  return {
    suggest,
    addToBundle,
    undoOperation,
    onLinked,
    openPicker,
    openCreate,
    show: (
      message: string,
      undo?: () => void,
      offers?: { label: string; run: () => void }[],
    ): void => {
      shown.push({ message, undo, offers: offers ?? [] })
    },
  }
}

function landed(...paths: string[]): LandedFile[] {
  return paths.map((path, index) => ({ path, operationId: `op-${index + 1}` }))
}

function ranked(...entries: [string, string, number][]): TargetSuggestion[] {
  return entries.map(
    ([bundle_id, title, confidence]) =>
      ({ bundle_id, title, confidence, reason: 'same folder' }) as TargetSuggestion,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  shown = []
  suggest.mockResolvedValue([])
  addToBundle.mockResolvedValue({})
})

// --- what the message says ---------------------------------------------------
test('one file is named, several are counted', () => {
  expect(importedSummary(landed('Studios/Alpha/behind.mp4'), 'Studios/Alpha')).toBe(
    'Added “behind.mp4” to Alpha.',
  )
  expect(importedSummary(landed('a.mp4', 'b.mp4'), 'Studios')).toBe('Added 2 files to Studios.')
})

test('the library root is called what it is, not an empty name', () => {
  expect(importedSummary(landed('loose.mp4'), '')).toBe('Added “loose.mp4” to the library root.')
})

// --- which suggestion is worth offering unasked ------------------------------
test('a weak guess is not offered on its own', () => {
  // Fine in a dialog opened to compare candidates; noise in a toast that appears
  // by itself, and noise teaches you to ignore the corner it appears in.
  expect(offerableBundle(ranked(['b1', 'Alpha', 0.2]))).toBeNull()
  expect(offerableBundle([])).toBeNull()
})

test('the strongest suggestion above the bar is the one offered', () => {
  const best = offerableBundle(ranked(['b1', 'Alpha', 0.8], ['b2', 'Beta', 0.5]))
  expect(best?.bundle_id).toBe('b1')
})

test('two bundles in one folder are not guessed between', () => {
  // The case a destination path genuinely cannot answer: same folder, same
  // score, order decided by their titles. Naming one would dress a coin flip up
  // as a recommendation — so nothing is offered and Add to Bundle lists both.
  expect(
    offerableBundle(ranked(['b1', 'Alpha Reel', 0.6], ['b2', 'Second Feature', 0.6])),
  ).toBeNull()
})

test('a real lead survives floating-point subtraction', () => {
  // 0.6 − 0.5 is 0.09999999999999998, so a margin of exactly 0.1 would reject
  // the weakest genuine signal the suggester can produce.
  const best = offerableBundle(ranked(['b1', 'Alpha', 0.6], ['b2', 'Beta', 0.5]))
  expect(best?.bundle_id).toBe('b1')
})

// --- the announcement --------------------------------------------------------
test('nothing is announced when nothing landed', async () => {
  await announceImport([], 'Studios', deps())

  expect(shown).toEqual([])
  expect(suggest).not.toHaveBeenCalled()
})

test('the offer asks only about the files that reached disk', async () => {
  // A skipped collision or a failed upload has no path; linking the name it
  // would have had would put a row in a bundle for a file that is not there.
  await announceImport(landed('Studios/behind.mp4'), 'Studios', deps())

  expect(suggest).toHaveBeenCalledWith(['Studios/behind.mp4'])
})

test('a confident suggestion is offered, and applied only when taken', async () => {
  suggest.mockResolvedValue(ranked(['b1', 'Alpha Reel', 0.7]))
  await announceImport(landed('Studios/behind.mp4'), 'Studios', deps())

  expect(shown).toHaveLength(1)
  expect(shown[0]?.message).toBe('Added “behind.mp4” to Studios.')
  expect(offer(0, 'Add to “Alpha Reel”')).toBeDefined()
  // Offered, not done: the toast can expire without anything being linked.
  expect(addToBundle).not.toHaveBeenCalled()

  offer(0, 'Add to “Alpha Reel”')?.run()
  expect(addToBundle).toHaveBeenCalledWith('b1', ['Studios/behind.mp4'])
  await vi.waitFor(() => expect(onLinked).toHaveBeenCalledWith('b1'))
  expect(shown[1]?.message).toBe('Added to “Alpha Reel”.')
})

test('an untitled bundle is still offerable', async () => {
  suggest.mockResolvedValue([
    { bundle_id: 'b1', title: null, confidence: 0.7, reason: 'same folder' } as TargetSuggestion,
  ])
  await announceImport(landed('Studios/behind.mp4'), 'Studios', deps())

  expect(offer(0, 'Add to “that bundle”')).toBeDefined()
})

test('Undo reverses every import in the batch, not just the last', async () => {
  // Each import is its own journal operation, so "undo what just happened" is
  // only honest if it covers all of them.
  await announceImport(landed('Studios/a.mp4', 'Studios/b.mp4'), 'Studios', deps())

  shown[0]?.undo?.()
  expect(undoOperation.mock.calls).toEqual([['op-1'], ['op-2']])
})

test('a failed suggestion lookup still reports the import, and still offers the picker', async () => {
  // The bytes are on disk. A convenience that could not be fetched must not make
  // a successful import read as a failure — nor leave it with no way forward.
  suggest.mockRejectedValue(new Error('offline'))
  await announceImport(landed('Studios/behind.mp4'), 'Studios', deps())

  expect(shown).toHaveLength(1)
  expect(shown[0]?.message).toBe('Added “behind.mp4” to Studios.')
  expect(offer(0, 'Add to Bundle')).toBeDefined()
  expect(shown[0]?.undo).toBeTypeOf('function')
})

test('an import always offers a way to bundle what just landed', async () => {
  // A toast that goes quiet is indistinguishable from a broken feature, which is
  // how the withheld guess read from the outside (owner, 2026-08-26). Every case
  // that declines to *name* a bundle still opens the picker.
  for (const ranking of [
    [] as ReturnType<typeof ranked>,
    ranked(['b1', 'Alpha', 0.2]), // too weak to name
    ranked(['b1', 'Alpha', 0.6], ['b2', 'Beta', 0.6]), // a tie the path cannot break
  ]) {
    shown.length = 0
    openPicker.mockClear()
    suggest.mockResolvedValue(ranking)
    await announceImport(landed('Studios/clip.mp4'), 'Studios', deps())

    expect(offer(0, 'Add to Bundle')).toBeDefined()
    offer(0, 'Add to Bundle')?.run()
    expect(openPicker).toHaveBeenCalledWith(['Studios/clip.mp4'])
    // Still nothing linked without a further, explicit choice in the dialog.
    expect(addToBundle).not.toHaveBeenCalled()
  }
})

test('a failed link says why, and does not claim success', async () => {
  suggest.mockResolvedValue(ranked(['b1', 'Alpha Reel', 0.7]))
  addToBundle.mockRejectedValue(new Error('That bundle is no longer in the library.'))
  await announceImport(landed('Studios/behind.mp4'), 'Studios', deps())

  offer(0, 'Add to “Alpha Reel”')?.run()
  await vi.waitFor(() => expect(shown).toHaveLength(2))
  expect(shown[1]?.message).toBe('That bundle is no longer in the library.')
  expect(onLinked).not.toHaveBeenCalled()
})

// --- creating a bundle, beside adding to one ---------------------------------
test('every import also offers to make a new bundle from what landed', async () => {
  // The suggester can only ever propose joining an *existing* bundle, but a file
  // arriving in the library is at least as likely to be a new one (owner,
  // 2026-08-26). Offered next to a confident suggestion, not instead of it.
  suggest.mockResolvedValue(ranked(['b1', 'Alpha Reel', 0.7]))
  await announceImport(landed('Studios/behind.mp4'), 'Studios', deps())

  expect(shown[0]?.offers.map((o) => o.label)).toEqual(['Add to “Alpha Reel”', 'New Bundle'])
  offer(0, 'New Bundle')?.run()
  expect(openCreate).toHaveBeenCalledWith(['Studios/behind.mp4'])
  // Creating is a dialog, not a silent write: nothing is bundled by the click.
  expect(addToBundle).not.toHaveBeenCalled()
})

test('an ambiguous folder offers both routes, neither of them a guess', async () => {
  suggest.mockResolvedValue(ranked(['b1', 'Alpha', 0.6], ['b2', 'Beta', 0.6]))
  await announceImport(landed('Studios/clip.mp4'), 'Studios', deps())

  expect(shown[0]?.offers.map((o) => o.label)).toEqual(['Add to Bundle', 'New Bundle'])
})
