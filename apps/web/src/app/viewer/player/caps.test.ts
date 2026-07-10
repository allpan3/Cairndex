import { expect, test } from 'vitest'

import { computeCapabilities, type CapabilityProbe } from './caps'

// Build a probe from an allow-list of MIME/codec strings. `canPlayType` returns
// 'probably' for allowed strings (empty otherwise, like a real browser);
// `isTypeSupported` is only provided when MSE is present.
function probe(allowed: string[], { mse = true }: { mse?: boolean } = {}): CapabilityProbe {
  const ok = (type: string) => allowed.includes(type)
  return {
    canPlayType: (type: string) => (ok(type) ? 'probably' : ''),
    isTypeSupported: mse ? (type: string) => ok(type) : null,
  }
}

test('derives a Chromium-like profile (MSE, no native HLS)', () => {
  const caps = computeCapabilities(
    probe([
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'video/mp4; codecs="avc1.42E01E"',
      'video/webm; codecs="vp9, opus"',
      'video/mp4; codecs="vp09.00.10.08"',
      'audio/mp4; codecs="mp4a.40.2"',
      'audio/webm; codecs="opus"',
    ]),
  )
  expect(caps.containers).toEqual(expect.arrayContaining(['mp4', 'webm']))
  expect(caps.video_codecs).toEqual(expect.arrayContaining(['h264', 'vp9']))
  // HEVC was never probed as supported, so it must not be advertised.
  expect(caps.video_codecs).not.toContain('hevc')
  expect(caps.audio_codecs).toEqual(expect.arrayContaining(['aac', 'opus']))
  expect(caps.native_hls).toBe(false)
  // MSE H.264/AAC baseline probes true → hls.js path is advertised.
  expect(caps.protocols).toContain('hls')
  expect(caps.max_height).toBeNull()
})

test('derives a Safari-like profile (native HLS + HEVC, no MSE)', () => {
  const caps = computeCapabilities(
    probe(
      [
        'application/vnd.apple.mpegurl',
        'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
        'video/mp4; codecs="avc1.42E01E"',
        'video/mp4; codecs="hvc1.1.6.L93.B0"',
        'audio/mp4; codecs="mp4a.40.2"',
      ],
      { mse: false },
    ),
  )
  expect(caps.native_hls).toBe(true)
  expect(caps.video_codecs).toEqual(expect.arrayContaining(['h264', 'hevc']))
  expect(caps.containers).toContain('mp4')
  // Native HLS still advertises the hls protocol even without MSE.
  expect(caps.protocols).toContain('hls')
})

test('advertises nothing beyond progressive when no probe reports support', () => {
  const caps = computeCapabilities(probe([], { mse: false }))
  expect(caps.containers).toEqual([])
  expect(caps.video_codecs).toEqual([])
  expect(caps.audio_codecs).toEqual([])
  expect(caps.native_hls).toBe(false)
  expect(caps.protocols).toEqual(['progressive'])
})
