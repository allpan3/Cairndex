import { useCallback, useEffect, useRef, useState } from 'react'

import {
  beaconTeardownSession,
  deletePlaybackSession,
  requestPlaybackDecision,
  type AudioStreamRead,
  type ClientCapabilities,
  type PlaybackDecisionResponse,
} from '../../../api/client'
import type { PlaybackSource } from './engine'

const HLS_MIME = 'application/vnd.apple.mpegurl'
// A reaped session (long pause) can produce a couple of consecutive errors while
// hls.js drains its buffer; allow a small re-attach budget before giving up so a
// genuinely broken stream still surfaces the fallback card instead of looping.
const MAX_REATTACH = 3

type PlaybackMethod = PlaybackDecisionResponse['method']

export type HlsStatus = 'idle' | 'deciding' | 'ready' | 'error'

/** User-selectable switches that force a fresh decision + session (§6.3). */
export interface SwitchParams {
  audioStreamIndex: number | null
  burnSubtitleTrackId: string | null
  maxHeight: number | null
}

const DEFAULT_PARAMS: SwitchParams = {
  audioStreamIndex: null,
  burnSubtitleTrackId: null,
  maxHeight: null,
}

export interface UseHlsSessionOptions {
  /** Current file id when it is an available video; null disables the hook. */
  fileId: string | null
  /** The current file is an available video with a manifest entry. */
  enabled: boolean
  /** Manifest says the source is directly playable (a fast native fallback). */
  directPlayable: boolean
  directStreamUrl: string | null
  directMimeType: string | null
  /** This client's capability profile (memoized by the caller). */
  caps: ClientCapabilities
  /** Read the live playhead when switching quality/audio or re-attaching. */
  getCurrentTime: () => number
}

export interface HlsSessionState {
  /** The source to feed the player, or null while deciding / unplayable. */
  source: PlaybackSource | null
  method: PlaybackMethod | null
  status: HlsStatus
  reason: string
  /** Selectable audio tracks (from the decision) — empty for direct play. */
  audioStreams: AudioStreamRead[]
  params: SwitchParams
  setAudioStream: (index: number | null) => void
  setMaxHeight: (height: number | null) => void
  setBurnSubtitle: (trackId: string | null) => void
  /** Transparently re-request a decision at the playhead; true if it applies. */
  reattach: () => boolean
  /** Signal that playback resumed so the re-attach budget can be refunded. */
  notePlaying: () => void
}

/**
 * Per-file playback decision + HLS session lifecycle (plan 1 §6.3, M7).
 *
 * When a video starts, POSTs a playback decision for this client's caps. Direct
 * decisions become a native progressive source; remux/transcode decisions start
 * a server HLS session whose playlist becomes an hls.js / native-HLS source.
 * Sessions are torn down on file switch, quality/audio switch, unmount, and
 * pagehide (beacon). A playlist/segment error (e.g. an idled-out session) or an
 * hls.js fatal transparently re-requests a fresh session at the current playhead
 * instead of failing. If the decision request itself fails, a directly-playable
 * file falls back to its native stream so playback still works.
 */
export function useHlsSession({
  fileId,
  enabled,
  directPlayable,
  directStreamUrl,
  directMimeType,
  caps,
  getCurrentTime,
}: UseHlsSessionOptions): HlsSessionState {
  const [source, setSource] = useState<PlaybackSource | null>(null)
  const [method, setMethod] = useState<PlaybackMethod | null>(null)
  const [status, setStatus] = useState<HlsStatus>('idle')
  const [reason, setReason] = useState('')
  const [audioStreams, setAudioStreams] = useState<AudioStreamRead[]>([])
  const [params, setParams] = useState<SwitchParams>(DEFAULT_PARAMS)
  // Bumped by a quality/audio/burn-in switch or a re-attach to force a fresh
  // decision for the same file without changing fileId.
  const [epoch, setEpoch] = useState(0)

  const paramsRef = useRef<SwitchParams>(DEFAULT_PARAMS)
  const startAtRef = useRef(0)
  const liveSessionRef = useRef<{ fileId: string; sessionId: string } | null>(null)
  const reattachCountRef = useRef(0)
  const lastFileRef = useRef<string | null>(null)
  const getCurrentTimeRef = useRef(getCurrentTime)
  useEffect(() => {
    getCurrentTimeRef.current = getCurrentTime
  }, [getCurrentTime])

  const teardownLive = useCallback(() => {
    const live = liveSessionRef.current
    if (live) {
      void deletePlaybackSession(live.fileId, live.sessionId).catch(() => {})
      liveSessionRef.current = null
    }
  }, [])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reset/decision status are
       synchronized to the current file, not derived render state */
    const freshFile = lastFileRef.current !== fileId
    if (freshFile) {
      lastFileRef.current = fileId
      paramsRef.current = DEFAULT_PARAMS
      startAtRef.current = 0
      reattachCountRef.current = 0
      teardownLive()
      // Clear the previous file's video immediately; a switch keeps the current
      // stream visible until the new decision resolves.
      setSource(null)
      setParams(DEFAULT_PARAMS)
      setAudioStreams([])
    }

    if (!enabled || !fileId) {
      teardownLive()
      setStatus('idle')
      setSource(null)
      return
    }

    const controller = new AbortController()
    const startAt = startAtRef.current
    const active = paramsRef.current
    setStatus('deciding')
    /* eslint-enable react-hooks/set-state-in-effect */

    const nativeSource = (url: string): PlaybackSource => ({
      src: url,
      mimeType: directMimeType ?? 'video/mp4',
      kind: 'native',
      startAt,
    })

    requestPlaybackDecision(
      fileId,
      {
        caps,
        audio_stream_index: active.audioStreamIndex,
        burn_subtitle_track_id: active.burnSubtitleTrackId,
        max_height: active.maxHeight,
      },
      controller.signal,
    )
      .then((decision) => {
        if (controller.signal.aborted) return
        const replaced = liveSessionRef.current
        setMethod(decision.method)
        setReason(decision.reason)
        setAudioStreams(decision.audio_streams)
        if (decision.method === 'direct') {
          liveSessionRef.current = null
          const url = decision.stream_url ?? directStreamUrl
          if (url) {
            setSource(nativeSource(url))
            setStatus('ready')
          } else {
            setStatus('error')
          }
        } else if (decision.session) {
          liveSessionRef.current = { fileId, sessionId: decision.session.id }
          setSource({
            src: decision.session.playlist_url,
            mimeType: HLS_MIME,
            kind: 'hls',
            nativeHls: caps.native_hls,
            startAt,
          })
          setStatus('ready')
        } else if (directPlayable && directStreamUrl) {
          // Non-direct decision with no session (e.g. an un-probed row): fall
          // back to the native stream when the source is directly playable.
          liveSessionRef.current = null
          setSource(nativeSource(directStreamUrl))
          setStatus('ready')
        } else {
          liveSessionRef.current = null
          setStatus('error')
        }
        // Tear down the session this decision replaced (a switch/re-attach).
        if (replaced && replaced.sessionId !== liveSessionRef.current?.sessionId) {
          void deletePlaybackSession(replaced.fileId, replaced.sessionId).catch(() => {})
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // The decision request failed outright — degrade to the manifest's
        // direct path so a playable file still plays (and old servers without
        // the decision endpoint keep working).
        if (directPlayable && directStreamUrl) {
          setMethod('direct')
          setSource(nativeSource(directStreamUrl))
          setStatus('ready')
        } else {
          setStatus('error')
        }
      })

    return () => controller.abort()
  }, [fileId, enabled, epoch, directPlayable, directStreamUrl, directMimeType, caps, teardownLive])

  // Tear down the live session on unmount; beacon it on pagehide (POST-only).
  useEffect(() => {
    const onPageHide = () => {
      const live = liveSessionRef.current
      if (live) beaconTeardownSession(live.fileId, live.sessionId)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      teardownLive()
    }
  }, [teardownLive])

  // A switch re-decides for the same file, resuming at the live playhead.
  const applyParams = useCallback((next: SwitchParams) => {
    paramsRef.current = next
    startAtRef.current = Math.max(0, getCurrentTimeRef.current())
    setParams(next)
    setEpoch((value) => value + 1)
  }, [])

  const setAudioStream = useCallback(
    (index: number | null) => applyParams({ ...paramsRef.current, audioStreamIndex: index }),
    [applyParams],
  )
  const setMaxHeight = useCallback(
    (height: number | null) => applyParams({ ...paramsRef.current, maxHeight: height }),
    [applyParams],
  )
  const setBurnSubtitle = useCallback(
    (trackId: string | null) => applyParams({ ...paramsRef.current, burnSubtitleTrackId: trackId }),
    [applyParams],
  )

  // Playback actually resumed (initial start or a successful re-attach), so
  // refund the re-attach budget. Resetting on decision success instead would let
  // a persistently broken stream re-decide forever without ever falling back.
  const notePlaying = useCallback(() => {
    reattachCountRef.current = 0
  }, [])

  const reattach = useCallback((): boolean => {
    // Only HLS sources can be re-attached (native progressive play just errors).
    if (liveSessionRef.current === null) return false
    if (reattachCountRef.current >= MAX_REATTACH) return false
    reattachCountRef.current += 1
    startAtRef.current = Math.max(0, getCurrentTimeRef.current())
    // The idled-out session is gone server-side; drop the ref so we don't try to
    // DELETE a 404 — the fresh decision installs a new session.
    liveSessionRef.current = null
    setEpoch((value) => value + 1)
    return true
  }, [])

  return {
    source,
    method,
    status,
    reason,
    audioStreams,
    params,
    setAudioStream,
    setMaxHeight,
    setBurnSubtitle,
    reattach,
    notePlaying,
  }
}
