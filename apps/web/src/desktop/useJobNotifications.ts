import { useEffect, useRef } from 'react'

import type { JobRead } from '../api/client'
import {
  ensureHostNotificationPermission,
  isDesktopHost,
  notifyHost,
  setHostBadgeCount,
} from '../platform'
import { accumulateRun, isNotableRun, runNotification, RUN_SETTLE_MS, type JobRun } from './jobRun'

/** True when the user is not looking at the app right now. */
function isAway(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus()
}

/**
 * Notifies and badges the dock when a long maintenance run finishes (plan 3 §7).
 *
 * Fed by the same polled job snapshots the sidebar progress bar already uses, so
 * this adds no polling of its own. Three deliberate rules keep it from becoming
 * noise:
 *
 * - one notification per *run*, not per job (see `jobRun.ts`);
 * - only for runs long enough that the user plausibly walked away;
 * - only when the window is actually unfocused — telling someone a job finished
 *   while they are watching its progress bar is pure noise.
 *
 * Inert in the browser.
 */
export function useJobNotifications(activeJob: JobRead | null): void {
  const run = useRef<JobRun | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Permission is requested when a run *starts*, so the system prompt appears
  // while the user is present and has just asked for the work.
  const askedPermission = useRef(false)

  useEffect(() => {
    if (!isDesktopHost()) return
    if (activeJob) {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current)
        settleTimer.current = null
      }
      if (!run.current && !askedPermission.current) {
        askedPermission.current = true
        void ensureHostNotificationPermission().catch(() => undefined)
      }
      run.current = accumulateRun(run.current, activeJob, Date.now())
      return
    }

    // No active job: the run may be over, or the chained Update flow may just be
    // between stages. Wait out the gap before deciding.
    const finished = run.current
    if (!finished || settleTimer.current) return
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null
      run.current = null
      if (!isNotableRun(finished, Date.now()) || !isAway()) return
      const { title, body } = runNotification(finished)
      void notifyHost(title, body).catch(() => undefined)
      void setHostBadgeCount(1).catch(() => undefined)
    }, RUN_SETTLE_MS)
  }, [activeJob])

  // The badge means "something finished while you were away", so returning to the
  // window is exactly what should clear it.
  useEffect(() => {
    if (!isDesktopHost()) return
    const clear = () => void setHostBadgeCount(null).catch(() => undefined)
    window.addEventListener('focus', clear)
    return () => window.removeEventListener('focus', clear)
  }, [])

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current)
    },
    [],
  )
}
