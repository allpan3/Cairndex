import { expect, test } from 'vitest'

import {
  defaultSnapshotWidth,
  snapshotFileName,
  snapshotHeight,
  snapshotWidthOptions,
} from './snapshotExport'

const widths = (source: number) =>
  snapshotWidthOptions(source).map((option) => `${option.label}:${option.value}`)

test('ends the ladder at the source’s own width', () => {
  expect(widths(1920)).toEqual([
    '320px:320',
    '480px:480',
    '640px:640',
    '854px:854',
    '960px:960',
    '1280px:1280',
    '1600px:1600',
    '1920px:1920',
  ])
  expect(snapshotWidthOptions(1920).at(-1)?.note).toBe('native')
})

// Scaling a still up adds nothing, so nothing above the source is offered.
test('drops rungs the source cannot fill', () => {
  expect(widths(720)).toEqual(['320px:320', '480px:480', '640px:640', '720px:720'])
  expect(widths(400)).toEqual(['320px:320', '400px:400'])
})

// Unlike the GIF, a snapshot is a canvas draw rather than an encode, so a 4K
// source keeps its own size at the top of the wheel.
test('a source above every rung is still offered whole', () => {
  expect(widths(3840).at(-1)).toBe('3840px:3840')
  expect(widths(5000).at(-1)).toBe('5000px:5000')
})

test('a source below every rung offers only itself', () => {
  expect(widths(200)).toEqual(['200px:200'])
})

// One rung below native: smaller than the original without being tiny.
test('defaults to the rung below native', () => {
  expect(defaultSnapshotWidth(snapshotWidthOptions(1920))).toBe(1600)
  expect(defaultSnapshotWidth(snapshotWidthOptions(720))).toBe(640)
  // With only its own width on offer there is nowhere else to go.
  expect(defaultSnapshotWidth(snapshotWidthOptions(200))).toBe(200)
})

test('keeps the source aspect when scaling', () => {
  expect(snapshotHeight(960, 1920, 1080)).toBe(540)
  expect(snapshotHeight(640, 1920, 1080)).toBe(360)
  expect(snapshotHeight(400, 640, 480)).toBe(300)
  // Unlike the GIF path there is no even-height rule — a PNG has no such
  // constraint, so the exact aspect is kept.
  expect(snapshotHeight(321, 1920, 1080)).toBe(181)
})

test('has no height for an unprobed source', () => {
  expect(snapshotHeight(480, 0, 0)).toBe(0)
})

// The old name mangled the extension into the stem, giving `clip_mp4.png`.
test('names the PNG after the source without doubling its extension', () => {
  expect(snapshotFileName('clip.mp4')).toBe('clip.png')
  expect(snapshotFileName('a movie.mkv')).toBe('a movie.png')
  expect(snapshotFileName('Scene 2.5 rework')).toBe('Scene 2.5 rework.png')
  expect(snapshotFileName('a/b:c*d?.mkv')).toBe('a b c d.png')
  expect(snapshotFileName('')).toBe('snapshot.png')
})
