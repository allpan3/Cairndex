import { useState } from 'react'

import type { ImportPlanRead, ImportResultRead } from '../api/client'
import { useEagleImport } from '../api/hooks'

/**
 * Import-from-Eagle dialog. Always dry-runs first: the user enters a `.library`
 * path, previews what the import would do (counts + merge hints), then commits.
 * The import is idempotent server-side, so re-running is safe (AGENTS.md §7).
 */
export function EagleImport({ onClose }: { onClose: () => void }) {
  const { preview, run } = useEagleImport()
  const [path, setPath] = useState('')
  const [plan, setPlan] = useState<ImportPlanRead | null>(null)
  const [result, setResult] = useState<ImportResultRead | null>(null)

  const doPreview = () => {
    setResult(null)
    preview.mutate(path.trim(), { onSuccess: setPlan })
  }
  const doImport = () => {
    run.mutate(path.trim(), {
      onSuccess: (r) => {
        setResult(r)
        setPlan(null)
      },
    })
  }

  const error = preview.error ?? run.error
  const busy = preview.isPending || run.isPending

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>Import from Eagle</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label className="field-label">Eagle library path</label>
        <input
          className="edit"
          value={path}
          placeholder="/path/to/My.library"
          onChange={(e) => {
            setPath(e.target.value)
            setPlan(null)
            setResult(null)
          }}
          aria-label="Eagle library path"
          autoFocus
        />

        {plan && (
          <div className="import-report">
            <div className="import-report__grid">
              <Stat label="New bundles" value={plan.new_bundles} />
              <Stat label="Already imported" value={plan.skipped_existing} />
              <Stat label="Deleted (skipped)" value={plan.skipped_deleted} />
              <Stat label="Collections" value={plan.folders} />
              <Stat label="Tags" value={plan.tags} />
              <Stat label="Tag groups" value={plan.tag_groups} />
            </div>
            {plan.merge_suggestions.length > 0 && (
              <div className="import-report__hint">
                {plan.merge_suggestions.length} merge suggestion
                {plan.merge_suggestions.length === 1 ? '' : 's'} (review after import)
              </div>
            )}
            {plan.warnings.length > 0 && (
              <div className="import-report__warn">{plan.warnings.length} warning(s)</div>
            )}
          </div>
        )}

        {result && (
          <div className="import-report import-report--done" role="status">
            Imported {result.bundles_created} bundle{result.bundles_created === 1 ? '' : 's'} (
            {result.collections_created} collections, {result.tags_created} tags). {result.skipped}{' '}
            skipped.
          </div>
        )}

        {error && <div className="modal__error">{(error as Error).message}</div>}

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          {plan ? (
            <button className="btn btn--primary" onClick={doImport} disabled={busy || !path.trim()}>
              Import {plan.new_bundles} bundle{plan.new_bundles === 1 ? '' : 's'}
            </button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={doPreview}
              disabled={busy || !path.trim()}
            >
              Preview
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="import-stat">
      <div className="import-stat__v">{value.toLocaleString()}</div>
      <div className="import-stat__k">{label}</div>
    </div>
  )
}
