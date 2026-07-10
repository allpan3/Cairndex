// Client capability profile (plan 1 §6.1 / §6.3).
//
// The server decides direct/remux/transcode from what this client can actually
// play, so we must only advertise formats the browser's own probes confirm —
// AGENTS.md forbids claiming playback support for untested formats. Support is
// probed two ways and OR-ed: `HTMLVideoElement.canPlayType` (native progressive
// `<video src>` playback) and `MediaSource.isTypeSupported` (the MSE path hls.js
// uses for remux/transcode). A codec the browser can decode via *either* path is
// playable, because the server can deliver it either directly or over HLS.
//
// Computed once at module load and memoized; the result is a stable object for
// the lifetime of the tab.

import type { components } from '../../../api/schema'

export type ClientCapabilities = components['schemas']['ClientCapabilities']

// A probe environment, injectable so the derivation is unit-testable without a
// real DOM. `isTypeSupported` is null when MediaSource is unavailable.
export interface CapabilityProbe {
  canPlayType: (type: string) => string
  isTypeSupported: ((type: string) => boolean) | null
}

// Candidate MIME/codec strings per normalized codec/container name. The names
// on the left match the server's normalized vocabulary (media/playback.py); the
// strings on the right are representative RFC 6381 codec parameters. A name is
// advertised when *any* of its candidate strings probes as supported.
const VIDEO_CODEC_PROBES: Record<string, string[]> = {
  h264: ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.640028"'],
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  vp9: ['video/mp4; codecs="vp09.00.10.08"', 'video/webm; codecs="vp9"'],
  av1: ['video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="av01.0.05M.08"'],
  vp8: ['video/webm; codecs="vp8"'],
}

const AUDIO_CODEC_PROBES: Record<string, string[]> = {
  aac: ['audio/mp4; codecs="mp4a.40.2"'],
  mp3: ['audio/mpeg', 'audio/mp4; codecs="mp3"', 'audio/mp4; codecs="mp4a.69"'],
  opus: ['audio/webm; codecs="opus"', 'audio/ogg; codecs="opus"', 'audio/mp4; codecs="opus"'],
  vorbis: ['audio/webm; codecs="vorbis"', 'audio/ogg; codecs="vorbis"'],
  flac: ['audio/flac', 'audio/mp4; codecs="flac"'],
}

// A container is advertised only when a representative codec combination inside
// it plays — an empty container claim would be meaningless to the decision.
const CONTAINER_PROBES: Record<string, string[]> = {
  mp4: ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"'],
  webm: ['video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="vp9, opus"'],
}

const HLS_MIME = 'application/vnd.apple.mpegurl'
// hls.js needs an MSE codec it can attach; H.264/AAC in fMP4 is the universal
// baseline it always targets, so probe it to decide whether MSE HLS works.
const MSE_BASELINE = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'

function supported(probe: CapabilityProbe, candidates: string[]): boolean {
  return candidates.some(
    (type) => probe.canPlayType(type) !== '' || (probe.isTypeSupported?.(type) ?? false),
  )
}

function names(probe: CapabilityProbe, table: Record<string, string[]>): string[] {
  return Object.entries(table)
    .filter(([, candidates]) => supported(probe, candidates))
    .map(([name]) => name)
}

/** Derive a capability profile from an injectable probe (pure, unit-testable). */
export function computeCapabilities(probe: CapabilityProbe): ClientCapabilities {
  const nativeHls = probe.canPlayType(HLS_MIME) !== ''
  const mseHls = probe.isTypeSupported?.(MSE_BASELINE) ?? false
  const protocols = ['progressive']
  if (nativeHls || mseHls) protocols.push('hls')
  return {
    protocols,
    containers: names(probe, CONTAINER_PROBES),
    video_codecs: names(probe, VIDEO_CODEC_PROBES),
    audio_codecs: names(probe, AUDIO_CODEC_PROBES),
    // No browser API reports a maximum decode height, and capping optimistically
    // would force needless transcodes of content the browser can decode. Leave
    // it unset (the server treats null as "no client height cap"); the user can
    // still pick a lower quality ladder from the settings menu.
    max_height: null,
    native_hls: nativeHls,
  }
}

function domProbe(): CapabilityProbe {
  const video = document.createElement('video')
  const mse =
    typeof window !== 'undefined' &&
    typeof window.MediaSource !== 'undefined' &&
    typeof window.MediaSource.isTypeSupported === 'function'
      ? (type: string) => window.MediaSource.isTypeSupported(type)
      : null
  return {
    canPlayType: (type: string) => video.canPlayType(type),
    isTypeSupported: mse,
  }
}

let cached: ClientCapabilities | null = null

/** Memoized capability profile for this tab (computed on first access). */
export function getClientCapabilities(): ClientCapabilities {
  if (cached === null) cached = computeCapabilities(domProbe())
  return cached
}
