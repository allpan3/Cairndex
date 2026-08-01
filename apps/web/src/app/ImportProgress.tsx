import { formatBytes } from '../lib/format'
import type { ImportActivity } from './importActivity'

/** A stoppable client import row with the same states as a background job */
export function ImportProgress({
  activity,
  onCancel,
}: {
  activity: ImportActivity
  onCancel?: (batchId: string) => void
}) {
  const { id, name, index, total, status, sent, size, rate } = activity
  const hasBytes = size !== undefined && size > 0 && sent !== undefined
  const percent = hasBytes ? Math.min(100, Math.round((sent / size) * 100)) : null
  const waiting = status === 'waiting'
  const stopping = status === 'stopping'
  const indeterminate = percent === null && !waiting && !stopping
  const headline = stopping
    ? 'Stopping import…'
    : waiting
      ? 'Import — waiting'
      : `Importing “${name}”`

  return (
    <div className="job-progress import-progress" role="status" aria-live="polite">
      <div className="job-progress__row">
        <span className="job-progress__label" title={headline}>
          {headline}
        </span>
        <span className="job-progress__count">
          {index}/{total}
        </span>
        {onCancel && (
          <button
            type="button"
            className="job-progress__cancel"
            onClick={() => onCancel(id)}
            title="Stop import"
            aria-label="Stop import"
            disabled={stopping}
          >
            ×
          </button>
        )}
      </div>
      {(waiting || stopping) && (
        <div className="import-progress__name" title={name}>
          {name}
        </div>
      )}
      <div
        className={`job-progress__track${indeterminate ? ' job-progress__track--indeterminate' : ''}${
          waiting ? ' job-progress__track--waiting' : ''
        }`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className="job-progress__bar"
          style={
            percent === null
              ? indeterminate
                ? undefined
                : { width: '0%' }
              : { width: `${percent}%` }
          }
        />
      </div>
      {hasBytes && (
        <div className="import-progress__meta">
          {formatBytes(sent)} / {formatBytes(size)}
          {rate !== undefined && rate > 0 ? ` · ${formatBytes(rate)}/s` : ''}
        </div>
      )}
    </div>
  )
}
