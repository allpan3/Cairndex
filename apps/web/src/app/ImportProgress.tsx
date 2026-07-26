import { formatBytes } from '../lib/format'

/**
 * The copy-in progress indicator, shared by the desktop drag-in and the web
 * "Add Files…" flow. Both import one file at a time, so this shows the current
 * file, its place in the batch ("2 of 5"), and — when byte progress is available
 * (the desktop path streams it) — a bar plus the transfer rate.
 */
export function ImportProgress({
  name,
  index,
  total,
  sent,
  size,
  rate,
}: {
  name: string
  index: number
  total: number
  sent?: number
  size?: number
  rate?: number
}) {
  const hasBytes = size !== undefined && size > 0 && sent !== undefined
  const percent = hasBytes ? Math.min(100, Math.round((sent / size) * 100)) : null

  return (
    <div className="import-progress" role="status" aria-live="polite">
      <div className="import-progress__head">
        <span className="import-progress__name" title={name}>
          Copying “{name}”
        </span>
        {total > 1 && (
          <span className="import-progress__count">
            {index} of {total}
          </span>
        )}
      </div>
      <div
        className={`import-progress__bar${percent === null ? ' import-progress__bar--indeterminate' : ''}`}
      >
        <div
          className="import-progress__fill"
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="import-progress__meta">
        {hasBytes ? `${formatBytes(sent)} / ${formatBytes(size)}` : 'Copying…'}
        {rate !== undefined && rate > 0 ? ` · ${formatBytes(rate)}/s` : ''}
      </div>
    </div>
  )
}
