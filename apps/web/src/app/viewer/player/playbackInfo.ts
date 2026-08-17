import type { HlsStatus, PlaybackMethod } from './useHlsSession'

/**
 * How the current video is reaching the player, in words.
 *
 * The server already decides this and already explains itself — every
 * `PlaybackDecision` carries a `reason` written for a person to read. Until now
 * none of it surfaced, so "is this file playing directly or through a session?"
 * was answerable only by watching the network tab or the transcode directory.
 * The owner asked for it in the info panel (2026-08-16), and it is also the only
 * way to tell that a session-lifetime fix is being exercised at all.
 */
export interface PlaybackDescription {
  /** What is happening to the bytes: "Direct play", "Transcoding", … */
  label: string
  /** Why, in the server's words — null when it has not answered yet. */
  detail: string | null
  /** True when an ffmpeg session backs this playback, i.e. remux or transcode. */
  session: boolean
}

const METHOD_LABEL: Record<PlaybackMethod, string> = {
  direct: 'Direct play',
  remux: 'Remuxing',
  transcode: 'Transcoding',
}

/**
 * Returns null when there is nothing truthful to say — no decision has come
 * back, so the row is hidden rather than filled with an em-dash or a guess.
 */
export function describePlayback(
  status: HlsStatus,
  method: PlaybackMethod | null,
  reason: string,
): PlaybackDescription | null {
  if (status === 'deciding') return { label: 'Checking…', detail: null, session: false }
  if (status === 'unavailable')
    return { label: 'Not playable here', detail: reason || null, session: false }
  if (status === 'error')
    return { label: 'Playback failed', detail: reason || null, session: false }
  if (!method) return null
  return {
    label: METHOD_LABEL[method],
    detail: reason || null,
    // A remux or transcode means a live ffmpeg session with a playlist, an idle
    // timeout and a keepalive behind it — the thing worth knowing about.
    session: method !== 'direct',
  }
}
