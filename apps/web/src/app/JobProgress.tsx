import type { JobRead } from '../api/client'

// Human labels for the coarse backend job phases (domain.enums.JobPhase). Kept
// here (not from the API) so the copy stays product-facing and translatable.
const PHASE_LABELS: Record<string, string> = {
  discovering: 'Discovering files',
  reconciling: 'Reconciling moves',
  grouping: 'Preparing grouping suggestions',
  probing: 'Reading media metadata',
  thumbnailing: 'Generating thumbnails',
  finalizing: 'Finalizing',
}

const JOB_LABELS: Record<string, string> = {
  scan: 'Scan',
  probe: 'Collect metadata',
  thumbnail: 'Thumbnails',
}

function headline(job: JobRead): string {
  const phaseLabel = job.phase ? PHASE_LABELS[job.phase] : undefined
  if (phaseLabel) return phaseLabel
  if (job.message) return job.message
  return JOB_LABELS[job.job_type] ?? 'Working'
}

/**
 * Live progress for the active maintenance job. Determinate bar when ``total``
 * is known, indeterminate otherwise; shows the current phase/message and a
 * count. Errors are surfaced by the caller (mutation error) — this renders the
 * running/queued snapshot streamed from ``waitForJob``.
 */
export function JobProgress({ job }: { job: JobRead | null }) {
  if (job === null) return null

  const hasTotal = job.total !== null && job.total > 0
  const pct = hasTotal ? Math.min(100, Math.round((job.processed / job.total!) * 100)) : null

  return (
    <div className="job-progress" role="status" aria-live="polite">
      <div className="job-progress__row">
        <span className="job-progress__label">{headline(job)}</span>
        {hasTotal && (
          <span className="job-progress__count">
            {job.processed}/{job.total}
          </span>
        )}
      </div>
      <div
        className={`job-progress__track${pct === null ? ' job-progress__track--indeterminate' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div
          className="job-progress__bar"
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
