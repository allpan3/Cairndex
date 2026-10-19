import { useEffect } from 'react'
import type { useCatalogMaintenance } from './useCatalogMaintenance'

export function CatalogMaintenanceNotice({
  maintenance: m,
  onComplete,
}: {
  maintenance: ReturnType<typeof useCatalogMaintenance>
  onComplete: (text: string) => void
}) {
  const job = m.status.data?.job
  const progress = job?.result
  const label = m.status.data?.kind === 'storyboards' ? 'Storyboards' : 'Metadata'
  const { startedRef } = m
  useEffect(() => {
    if (!job || job.state !== 'succeeded' || job.id !== startedRef.current) return
    startedRef.current = null
    onComplete(
      `${label} complete · ${progress?.completed ?? 0} files checked · ${progress?.skipped ?? 0} skipped · ${progress?.failed ?? 0} failed`,
    )
  }, [job, label, onComplete, progress, startedRef])
  const error = m.error || m.status.error?.message || job?.error
  if (!m.active && !error && !['cancelled', 'failed'].includes(job?.state ?? '')) return null
  return (
    <section className="sidebar__job-progress" aria-label="Local media preparation">
      <div className="job-progress" role="status" aria-live="polite">
        <div className="job-progress__row">
          <span className="job-progress__label">
            {label} {m.active ? (progress ? 'preparation' : 'waiting…') : job?.state}
          </span>
          {m.active && progress && (
            <span className="job-progress__count">
              {progress.completed} / {progress.total}
            </span>
          )}
          {m.active && (
            <button
              className="job-progress__cancel"
              aria-label="Cancel local media preparation"
              disabled={m.busy}
              onClick={() => void m.cancel()}
            >
              ×
            </button>
          )}
        </div>
        {m.active && (
          <progress
            className="job-progress__bar"
            aria-label="Local media progress"
            {...(progress && progress.total > 0
              ? { max: progress.total, value: progress.completed }
              : {})}
          />
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
