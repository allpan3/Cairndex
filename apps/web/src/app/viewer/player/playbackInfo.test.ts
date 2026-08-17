import { describe, expect, it } from 'vitest'

import { describePlayback } from './playbackInfo'

describe('describePlayback', () => {
  it('names each delivery method', () => {
    expect(describePlayback('ready', 'direct', 'r')?.label).toBe('Direct play')
    expect(describePlayback('ready', 'remux', 'r')?.label).toBe('Remuxing')
    expect(describePlayback('ready', 'transcode', 'r')?.label).toBe('Transcoding')
  })

  it('flags a session for remux and transcode but not direct play', () => {
    // The whole point of the row: a session has an idle timeout and a keepalive
    // behind it, and until now nothing told you one was running.
    expect(describePlayback('ready', 'direct', '')?.session).toBe(false)
    expect(describePlayback('ready', 'remux', '')?.session).toBe(true)
    expect(describePlayback('ready', 'transcode', '')?.session).toBe(true)
  })

  it("passes the server's reason through as the detail", () => {
    const described = describePlayback('ready', 'transcode', 'hevc video codec is not in caps')

    expect(described?.detail).toBe('hevc video codec is not in caps')
  })

  it('says nothing at all before a decision has come back', () => {
    // No em-dash, no guess: the row is hidden rather than asserting a method.
    expect(describePlayback('idle', null, '')).toBeNull()
    expect(describePlayback('ready', null, '')).toBeNull()
  })

  it('reports that it is still deciding', () => {
    expect(describePlayback('deciding', null, '')).toEqual({
      label: 'Checking…',
      detail: null,
      session: false,
    })
  })

  it('reports a refusal and a failure with their reasons', () => {
    expect(describePlayback('unavailable', null, 'Dolby Vision needs transcoding')).toEqual({
      label: 'Not playable here',
      detail: 'Dolby Vision needs transcoding',
      session: false,
    })
    expect(describePlayback('error', 'transcode', 'session expired')).toEqual({
      label: 'Playback failed',
      detail: 'session expired',
      session: false,
    })
  })

  it('drops an empty reason rather than rendering a blank line', () => {
    expect(describePlayback('ready', 'direct', '')?.detail).toBeNull()
    expect(describePlayback('error', null, '')?.detail).toBeNull()
  })
})
