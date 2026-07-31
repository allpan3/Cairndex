import { expect, test } from 'vitest'

import {
  formatBitrate,
  formatCodec,
  formatFileRole,
  formatFileType,
  formatHdr,
  formatResolution,
  formatSampleRate,
  formatVideoEncoding,
  resolutionClass,
} from './format'

test('the file type is the container format, with the media kind as fallback', () => {
  expect(formatFileType('video', 'movie.mp4')).toBe('MP4')
  expect(formatFileType('video', 'movie.MKV')).toBe('MKV')
  expect(formatFileType('other', 'paper.pdf')).toBe('PDF')
  // No usable extension leaves the media kind as the only true thing to say.
  expect(formatFileType('image', 'README')).toBe('image')
  expect(formatFileType('other', 'README')).toBe('file')
  // Dots earlier in a name are ignored; only the last segment is considered.
  expect(formatFileType('video', 'S01.E02.1080p.mkv')).toBe('MKV')
  // A trailing segment too long to be an extension falls back rather than
  // printing a word out of the middle of the filename as the file's type.
  expect(formatFileType('video', 'render.checkpoint')).toBe('video')
})

test('a bundle row leads with the file role, not the container format', () => {
  // The inspector's row slot answers "what is this file to the bundle" and is
  // slated to become a manual-role dropdown — so it must stay the media kind,
  // not drift to MP4/MKV the way the type surfaces did (owner, 2026-07-28).
  expect(formatFileRole('video', 'movie.mp4')).toBe('video')
  expect(formatFileRole('subtitle', 'movie.srt')).toBe('subtitle')
  expect(formatFileRole('audio', 'commentary.m4a')).toBe('audio')
  // Only an unclassified file falls back to its extension.
  expect(formatFileRole('other', 'paper.pdf')).toBe('pdf')
  expect(formatFileRole('other', 'README')).toBe('file')
})

test('codecs read as the names people know them by', () => {
  expect(formatCodec('hevc')).toBe('HEVC')
  expect(formatCodec('h264')).toBe('H.264')
  expect(formatCodec('eac3')).toBe('Dolby Digital Plus')
  expect(formatCodec('aac')).toBe('AAC')
  // Unlisted codecs upper-case, which beats printing ffmpeg's spelling as-is.
  expect(formatCodec('somenewcodec')).toBe('SOMENEWCODEC')
  expect(formatCodec(null)).toBe('—')
  expect(formatCodec('  ')).toBe('—')
})

test('bitrates use the decimal units they are quoted in', () => {
  expect(formatBitrate(15_934_358)).toBe('15.9 Mbps')
  expect(formatBitrate(320_000)).toBe('320 kbps')
  expect(formatBitrate(500)).toBe('500 bps')
  expect(formatBitrate(0)).toBe('—')
  expect(formatBitrate(null)).toBe('—')
})

test('audio sample rates use conventional hertz units', () => {
  expect(formatSampleRate(48_000)).toBe('48 kHz')
  expect(formatSampleRate(44_100)).toBe('44.1 kHz')
  expect(formatSampleRate(800)).toBe('800 Hz')
  expect(formatSampleRate(null)).toBe('—')
})

test('HDR signalling is spelled out, and SDR says nothing', () => {
  expect(formatHdr('dv')).toBe('Dolby Vision')
  expect(formatHdr('hdr10')).toBe('HDR10')
  expect(formatHdr('hlg')).toBe('HLG')
  expect(formatHdr(null)).toBeNull()
})

test('the video line only mentions what is worth mentioning', () => {
  // Ordinary 8-bit SDR adds nothing to the codec name.
  expect(formatVideoEncoding('hevc', { bitDepth: 8, hdr: null })).toBe('HEVC')
  expect(formatVideoEncoding('hevc', { bitDepth: 10, hdr: 'hdr10' })).toBe('HEVC · 10-bit · HDR10')
  expect(formatVideoEncoding('h264', { fps: 59.94 })).toBe('H.264 · 59.94 fps')
  expect(formatVideoEncoding(null)).toBe('—')
})

test('common resolutions get their short name, by the long side', () => {
  expect(resolutionClass(1920, 1080)).toBe('1080p')
  expect(resolutionClass(3840, 2160)).toBe('4K')
  expect(resolutionClass(4096, 2160)).toBe('4K') // DCI within tolerance
  expect(resolutionClass(1280, 720)).toBe('720p')
  expect(resolutionClass(7680, 4320)).toBe('8K')
  // Portrait video classifies by its long side, not its width.
  expect(resolutionClass(1080, 1920)).toBe('1080p')
  // A scope crop is still the class its long side says it is.
  expect(resolutionClass(1920, 800)).toBe('1080p')
})

test('an unnamed resolution declines rather than guessing', () => {
  expect(resolutionClass(1000, 1000)).toBeNull()
  expect(resolutionClass(null, 1080)).toBeNull()
  // The display form falls back to honest dimensions.
  expect(formatResolution(1000, 1000)).toBe('1000 × 1000')
  expect(formatResolution(3840, 2160)).toBe('4K')
  expect(formatResolution(null, null)).toBe('—')
})
