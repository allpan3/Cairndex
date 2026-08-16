import { expect, test } from 'vitest'

import {
  canDirectPlayVideo,
  computeCapabilities,
  sourceContainer,
  type CapabilityProbe,
} from './caps'

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
  // The tag it actually confirmed is advertised; the one it refused is not.
  expect(caps.video_codecs).toContain('hvc1')
  expect(caps.video_codecs).not.toContain('hev1')
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

test('normalizes ffprobe container lists and gates both stored codecs', () => {
  const caps = {
    protocols: ['progressive'],
    containers: ['mp4'],
    video_codecs: ['h264'],
    audio_codecs: ['aac'],
    max_height: null,
    native_hls: false,
  }
  const source = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    audioCodec: 'aac',
  }
  expect(sourceContainer(source)).toBe('mp4')
  expect(canDirectPlayVideo(source, caps)).toBe(true)
  expect(canDirectPlayVideo({ ...source, audioCodec: 'dts' }, caps)).toBe(false)
  expect(canDirectPlayVideo({ ...source, audioCodec: null }, caps)).toBe(true)
  expect(sourceContainer({ container: 'matroska,webm' })).toBe('mkv')
  expect(sourceContainer({ relativePath: 'clip.mov', container: source.container })).toBe('mov')
})

test('does not advertise a tag MSE accepts but progressive playback refuses', () => {
  // WebKit's real asymmetry: MediaSource reports hev1 as supported while the
  // video element refuses it. OR-ing the two probes would advertise hev1 and
  // send an unplayable source down the direct path.
  const caps = computeCapabilities({
    canPlayType: (type: string) =>
      type === 'video/mp4; codecs="hvc1.1.6.L93.B0"' ||
      type === 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
        ? 'probably'
        : '',
    isTypeSupported: () => true,
  })
  expect(caps.video_codecs).toContain('hvc1')
  expect(caps.video_codecs).not.toContain('hev1')
})

test('refuses direct play of an hev1 source the client only confirmed as hvc1', () => {
  const caps = {
    protocols: ['progressive', 'hls'],
    containers: ['mp4'],
    video_codecs: ['h264', 'hevc', 'hvc1'],
    audio_codecs: ['aac'],
    max_height: null,
    native_hls: true,
  }
  const source = {
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'hevc',
    audioCodec: 'aac',
  }
  expect(canDirectPlayVideo({ ...source, videoCodecTag: 'hvc1' }, caps)).toBe(true)
  expect(canDirectPlayVideo({ ...source, videoCodecTag: 'hev1' }, caps)).toBe(false)
  // Rows probed before the tag was recorded keep the previous optimistic path.
  expect(canDirectPlayVideo(source, caps)).toBe(true)
  expect(canDirectPlayVideo({ ...source, videoCodecTag: null }, caps)).toBe(true)
})

test('a browser that only confirms 8-bit codecs advertises no depth token', () => {
  // The family probes are all 8-bit profile strings, so answering them says
  // nothing about 10-bit content. Advertising the family alone let a 10-bit
  // source take the direct path and be refused by the engine (2026-08-15).
  const caps = computeCapabilities(
    probe([
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'audio/mp4; codecs="mp4a.40.2"',
    ]),
  )
  expect(caps.video_codecs).toEqual(expect.arrayContaining(['h264', 'hevc']))
  expect(caps.video_codecs).not.toContain('hevc10')
  expect(caps.video_codecs).not.toContain('h26410')
})

test('a browser that confirms 10-bit HEVC advertises the depth token too', () => {
  const caps = computeCapabilities(
    probe([
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hvc1.2.4.L120.B0"',
      'audio/mp4; codecs="mp4a.40.2"',
    ]),
  )
  expect(caps.video_codecs).toEqual(expect.arrayContaining(['hevc', 'hevc10']))
  // High 10 H.264 is decoded by nothing, so it stays absent either way.
  expect(caps.video_codecs).not.toContain('h26410')
})

test('the direct-play gate refuses depths and Dolby Vision the server would too', () => {
  // This gate and the server's decision matrix have to agree: a source waved
  // through here is one the client will try to play as plain bytes, and the
  // server would have routed it to a transcode instead.
  const eightBitOnly = computeCapabilities(
    probe([
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'audio/mp4; codecs="mp4a.40.2"',
    ]),
  )
  const source = { relativePath: 'clip.mp4', videoCodec: 'hevc', audioCodec: 'aac' }

  expect(canDirectPlayVideo({ ...source, bitDepth: 8 }, eightBitOnly)).toBe(true)
  expect(canDirectPlayVideo({ ...source, bitDepth: 10 }, eightBitOnly)).toBe(false)
  // Unprobed depth stays optimistic, like the unprobed codec tag beside it.
  expect(canDirectPlayVideo(source, eightBitOnly)).toBe(true)
  // Dolby Vision is signalled only by the tag; the family and depth both pass.
  expect(canDirectPlayVideo({ ...source, videoCodecTag: 'dvh1' }, eightBitOnly)).toBe(false)
})
