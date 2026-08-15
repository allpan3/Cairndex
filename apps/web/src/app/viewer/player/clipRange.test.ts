import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  clampRange,
  defaultRange,
  formatClipTime,
  frameSeconds,
  moveEdge,
  nudgeEdge,
  rangeDuration,
  setEdgeAtPlayhead,
} from './clipRange'

describe('frameSeconds', () => {
  it('inverts a probed frame rate', () => {
    expect(frameSeconds(25)).toBeCloseTo(0.04)
    expect(frameSeconds(59.94)).toBeCloseTo(1 / 59.94)
  })

  // Matches `usePlayer.frameStep`, so a nudge and a frame step agree.
  it('falls back to 30 fps when the rate is missing or nonsense', () => {
    expect(frameSeconds(null)).toBeCloseTo(1 / 30)
    expect(frameSeconds(undefined)).toBeCloseTo(1 / 30)
    expect(frameSeconds(0)).toBeCloseTo(1 / 30)
    expect(frameSeconds(-24)).toBeCloseTo(1 / 30)
  })
})

describe('clampRange', () => {
  it('keeps a span that is already inside the media', () => {
    expect(clampRange({ start: 2, end: 8 }, 60)).toEqual({ start: 2, end: 8 })
  })

  it('trims a span that runs past either end', () => {
    expect(clampRange({ start: -5, end: 8 }, 60)).toEqual({ start: 0, end: 8 })
    expect(clampRange({ start: 50, end: 90 }, 60)).toEqual({ start: 50, end: 60 })
  })

  it('extends a too-short span forward rather than dropping it', () => {
    expect(clampRange({ start: 10, end: 10 }, 60)).toEqual({
      start: 10,
      end: 10 + MIN_CLIP_SECONDS,
    })
  })

  // An inverted range is a broken selection, not a backwards one: repairing it
  // in place keeps the edge the owner last moved where they put it.
  it('repairs an inverted span', () => {
    const repaired = clampRange({ start: 30, end: 10 }, 60)
    expect(repaired.start).toBe(30)
    expect(rangeDuration(repaired)).toBeCloseTo(MIN_CLIP_SECONDS)
  })

  it('backs the start off when there is no room to extend forward', () => {
    const repaired = clampRange({ start: 60, end: 60 }, 60)
    expect(repaired.end).toBe(60)
    expect(rangeDuration(repaired)).toBeCloseTo(MIN_CLIP_SECONDS)
  })
})

describe('moveEdge', () => {
  it('moves the edge that was asked for and leaves the other alone', () => {
    expect(moveEdge({ start: 2, end: 8 }, 'start', 4, 60)).toEqual({ start: 4, end: 8 })
    expect(moveEdge({ start: 2, end: 8 }, 'end', 12, 60)).toEqual({ start: 2, end: 12 })
  })

  // The stationary edge is the reference the owner is aiming at; pushing it
  // would move the thing they are measuring against mid-drag.
  it('stops short of the other edge instead of pushing it', () => {
    const pushed = moveEdge({ start: 2, end: 8 }, 'start', 20, 60)
    expect(pushed.end).toBe(8)
    expect(pushed.start).toBeCloseTo(8 - MIN_CLIP_SECONDS)

    const pulled = moveEdge({ start: 2, end: 8 }, 'end', 0, 60)
    expect(pulled.start).toBe(2)
    expect(pulled.end).toBeCloseTo(2 + MIN_CLIP_SECONDS)
  })

  it('clamps to the media', () => {
    expect(moveEdge({ start: 2, end: 8 }, 'start', -10, 60).start).toBe(0)
    expect(moveEdge({ start: 2, end: 8 }, 'end', 999, 60).end).toBe(60)
  })
})

describe('nudgeEdge', () => {
  it('shifts an edge by a signed offset', () => {
    const frame = frameSeconds(25)
    const nudged = nudgeEdge({ start: 2, end: 8 }, 'start', frame, 60)
    expect(nudged.start).toBeCloseTo(2 + frame)
    expect(nudged.end).toBe(8)
  })

  it('obeys the same floor as a direct move', () => {
    const nudged = nudgeEdge({ start: 2, end: 8 }, 'end', -100, 60)
    expect(nudged.end).toBeCloseTo(2 + MIN_CLIP_SECONDS)
  })
})

describe('setEdgeAtPlayhead', () => {
  it('behaves like a plain move while the edge stays on its own side', () => {
    expect(setEdgeAtPlayhead({ start: 10, end: 20 }, 'start', 12, 120)).toEqual({
      start: 12,
      end: 20,
    })
    expect(setEdgeAtPlayhead({ start: 10, end: 20 }, 'end', 25, 120)).toEqual({
      start: 10,
      end: 25,
    })
  })

  // Clamping here collapsed the clip to its floor, which is never what "start
  // it here" meant — the owner has a length and is choosing where it begins.
  it('carries the whole span forward when the start lands past the end', () => {
    expect(setEdgeAtPlayhead({ start: 10, end: 20 }, 'start', 50, 120)).toEqual({
      start: 50,
      end: 60,
    })
  })

  it('carries the span backwards when the end lands before the start', () => {
    expect(setEdgeAtPlayhead({ start: 40, end: 50 }, 'end', 20, 120)).toEqual({
      start: 10,
      end: 20,
    })
  })

  // "…unless the remainder of the video is not long enough": the instant the
  // owner named wins, and the clip is whatever fits after it.
  it('keeps the named instant and shortens when the video runs out', () => {
    expect(setEdgeAtPlayhead({ start: 10, end: 20 }, 'start', 115, 120)).toEqual({
      start: 115,
      end: 120,
    })
    expect(setEdgeAtPlayhead({ start: 60, end: 90 }, 'end', 10, 120)).toEqual({
      start: 0,
      end: 10,
    })
  })

  it('still leaves a usable span at the very end of the video', () => {
    const shifted = setEdgeAtPlayhead({ start: 10, end: 20 }, 'start', 120, 120)
    expect(shifted.end).toBe(120)
    expect(rangeDuration(shifted)).toBeCloseTo(MIN_CLIP_SECONDS)
  })

  it('clamps a target outside the media', () => {
    expect(setEdgeAtPlayhead({ start: 10, end: 20 }, 'start', -5, 120).start).toBe(0)
    expect(setEdgeAtPlayhead({ start: 10, end: 20 }, 'end', 999, 120).end).toBe(120)
  })
})

describe('defaultRange', () => {
  it('runs forward from the playhead', () => {
    expect(defaultRange(10, 600)).toEqual({ start: 10, end: 10 + DEFAULT_CLIP_SECONDS })
  })

  it('backs off the end when the playhead is near it', () => {
    const near = defaultRange(59, 60)
    expect(near.end).toBe(60)
    expect(near.start).toBeCloseTo(60 - DEFAULT_CLIP_SECONDS)
  })

  // A clip opened on a video shorter than the default span still has to be a
  // valid selection.
  it('fits inside a video shorter than the default span', () => {
    const tiny = defaultRange(0, 2)
    expect(tiny.start).toBe(0)
    expect(tiny.end).toBe(2)
  })
})

describe('formatClipTime', () => {
  it('prints minutes, seconds, and milliseconds', () => {
    expect(formatClipTime(0)).toBe('0:00.000')
    expect(formatClipTime(41.375)).toBe('0:41.375')
    expect(formatClipTime(125.5)).toBe('2:05.500')
  })

  it('adds an hour field only when there is one', () => {
    expect(formatClipTime(3600)).toBe('1:00:00.000')
    expect(formatClipTime(3661.25)).toBe('1:01:01.250')
  })

  // Rounding the fraction on its own prints `.1000`; patching only that prints
  // `0:60.000` one boundary up. Both carry all the way here.
  it('carries a rounded millisecond through seconds and minutes', () => {
    expect(formatClipTime(7.9999)).toBe('0:08.000')
    expect(formatClipTime(59.9999)).toBe('1:00.000')
    expect(formatClipTime(3599.9999)).toBe('1:00:00.000')
  })

  it('does not print a negative or non-finite time', () => {
    expect(formatClipTime(-5)).toBe('0:00.000')
    expect(formatClipTime(Number.NaN)).toBe('0:00.000')
  })
})
