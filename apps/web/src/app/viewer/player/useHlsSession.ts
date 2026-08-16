import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  beaconTeardownSession,
  deletePlaybackSession,
  HttpError,
  requestPlaybackDecision,
  type AudioStreamRead,
  type ClientCapabilities,
  type PlaybackTarget,
} from '../../../api/client'
import { registerDesktopExitTask } from '../../../desktop/exitTasks'
import { isDesktopHost } from '../../../platform'
import type { PlaybackSource } from './engine'

const HLS_MIME = 'application/vnd.apple.mpegurl'
// A reaped session (long pause) can produce a couple of consecutive errors while
// hls.js drains its buffer; allow a small re-attach budget before giving up so a
// genuinely broken stream still surfaces the fallback card instead of looping.
const MAX_REATTACH = 3
// Require this much continuous healthy playback past a re-attach before refunding
// the budget, so a stream that flaps (plays a second, dies, repeats) still falls
// back instead of re-deciding forever.
const HEALTHY_REFUND_S = 10
// A rapid quality/audio switch can momentarily exceed the server session bound
// while the superseded session is still being torn down; retry the decision once
// after a short delay before surfacing a capacity error.
const CAPACITY_RETRY_MS = 350
// Cap how long we wait on a playback decision before giving up. Without this the
// UI could sit on "Preparing playback…" indefinitely when the server is wedged
// (e.g. an exhausted DB pool makes the request block on a connection). On expiry
// we abort and surface an explicit "server unavailable" card the user can retry,
// instead of a spinner that never resolves.
const DECISION_TIMEOUT_MS = 15_000
const PLAYBACK_UNAVAILABLE_REASON =
  'The playback server is unavailable. It may be overloaded or restarting — try again in a moment.'

// 'unavailable' is a distinct terminal state from 'error': the source may be
// perfectly playable, but the server could not be reached to decide/prepare it.
export type HlsStatus = 'idle' | 'deciding' | 'ready' | 'error' | 'unavailable'

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
  /** Current file id when it is an available, indexed video; else null. */
  fileId: string | null
  /**
   * Library-relative path when this is a File Browser source; else null.
   *
   * Used only when there is no `fileId`. A path reaches the same decision
   * matrix and the same HLS sessions through the path-scoped routes, with an
   * on-demand probe standing in for stored metadata — which is what lets an
   * unscanned library play a source the browser cannot decode. With neither,
   * playback falls back to `directStreamUrl` if there is one.
   *
   * Both are primitives rather than one target object on purpose: the decision
   * effect keys off them, and a caller passing a fresh object every render
   * would re-decide on every render.
   */
  browserPath: string | null
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
  status: HlsStatus
  reason: string
  /** Selectable audio tracks (from the decision) — empty for direct play. */
  audioStreams: AudioStreamRead[]
  params: SwitchParams
  /** Change one switch param (quality/audio/burn-in) → new decision + session. */
  setParam: <K extends keyof SwitchParams>(key: K, value: SwitchParams[K]) => void
  /** Transparently re-request a decision at the playhead; true if it applies. */
  reattach: () => boolean
  /** Signal that playback resumed so the re-attach budget can be refunded. */
  notePlaying: () => void
  /** Re-run the decision from the start (e.g. after an 'unavailable' timeout). */
  retry: () => void
}

/**
 * Per-file playback decision + HLS session lifecycle (plan 1 §6.3, M7).
 *
 * When a video starts, POSTs a playback decision for this client's caps. Direct
 * decisions become a native progressive source; remux/transcode decisions start
 * a server HLS session whose playlist becomes an hls.js / native-HLS source.
 * Sessions are torn down on file switch, quality/audio switch, and unmount.
 * Browser pagehide uses a beacon; desktop exit awaits the ordinary authenticated
 * DELETE. This also reaps a session the server started for a request the client
 * already abandoned. A playlist/segment error (e.g. an idled-out session) or an
 * hls.js fatal transparently re-requests a fresh session at the current playhead
 * instead of failing. If the decision request itself fails, a directly-playable
 * file falls back to its native stream so playback still works.
 */
export function useHlsSession({
  fileId,
  browserPath,
  enabled,
  directPlayable,
  directStreamUrl,
  directMimeType,
  caps,
  getCurrentTime,
}: UseHlsSessionOptions): HlsSessionState {
  // A row wins over a path: an indexed File Browser entry should reach the same
  // subtitles, storyboards and resume the Bundle Browser gives it.
  const target = useMemo<PlaybackTarget | null>(
    () =>
      fileId ? { kind: 'file', fileId } : browserPath ? { kind: 'path', path: browserPath } : null,
    [fileId, browserPath],
  )
  const [source, setSource] = useState<PlaybackSource | null>(null)
  // Start in 'deciding' so the very first frame of a playable file shows the
  // loading state, never a flash of the "can't be previewed" fallback card.
  const [status, setStatus] = useState<HlsStatus>('deciding')
  const [reason, setReason] = useState('')
  const [audioStreams, setAudioStreams] = useState<AudioStreamRead[]>([])
  const [params, setParams] = useState<SwitchParams>(DEFAULT_PARAMS)
  // Bumped by a quality/audio/burn-in switch or a re-attach to force a fresh
  // decision for the same source without changing the target.
  const [epoch, setEpoch] = useState(0)

  const paramsRef = useRef<SwitchParams>(DEFAULT_PARAMS)
  const startAtRef = useRef(0)
  // The target is kept with the session id: teardown has to address the route
  // the session came from, and by then the current target may have moved on.
  const liveSessionRef = useRef<{ target: PlaybackTarget; sessionId: string } | null>(null)
  const reattachCountRef = useRef(0)
  const reattachAtRef = useRef(Number.NEGATIVE_INFINITY)
  const reattachingRef = useRef(false)
  const lastSourceRef = useRef<string | null>(null)
  const getCurrentTimeRef = useRef(getCurrentTime)
  useEffect(() => {
    getCurrentTimeRef.current = getCurrentTime
  }, [getCurrentTime])

  // Claims and deletes the tracked session so desktop exit can await completion
  const teardownLive = useCallback(async () => {
    const live = liveSessionRef.current
    if (live) {
      liveSessionRef.current = null
      await deletePlaybackSession(live.target, live.sessionId).catch(() => {})
    }
  }, [])

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reset/decision status are
       synchronized to the current file, not derived render state */
    // A target with no id or path (there is none) falls back to the stream URL —
    // otherwise stepping between two of them would look like the same file and
    // carry the previous one's playhead into the next.
    const sourceKey = (target?.kind === 'file' ? target.fileId : target?.path) ?? directStreamUrl
    const freshFile = lastSourceRef.current !== sourceKey
    if (freshFile) {
      lastSourceRef.current = sourceKey
      paramsRef.current = DEFAULT_PARAMS
      startAtRef.current = 0
      reattachCountRef.current = 0
      reattachAtRef.current = Number.NEGATIVE_INFINITY
      reattachingRef.current = false
      void teardownLive()
      // Clear the previous file's video immediately; a switch keeps the current
      // stream visible until the new decision resolves.
      setSource(null)
      setParams(DEFAULT_PARAMS)
      setAudioStreams([])
    }

    if (!enabled) {
      void teardownLive()
      setStatus('idle')
      setSource(null)
      return
    }

    // Nothing to decide about — neither a file row nor a path the server can
    // resolve. Play whatever bytes we were handed and let the media element
    // return the verdict, surfaced through the stage's error path.
    if (!target) {
      if (!directStreamUrl) {
        void teardownLive()
        setStatus('idle')
        setSource(null)
        return
      }
      void teardownLive()
      setSource({
        src: directStreamUrl,
        mimeType: directMimeType ?? 'video/mp4',
        kind: 'native',
        startAt: startAtRef.current,
      })
      setStatus('ready')
      return
    }

    const controller = new AbortController()
    // Distinguishes a timeout abort (surface 'unavailable') from a teardown abort
    // (switch/unmount — stay silent). Set just before we abort on the deadline.
    let timedOut = false
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, DECISION_TIMEOUT_MS)
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

    const decide = async () => {
      const payload = {
        caps,
        audio_stream_index: active.audioStreamIndex,
        burn_subtitle_track_id: active.burnSubtitleTrackId,
        max_height: active.maxHeight,
      }
      try {
        return await requestPlaybackDecision(target, payload, controller.signal)
      } catch (err) {
        // The superseded session's teardown may still be freeing a slot; give a
        // capacity rejection one retry before treating it as a hard failure.
        if (!controller.signal.aborted && err instanceof HttpError && err.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, CAPACITY_RETRY_MS))
          return requestPlaybackDecision(target, payload, controller.signal)
        }
        throw err
      }
    }

    decide()
      .then((decision) => {
        if (controller.signal.aborted) {
          // The effect was torn down while this request was in flight, but the
          // server may have already started a session — reap it so it does not
          // orphan until the idle reaper runs.
          if (decision.session) {
            void deletePlaybackSession(target, decision.session.id).catch(() => {})
          }
          return
        }
        reattachingRef.current = false
        const replaced = liveSessionRef.current
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
          liveSessionRef.current = { target, sessionId: decision.session.id }
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
          void deletePlaybackSession(replaced.target, replaced.sessionId).catch(() => {})
        }
      })
      .catch((err: unknown) => {
        // A teardown abort (switch/unmount) stays silent; a timeout abort does not.
        if (controller.signal.aborted && !timedOut) return
        reattachingRef.current = false
        // The decision request failed outright. When we can degrade to the
        // manifest's direct path, we are replacing any prior session with native
        // playback, so tear it down first (mirrors the success path's replaced-
        // session teardown). A non-degradable file keeps its live session tracked
        // (torn down on close/switch/idle) rather than orphaning a working stream
        // on a transient blip.
        if (directPlayable && directStreamUrl) {
          void teardownLive()
          setSource(nativeSource(directStreamUrl))
          setStatus('ready')
        } else if (timedOut || (err instanceof HttpError && err.status >= 500)) {
          // The client deadline elapsed, or the server reported it could not
          // service the request (e.g. an exhausted DB pool → QueuePool 500).
          // Surface a distinct, retryable "server unavailable" state instead of
          // the format-oriented "can't play" card.
          liveSessionRef.current = null
          setReason(PLAYBACK_UNAVAILABLE_REASON)
          setStatus('unavailable')
        } else {
          setStatus('error')
        }
      })
      .finally(() => window.clearTimeout(timeoutId))

    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [target, enabled, epoch, directPlayable, directStreamUrl, directMimeType, caps, teardownLive])

  // Awaits ordinary authenticated teardown before the desktop host exits
  useEffect(() => {
    if (!isDesktopHost()) return
    return registerDesktopExitTask(teardownLive)
  }, [teardownLive])

  // Tear down on unmount; web pagehide retains its POST-only beacon fallback
  useEffect(() => {
    const onPageHide = () => {
      if (isDesktopHost()) return
      const live = liveSessionRef.current
      if (live) beaconTeardownSession(live.target, live.sessionId)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      void teardownLive()
    }
  }, [teardownLive])

  // A switch re-decides for the same file, resuming at the live playhead.
  const setParam = useCallback(<K extends keyof SwitchParams>(key: K, value: SwitchParams[K]) => {
    paramsRef.current = { ...paramsRef.current, [key]: value }
    startAtRef.current = Math.max(0, getCurrentTimeRef.current())
    setParams(paramsRef.current)
    setEpoch((current) => current + 1)
  }, [])

  // Playback advanced past a re-attach point by a healthy margin, so refund the
  // budget. Gating on real progress (not the `play` intent) keeps a broken stream
  // from re-deciding forever.
  const notePlaying = useCallback(() => {
    if (reattachCountRef.current === 0) return
    if (getCurrentTimeRef.current() - reattachAtRef.current >= HEALTHY_REFUND_S) {
      reattachCountRef.current = 0
    }
  }, [])

  // Re-run the decision from scratch (start at 0), used by the 'unavailable'
  // retry affordance. Unlike reattach it does not consume the re-attach budget
  // and applies even with no live session.
  const retry = useCallback(() => {
    reattachingRef.current = false
    startAtRef.current = Math.max(0, getCurrentTimeRef.current())
    setEpoch((current) => current + 1)
  }, [])

  const reattach = useCallback((): boolean => {
    // A re-attach is already in flight — swallow the extra stage error(s) that a
    // single failure burst produces instead of spending another budget slot or
    // (with the ref already nulled) surrendering to the fallback card.
    if (reattachingRef.current) return true
    // Only HLS sources can be re-attached (native progressive play just errors).
    if (liveSessionRef.current === null) return false
    if (reattachCountRef.current >= MAX_REATTACH) return false
    reattachCountRef.current += 1
    reattachingRef.current = true
    startAtRef.current = Math.max(0, getCurrentTimeRef.current())
    reattachAtRef.current = startAtRef.current
    // The idled-out session is gone server-side; drop the ref so we don't try to
    // DELETE a 404 — the fresh decision installs a new session.
    liveSessionRef.current = null
    setEpoch((current) => current + 1)
    return true
  }, [])

  return {
    source,
    status,
    reason,
    audioStreams,
    params,
    setParam,
    reattach,
    notePlaying,
    retry,
  }
}
