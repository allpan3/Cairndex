// Why a media stage failed, derived from the element's own `MediaError`.
//
// The viewer used to keep a single `failed` boolean and show one card for every
// failure: "Playback interrupted… this can happen after seeking into a part that
// hasn't loaded yet. Try again to resume." That sentence asserts a specific,
// transient cause and offers a retry — which is wrong, and expensively wrong,
// for a file the engine has refused outright. A format it cannot decode fails
// identically on every attempt, so the card invited the user to keep pressing a
// button that could never work, while pointing diagnosis at the network.

/**
 * How a stage failure should be explained.
 *
 * `unsupported` is a verdict about the *bytes*: the engine looked at the media
 * and rejected it, so every retry replays the same refusal. `interrupted` is
 * about delivery, which a reload genuinely can fix. They need opposite
 * affordances — one an explanation and no button, the other a retry.
 */
export type PlaybackFailureKind = 'unsupported' | 'interrupted'

// The four `MediaError` codes, spelled out so this module does not depend on the
// `MediaError` global existing (it is absent in some SSR/test environments).
const MEDIA_ERR_DECODE = 3
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

/**
 * Classify an `HTMLMediaElement.error`.
 *
 * `MEDIA_ERR_DECODE` (the stream decoded far enough to prove it is broken) and
 * `MEDIA_ERR_SRC_NOT_SUPPORTED` (the container/codec was refused up front) are
 * verdicts about the media. Recovery cannot change them, so callers skip the
 * reload budget rather than spending it to reach the same answer.
 *
 * `MEDIA_ERR_ABORTED` and `MEDIA_ERR_NETWORK` are delivery failures — exactly
 * what a reload fixes. A missing error object classifies the same way: an
 * unexplained failure stays retryable, because withholding a retry that would
 * have worked is the more costly mistake of the two.
 */
export function classifyMediaError(error: MediaError | null | undefined): PlaybackFailureKind {
  if (!error) return 'interrupted'
  return error.code === MEDIA_ERR_DECODE || error.code === MEDIA_ERR_SRC_NOT_SUPPORTED
    ? 'unsupported'
    : 'interrupted'
}
