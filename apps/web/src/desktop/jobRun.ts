import type { JobRead } from '../api/client'

/**
 * A maintenance *run* — the whole stretch of continuous background activity, not
 * one job. `Update library` chains scan → probe → storyboards, so notifying per
 * job would fire three times for one user action (plan 3 §7 asks for a
 * notification when "a long job" finishes, singular).
 */
export interface JobRun {
  /** Job types seen during the run, in first-seen order. */
  types: JobRead['job_type'][]
  /** Wall-clock start of the first job in the run. */
  startedAt: number
  /** True when any job in the run ended in a non-success terminal state. */
  failed: boolean
}

/** Runs shorter than this are not worth interrupting the user for. */
export const LONG_RUN_MS = 10_000

/**
 * Gap tolerated between two jobs before the run is considered over. The chained
 * Update flow briefly reports no active job between its stages, so ending the run
 * on the first null would split one user action into several notifications.
 */
export const RUN_SETTLE_MS = 1_500

const TYPE_LABELS: Record<JobRead['job_type'], string> = {
  scan: 'Scan',
  probe: 'Media analysis',
  thumbnail: 'Thumbnails',
  storyboard: 'Storyboards',
}

/** Folds one polled job snapshot into the run being accumulated. */
export function accumulateRun(run: JobRun | null, job: JobRead, now: number): JobRun {
  const started = run?.startedAt ?? jobStart(job, now)
  const types = run?.types ?? []
  return {
    types: types.includes(job.job_type) ? types : [...types, job.job_type],
    startedAt: started,
    // `cancelled` is a deliberate user action, so it is not reported as a failure.
    failed: (run?.failed ?? false) || job.status === 'failed',
  }
}

/**
 * Prefers the server's own start timestamp so a run queued behind another job is
 * measured by when it actually ran, not when this client first polled it.
 */
function jobStart(job: JobRead, now: number): number {
  const stamp = job.started_at ?? job.created_at
  if (!stamp) return now
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? parsed : now
}

/** Whether a finished run is worth a user notification. */
export function isNotableRun(run: JobRun, now: number): boolean {
  return now - run.startedAt >= LONG_RUN_MS
}

/** Title and body for a finished run. */
export function runNotification(run: JobRun): { title: string; body: string } {
  const labels = run.types.map((type) => TYPE_LABELS[type])
  const what = labels.length === 0 ? 'Background work' : formatList(labels)
  return run.failed
    ? { title: 'Cairndex ran into a problem', body: `${what} did not finish cleanly.` }
    : { title: 'Cairndex finished', body: `${what} complete.` }
}

/** Joins labels the way a sentence would: "A", "A and B", "A, B and C". */
function formatList(labels: string[]): string {
  if (labels.length === 1) return labels[0] as string
  const head = labels.slice(0, -1).join(', ')
  return `${head} and ${labels[labels.length - 1] as string}`
}
