// Detecting progressive playback that has quietly stopped advancing.
//
// The load watchdog in `ViewerShell` covers only the window before metadata
// arrives: it arms while `readyState < HAVE_METADATA` and `loadedmetadata`
// disarms it for good. After that the single route into the failure path is the
// media element's own `error` event — and a progressive read can die without
// ever firing one. `stalled`, `suspend` and `abort` are not wired to anything.
//
// The result was a player frozen on its last decoded frame with a live control
// bar, no fallback card, no retry, and not a single request in flight: play and
// seek appeared to do nothing at all, with nothing on screen to explain it
// (owner-reported, 2026-08-16, on a direct progressive source in the File
// Browser). This turns that silence back into the ordinary "Playback
// interrupted / Try again" path the viewer already has.
//
// **Progressive only.** hls.js has its own fragment timeouts, retries and a
// fatal path already wired to the same handler, and the server legitimately
// holds a segment request for two 20 s passes while ffmpeg catches up — a 15 s
// client deadline would tear down a session that was merely transcoding slowly.
// The caller opts HLS out; see `ViewerShell`.
//
// Kept as a pure observer so the decision is testable without a media element:
// the timing rules are the whole substance, and they are exactly what a
// component test would struggle to pin down.

/** What one look at the media element says about its progress. */
export interface StallSample {
  paused: boolean
  seeking: boolean
  ended: boolean
  /** Zero means time is deliberately not advancing, which is not a stall. */
  playbackRate: number
  readyState: number
  currentTime: number
  /**
   * Total buffered seconds across *every* range, not the end of the last one.
   *
   * Seeking forward and back leaves the element holding several ranges, and the
   * one being refilled is often not the last. Watching only the far end reads a
   * healthy refill as no bytes arriving at all — which is the exact state a
   * seek past the buffered region produces, so measuring it that way would fire
   * on the very gesture that motivated this.
   */
  bufferedSeconds: number
}

/** `HTMLMediaElement.HAVE_METADATA`, spelled out so this module needs no DOM. */
const HAVE_METADATA = 1

export interface StallDetector {
  /** Record one sample; true means playback has been stuck past the threshold. */
  observe: (sample: StallSample, now: number) => boolean
}

/**
 * Watch for a source that should be advancing and is not.
 *
 * Two things must both be true before this reports a stall, and the second is
 * what keeps it quiet during ordinary buffering: the playhead has not moved,
 * **and** no new bytes have arrived anywhere. A slow network that is still
 * filling a buffer is playing badly, not broken, and the player already says so
 * through its loading state — firing here would replace a spinner that resolves
 * with a card that did not need showing.
 *
 * Anything that legitimately freezes the clock — paused, seeking, ended, a zero
 * rate, or metadata not yet loaded — resets the countdown rather than counting
 * toward a stall. Pausing on the out-point of a clip range lands here too, via
 * `paused`.
 *
 * `maxSampleGapMs` guards the other direction: a tab throttled in the
 * background, a suspended webview, or a machine that slept leaves one enormous
 * gap between samples. Nothing is known about that interval, so it starts the
 * countdown again instead of being counted as a stall the element never had a
 * chance to avoid.
 */
export function createStallDetector(
  thresholdMs: number,
  maxSampleGapMs = thresholdMs,
): StallDetector {
  let lastProgressAt: number | null = null
  let lastSampleAt: number | null = null
  let lastTime = Number.NaN
  let lastBufferedSeconds = Number.NaN

  return {
    observe(sample, now) {
      const gapped = lastSampleAt !== null && now - lastSampleAt > maxSampleGapMs
      lastSampleAt = now

      const idle =
        sample.paused ||
        sample.seeking ||
        sample.ended ||
        sample.playbackRate === 0 ||
        sample.readyState < HAVE_METADATA
      // Any change counts, in either direction: a clip loop restarting at its
      // in-point moves the playhead backward, and that is playback working.
      // Narrowing this to `>` would card a range loop every threshold.
      const moved =
        sample.currentTime !== lastTime || sample.bufferedSeconds !== lastBufferedSeconds
      lastTime = sample.currentTime
      lastBufferedSeconds = sample.bufferedSeconds

      if (idle || moved || gapped || lastProgressAt === null) {
        lastProgressAt = now
        return false
      }
      if (now - lastProgressAt < thresholdMs) return false
      // Report once per stall, not once per sample: the caller's recovery is
      // budgeted, and a detector that re-fired every second would spend the
      // whole budget in the time it takes one reload to be given a chance.
      lastProgressAt = now
      return true
    },
  }
}
