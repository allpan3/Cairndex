import type { JobRead } from '../api/client'

/** What a finished scan has to tell the owner. */
export interface ScanOutcome {
  /** Linked files still missing after reconciliation, old misses included. */
  missingTotal: number
  /** Staging rows dropped because the scan proved their files are gone. */
  forgotten: number
}

/** Read the two counts a completed scan reports, defensively.
 *
 * The job result is an untyped payload, and an older server (or a cancelled run)
 * may carry neither key — which reads as zero rather than as an error.
 */
export function scanOutcome(job: JobRead): ScanOutcome {
  const result = job.result as Record<string, unknown> | null
  return { missingTotal: count(result?.missing_total), forgotten: count(result?.forgotten) }
}

function count(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * The scan-complete flash.
 *
 * The forgotten count only appears when there is one: on a library nobody has
 * deleted from, a permanent "0 files forgotten" would be noise about a mechanism
 * the owner should not have to think about. It was reported only in the job's
 * result payload at first, which is to say nowhere (owner, 2026-08-24).
 */
export function scanCompleteMessage({ missingTotal, forgotten }: ScanOutcome): string {
  const missing =
    missingTotal === 1 ? '1 linked file is missing' : `${missingTotal} linked files are missing`
  if (forgotten === 0) return `Scan complete: ${missing}.`
  const dropped =
    forgotten === 1
      ? 'Forgot 1 unbundled file that is gone'
      : `Forgot ${forgotten} unbundled files that are gone`
  return `Scan complete: ${missing}. ${dropped}.`
}
