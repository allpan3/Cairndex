import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  bulkActivity,
  cancelBulk,
  followBulk,
  runningBulk,
  subscribeBulkActivity,
} from '../api/catalogBulk'
import { captureRequestScope } from '../api/requestScope'
import { failureNotice } from './catalogBulkNotice'
import type { CatalogNotice } from './CatalogToast'

// Every view a bulk change can move
const AFFECTED = [
  'catalog-selection',
  'catalog-memberships',
  'catalog-bulk-memberships',
  'catalog-browse',
  'catalog-detail',
  'catalog-navigation',
  'catalog-view-counts',
  'catalog-tag-counts',
]

/**
 * The bulk change the server is applying: how far it is, and Cancel, which stops it
 * after the current batch. One started before a reload is picked up again here.
 */
export function CatalogBulkStatus({
  library,
  onNotice,
}: {
  library: string
  onNotice: (notice: CatalogNotice) => void
}) {
  const client = useQueryClient()
  const activity = useSyncExternalStore(subscribeBulkActivity, bulkActivity)
  useEffect(() => {
    const current = captureRequestScope()
    let stopped = false
    void runningBulk(library)
      .then((job) => {
        if (!job || stopped || bulkActivity()?.operation === job.id) return
        return followBulk(library, job)
          .then(() => !stopped && onNotice({ text: 'Bulk change finished.' }))
          .finally(() => {
            if (!stopped)
              for (const key of AFFECTED)
                void client.invalidateQueries({ queryKey: [key, library] })
          })
      })
      .catch((reason: Error) => {
        try {
          current()
        } catch {
          return
        }
        if (!stopped) onNotice(failureNotice(reason))
      })
    return () => {
      stopped = true
    }
  }, [library, client, onNotice])
  if (!activity || activity.library !== library) return null
  const done = activity.applied + activity.skipped
  return (
    <div className="mb-toast catalog-bulk-status" role="status">
      {activity.total
        ? `Changing ${activity.total.toLocaleString()} bundles: ${done.toLocaleString()} of ${activity.total.toLocaleString()}`
        : 'Changing the selected bundles…'}
      <button
        className="btn btn--sm mb-toast__action"
        onClick={() =>
          void cancelBulk(library, activity.operation).catch((reason: Error) =>
            onNotice(failureNotice(reason)),
          )
        }
      >
        Cancel
      </button>
    </div>
  )
}
