import { expect, test } from 'vitest'

import { collapsePrefixLengths } from './distinctNames'

test('siblings sharing a long stem collapse it at a word boundary', () => {
  const names = [
    'pornforce - 250621 - FirstBigDick - Part1.mp4',
    'pornforce - 250621 - FirstBigDick - Part2.mp4',
  ]
  const cuts = collapsePrefixLengths(names)
  // The raw common prefix ends mid-token ('…Part'); the cut snaps back to the
  // separator so the distinct tail is a whole word.
  expect(names[0]?.slice(cuts[0])).toBe('Part1.mp4')
  expect(names[1]?.slice(cuts[1])).toBe('Part2.mp4')
})

test('an unrelated file does not stop its siblings collapsing', () => {
  const names = ['deep_ocean.en.srt', 'deep_ocean.es.srt', 'deep_ocean.mp4', 'poster.jpg']
  const cuts = collapsePrefixLengths(names)
  expect(names[0]?.slice(cuts[0])).toBe('en.srt')
  expect(names[1]?.slice(cuts[1])).toBe('es.srt')
  expect(names[2]?.slice(cuts[2])).toBe('mp4')
  expect(cuts[3]).toBe(0) // poster.jpg shares nothing worth collapsing
})

test('a short shared run stays plain', () => {
  // "IMG_" is real but collapsing four characters saves nothing.
  expect(collapsePrefixLengths(['IMG_1.jpg', 'IMG_2.jpg'])).toEqual([0, 0])
})

test('a single file stays plain', () => {
  expect(collapsePrefixLengths(['a very long lonely filename.mp4'])).toEqual([0])
})

test('identical labels still keep a non-empty tail', () => {
  // Nothing can tell two identical names apart, but the cut must still leave
  // visible text after it rather than an empty span.
  const names = ['duplicate name.mp4', 'duplicate name.mp4']
  for (const [i, cut] of collapsePrefixLengths(names).entries()) {
    expect((names[i] as string).slice(cut).length).toBeGreaterThan(0)
  }
})

test('one name being a prefix of another never leaves an empty tail', () => {
  const names = ['holiday - rome.mp4', 'holiday - rome - extended.mp4']
  const cuts = collapsePrefixLengths(names)
  for (const [i, cut] of cuts.entries()) {
    expect((names[i] as string).slice(cut).length).toBeGreaterThan(0)
  }
})
