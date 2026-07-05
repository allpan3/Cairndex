import { describe, expect, test } from 'vitest'

import { cueForTime, parseStoryboardVtt, storyboardSheetUrl } from './storyboardVtt'

const VTT = `WEBVTT

NOTE cairndex-quick-fingerprint: abc

00:00:00.000 --> 00:00:02.000
storyboard/sb_001.jpg?v=abc#xywh=0,0,320,180

00:00:02.000 --> 00:00:04.000
storyboard/sb_001.jpg?v=abc#xywh=320,0,320,180

00:00:04.000 --> 00:00:05.000
storyboard/sb_001.jpg?v=abc#xywh=640,0,320,180
`

describe('storyboard VTT parser', () => {
  test('parses cue boundaries and crops', () => {
    const cues = parseStoryboardVtt(VTT)
    expect(cues).toHaveLength(3)
    expect(cues[0]).toEqual({
      start: 0,
      end: 2,
      url: 'storyboard/sb_001.jpg?v=abc',
      x: 0,
      y: 0,
      w: 320,
      h: 180,
    })
    expect(cueForTime(cues, 1.99)).toEqual({ cue: cues[0], index: 0 })
    expect(cueForTime(cues, 2)).toEqual({ cue: cues[1], index: 1 })
  })

  test('clamps exact duration and out-of-range hover time to the last cue', () => {
    const cues = parseStoryboardVtt(VTT)
    expect(cueForTime(cues, 5)).toEqual({ cue: cues[2], index: 2 })
    expect(cueForTime(cues, 99)).toEqual({ cue: cues[2], index: 2 })
  })

  test('ignores malformed cue pairs', () => {
    const cues = parseStoryboardVtt(`WEBVTT

00:00:00.000 --> 00:00:00.000
storyboard/sb_001.jpg?v=abc#xywh=0,0,320,180

00:00:01.000 --> 00:00:02.000
broken

00:00:02.000 --> 00:00:03.000
storyboard/sb_001.jpg?v=abc#xywh=320,0,320,180
`)
    expect(cues).toHaveLength(1)
    expect(cues[0]?.x).toBe(320)
  })

  test('parses portrait tile dimensions', () => {
    const cues = parseStoryboardVtt(`WEBVTT

00:00:00.000 --> 00:00:02.000
storyboard/sb_001.jpg?v=portrait#xywh=0,0,320,568
`)
    expect(cues[0]).toMatchObject({ w: 320, h: 568 })
  })

  test('resolves sheet URLs with version params by standard relative rules', () => {
    expect(
      storyboardSheetUrl(
        '/api/v1/libraries/lib/files/f/storyboard.vtt?v=abc',
        'storyboard/sb_002.jpg?v=abc',
      ),
    ).toBe('http://localhost:3000/api/v1/libraries/lib/files/f/storyboard/sb_002.jpg?v=abc')
  })
})
