import { useEffect } from 'react'

import type { JobRead } from '../api/client'
import {
  ensureHostNotificationPermission,
  isDesktopHost,
  notifyHost,
  setHostBadgeCount,
} from '../platform'
import { accumulateRun, isNotableRun, runNotification, RUN_SETTLE_MS, type JobRun } from './jobRun'

/**
 * Run state lives at module scope rather than in refs because the Workspace that
 * hosts this hook is keyed on `libraryId` and remounts on a library switch — which
 * a deep link can now cause. Component-local state would drop a run in flight, so
 * that run would never notify. Only one Workspace is mounted at a time, so a
 * single module-level record is unambiguous.
 */
interface NotificationState {
  run: JobRun | null
  settleTimer: ReturnType<typeof setTimeout> | null
  askedPermission: boolean
}

const state: NotificationState = { run: null, settleTimer: null, askedPermission: false }

/**
 * Drop any run in flight.
 *
 * Used by connection activation as well as by tests: run state is module-scoped
 * so it survives a Workspace remount (a deliberate D5b choice, so a library
 * switch does not lose a run), which means a *connection* switch must clear it
 * explicitly or a run started on the previous server settles here and notifies
 * about work on a server the user has left.
 *
 * `askedPermission` is deliberately preserved — the OS notification prompt is
 * per-app, not per-connection, and re-asking on every switch would be the exact
 * nagging the D5b design avoided.
 */
export function resetJobNotifications(): void {
  if (state.settleTimer) clearTimeout(state.settleTimer)
  state.run = null
  state.settleTimer = null
}

/** Test-only: seed a run and the permission flag. */
export function setJobRunForTests(seed: { startedAt: number; askedPermission: boolean }): void {
  state.run = { startedAt: seed.startedAt, jobs: new Map(), failed: false } as unknown as JobRun
  state.askedPermission = seed.askedPermission
}

/** Test-only: observe the module-scoped state without exporting it. */
export function peekJobRunForTests(): { run: JobRun | null; askedPermission: boolean } {
  return { run: state.run, askedPermission: state.askedPermission }
}

/** Test-only reset: also forgets that permission was requested. */
export function resetJobNotificationsForTests(): void {
  resetJobNotifications()
  state.askedPermission = false
}

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
  useEffect(() => {
    if (!isDesktopHost()) return
    if (activeJob) {
      if (state.settleTimer) {
        clearTimeout(state.settleTimer)
        state.settleTimer = null
      }
      // Permission is requested when a run *starts*, so the system prompt appears
      // while the user is present and has just asked for the work.
      if (!state.run && !state.askedPermission) {
        state.askedPermission = true
        void ensureHostNotificationPermission().catch((error: unknown) =>
          console.error('Could not request notification permission', error),
        )
      }
      state.run = accumulateRun(state.run, activeJob, Date.now())
      return
    }

    // No active job: the run may be over, or the chained Update flow may just be
    // between stages. Wait out the gap before deciding.
    const finished = state.run
    if (!finished || state.settleTimer) return
    state.settleTimer = setTimeout(() => {
      state.settleTimer = null
      state.run = null
      if (!isNotableRun(finished, Date.now()) || !isAway()) return
      const { title, body } = runNotification(finished)
      // Report rather than swallow: a denied capability or refused permission is a
      // real misconfiguration, and silently discarding it is exactly how the dock
      // badge shipped broken once already.
      void notifyHost(title, body).catch((error: unknown) =>
        console.error('Could not post the job notification', error),
      )
      void setHostBadgeCount(1).catch((error: unknown) =>
        console.error('Could not set the dock badge', error),
      )
    }, RUN_SETTLE_MS)
  }, [activeJob])

  // The badge means "something finished while you were away", so returning to the
  // window is exactly what should clear it.
  useEffect(() => {
    if (!isDesktopHost()) return
    const clear = () =>
      void setHostBadgeCount(null).catch((error: unknown) =>
        console.error('Could not clear the dock badge', error),
      )
    window.addEventListener('focus', clear)
    return () => window.removeEventListener('focus', clear)
  }, [])
}
