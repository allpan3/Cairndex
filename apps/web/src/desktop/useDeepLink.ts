import { useEffect, useRef } from 'react'

import { isDesktopHost, listenHostDeepLink, takeHostPendingDeepLink } from '../platform'
import type { DeepLinkTarget } from '../platform'

/** Stable identity for one link, used to de-duplicate the two delivery paths. */
export function deepLinkIdentity(target: DeepLinkTarget): string {
  return `${target.kind}:${target.id}:${target.libraryId ?? ''}`
}

/**
 * Delivers `cairndex://` deep links to the SPA exactly once (plan 3 §7).
 *
 * Two paths feed this, because the OS picks one for us:
 *
 * - **Warm start.** The app is already running; the shell emits an event and the
 *   subscription below receives it.
 * - **Cold start.** The OS launches the app *with* the URL. On macOS that is an
 *   Apple Event that can fire before the webview exists, so the shell parks the
 *   link and this hook drains it on mount.
 *
 * Both can fire for one user action, so a link is de-duplicated by identity
 * before it reaches the handler — otherwise a cold-start link could open its
 * target, and then open it a second time when the event arrives.
 */
export function useDeepLink(
  handler: (target: DeepLinkTarget) => void,
  /**
   * Gates delivery until the app can actually act on a link. A cold-start link is
   * drained milliseconds after mount, while the libraries query is still in
   * flight, so classifying it against an empty list would report every
   * `?library=` link as "not on this server". Nothing is lost by waiting: the
   * shell parks links until the SPA drains them.
   */
  enabled = true,
): void {
  const handlerRef = useRef(handler)
  // Retains the last target delivered, so the parked copy and the event that
  // describes the same link cannot both act.
  const lastDelivered = useRef<string | null>(null)

  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    if (!isDesktopHost() || !enabled) return
    let disposed = false
    let unlisten: (() => void) | undefined

    const deliver = (target: DeepLinkTarget) => {
      if (disposed) return
      const identity = deepLinkIdentity(target)
      if (lastDelivered.current === identity) return
      lastDelivered.current = identity
      handlerRef.current(target)
    }

    void listenHostDeepLink(deliver)
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((error: unknown) => console.error('Could not subscribe to deep links', error))

    // Drain after subscribing, so a link arriving in between is not lost.
    void takeHostPendingDeepLink()
      .then((target) => {
        if (target) deliver(target)
      })
      .catch((error: unknown) => console.error('Could not read the pending deep link', error))

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [enabled])
}
