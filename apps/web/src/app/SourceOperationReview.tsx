import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import {
  sourceRequest,
  type SourceJob,
  type SourceRequest,
  type Version,
} from '../api/sourceOperations'

export function SourceOperationReview({
  library,
  operation,
  enabled,
  onPrepare,
}: {
  library: string
  operation: string
  enabled: boolean
  onPrepare: (request: SourceRequest) => void
}) {
  const cache = useQueryClient()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [recoveryPath, setRecoveryPath] = useState('')
  const job = useQuery({
    queryKey: ['source-operation', library, operation],
    queryFn: () => sourceRequest<SourceJob>(library, `/${operation}`),
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  })
  async function act(path: string, body?: unknown, method = 'POST') {
    setBusy(true)
    setError('')
    try {
      await sourceRequest(library, `/${operation}${path}`, method, body)
      await cache.invalidateQueries()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function collision(policy: SourceRequest['collision']) {
    if (!job.data) return
    onPrepare({ ...job.data.request, operation: operationId(), collision: policy })
  }
  const value = job.data
  const retained = value?.result?.retained_versions as Record<string, Version> | undefined
  useEffect(() => {
    if (value?.state === 'succeeded') void cache.invalidateQueries()
  }, [cache, value?.state])
  const reviewed = value?.review as {
    source?: string
    destination?: string
    skipped?: boolean
    versions_before?: Record<string, { evidence: { size: number } } | null>
  } | null
  return (
    <section aria-label="File operation review">
      {job.isPending && <p role="status">Loading operation review…</p>}
      {job.error && <p role="alert">{job.error.message}</p>}
      {value && (
        <>
          <h3>
            {value.action}: {value.state}
          </h3>
          <p>
            {value.request.source || 'Selected bytes'}
            {value.request.destination ? ` → ${value.request.destination}` : ''}
          </p>
          <p role="status">
            {value.phase} · {value.progress.toLocaleString()} bytes processed
          </p>
          {value.error && <p role="alert">{value.error}</p>}
          {value.error?.includes('Destination exists') && (
            <div className="modal__actions">
              <button disabled={busy || !enabled} onClick={() => void collision('replace')}>
                Replace
              </button>
              <button disabled={busy || !enabled} onClick={() => void collision('skip')}>
                Skip
              </button>
              <button disabled={busy || !enabled} onClick={() => void collision('suffix')}>
                Keep Both
              </button>
            </div>
          )}
          {value.state === 'prepared' && (
            <>
              <p>
                {reviewed?.skipped
                  ? 'Skip this item. Source files stay unchanged.'
                  : 'The review retains the current bytes and metadata conditions. Apply uses this exact review.'}
              </p>
              {reviewed?.destination && <p>Destination: {reviewed.destination}</p>}
              {Object.entries(reviewed?.versions_before ?? {})
                .filter(([, version]) => version)
                .map(([path, version]) => (
                  <p key={path}>
                    Recoverable version: {path} · {version!.evidence.size.toLocaleString()} bytes
                  </p>
                ))}
              <button
                className="btn btn--primary"
                disabled={busy || !enabled}
                onClick={() => void act('/accept', { receipt: value.receipt })}
              >
                Apply reviewed operation
              </button>
            </>
          )}
          {value.state === 'interrupted' && (
            <button disabled={busy || !enabled} onClick={() => void act('/retry')}>
              Retry exact operation
            </button>
          )}
          {['interrupted', 'cancelled'].includes(value.state) && retained && (
            <section aria-label="Interrupted operation recovery">
              <p>
                Completed versions remain available. A recovery copy leaves the interrupted
                operation and current paths in place.
              </p>
              <label>
                Interrupted recovery destination
                <input
                  value={recoveryPath}
                  onChange={(event) => setRecoveryPath(event.target.value)}
                />
              </label>
              {Object.entries(retained).map(([path, version]) => (
                <div key={version.version}>
                  <span>
                    {path || 'Uploaded version'} · {version.evidence.size.toLocaleString()}{' '}
                    bytes{' '}
                  </span>
                  <button
                    disabled={!enabled || busy || !recoveryPath}
                    onClick={() =>
                      onPrepare({
                        operation: operationId(),
                        action: 'restore',
                        prior: operation,
                        version: version.version,
                        destination: recoveryPath,
                        collision: 'suffix',
                      })
                    }
                  >
                    Recover retained copy
                  </button>
                </div>
              ))}
            </section>
          )}
          {(['queued', 'preparing', 'prepared', 'accepted'].includes(value.state) ||
            (value.state === 'applying' && !value.result?.started)) && (
            <button disabled={busy} onClick={() => void act('', undefined, 'DELETE')}>
              Cancel operation
            </button>
          )}
          {value.state === 'succeeded' && (
            <p>Saved here. Delivery to other copies is not confirmed.</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
