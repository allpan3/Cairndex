import type { JobRead } from '../api/client'

// Human labels for the coarse backend job phases (domain.enums.JobPhase). Kept
// here (not from the API) so the copy stays product-facing and translatable.
const PHASE_LABELS: Record<string, string> = {
  discovering: 'Discovering files',
  reconciling: 'Reconciling moves',
  grouping: 'Preparing grouping suggestions',
  probing: 'Reading media metadata',
  thumbnailing: 'Generating thumbnails',
  storyboarding: 'Generating storyboards',
  finalizing: 'Finalizing',
}

const JOB_LABELS: Record<string, string> = {
  scan: 'Scan',
  probe: 'Collect metadata',
  thumbnail: 'Thumbnails',
  storyboard: 'Storyboards',
}

function jobLabel(job: JobRead): string {
  return JOB_LABELS[job.job_type] ?? 'Job'
}

function headline(job: JobRead): string {
  if (job.status === 'failed') return `${jobLabel(job)} failed`
  if (job.status === 'cancelled') return `${jobLabel(job)} cancelled`
  // Both of these outrank the phase label, which describes the work rather than
  // what is happening to it. A queued job carries no phase anyway — it used to
  // fall through to the job name beside a *moving* bar, which is how waiting
  // came to look exactly like running.
  if (job.cancel_requested) return `Stopping ${jobLabel(job).toLowerCase()}…`
  if (job.status === 'queued') return `${jobLabel(job)} — waiting`
  // A message beats the phase label when the server sent one: it is more
  // specific by construction, and a phase can cover several steps (grouping
  // matches filenames, then writes the suggestions). `set_phase` clears the
  // message when it is not given, so this can never show a stale one.
  if (job.message) return job.message
  const phaseLabel = job.phase ? PHASE_LABELS[job.phase] : undefined
  if (phaseLabel) return phaseLabel
  return JOB_LABELS[job.job_type] ?? 'Working'
}

/**
 * Live progress for the active maintenance job. Determinate bar when ``total``
 * is known, indeterminate otherwise; shows the current phase/message and a
 * count. Terminal job failures can stay visible when a caller runs a job in the
 * background instead of failing its own mutation.
 */
export function JobProgress({
  job,
  onCancel,
}: {
  job: JobRead | null
  onCancel?: (jobId: string) => void
}) {
  if (job === null) return null

  const hasTotal = job.total !== null && job.total > 0
  const pct = hasTotal ? Math.min(100, Math.round((job.processed / job.total!) * 100)) : null
  const waiting = job.status === 'queued'
  const stoppable =
    onCancel !== undefined && !job.cancel_requested && (waiting || job.status === 'running')
  // A queued job is not working, so its bar does not move. Only a running job
  // with no count of its own gets the indeterminate animation.
  const indeterminate = pct === null && !waiting

  return (
    <div className="job-progress" role="status" aria-live="polite">
      <div className="job-progress__row">
        <span className="job-progress__label">{headline(job)}</span>
        {hasTotal && (
          <span className="job-progress__count">
            {job.processed}/{job.total}
          </span>
        )}
        {stoppable && (
          <button
            type="button"
            className="job-progress__cancel"
            onClick={() => onCancel(job.id)}
            title={`Stop ${jobLabel(job).toLowerCase()}`}
            aria-label={`Stop ${jobLabel(job).toLowerCase()}`}
          >
            ×
          </button>
        )}
      </div>
      <div
        className={`job-progress__track${indeterminate ? ' job-progress__track--indeterminate' : ''}${
          waiting ? ' job-progress__track--waiting' : ''
        }${
          job.status === 'failed' || job.status === 'cancelled' ? ' job-progress__track--error' : ''
        }`}
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
      {job.error && <div className="job-progress__error">{job.error}</div>}
    </div>
  )
}
