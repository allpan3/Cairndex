import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import { isCollision } from './useSourceTasks'
import { ChangeName } from './SourceTaskProgress'
import { parentFolder, joinPath } from './sourceTasks'
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
  async function change(request: SourceRequest) {
    setBusy(true)
    setError('')
    try {
      await sourceRequest(library, `/${operation}`, 'DELETE')
      onPrepare({ ...request, operation: operationId() })
      await cache.invalidateQueries()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function collision(policy: SourceRequest['collision']) {
    if (job.data) void change({ ...job.data.request, collision: policy })
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
  if (value && ['cancelled', 'succeeded'].includes(value.state)) return null
  const collisionError = value && isCollision(value)
  return (
    <section aria-label="Stopped file operation">
      {job.isPending && <p role="status">Loading stopped operation…</p>}
      {job.error && <p role="alert">{job.error.message}</p>}
      {value && (
        <>
          <h3>
            {value.action === 'mkdir'
              ? 'Create folder'
              : value.action === 'copy'
                ? 'Copy'
                : value.action === 'rename'
                  ? 'Rename'
                  : 'File operation'}
            : {value.request.destination || value.request.source}
          </h3>
          {value.error && <p role="alert">{value.error}</p>}
          {collisionError && !value.result?.started && value.action !== 'mkdir' && (
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
          {collisionError && !value.result?.started && (
            <>
              <p>Nothing was replaced. Choose a different name or cancel this item.</p>
              <ChangeName
                disabled={busy || !enabled}
                name={(value.request.destination ?? '').split('/').at(-1) ?? ''}
                onChange={(name) => {
                  if (enabled && !busy)
                    void change({
                      ...value.request,
                      destination: joinPath(parentFolder(value.request.destination ?? ''), name),
                      collision: 'fail',
                    })
                }}
              />
            </>
          )}
          {value.state === 'prepared' && (
            <>
              <p>
                {reviewed?.skipped
                  ? 'Skip this item. Source files stay unchanged.'
                  : 'This item was paused before it changed files. Continue to finish it, or cancel.'}
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
                Continue
              </button>
            </>
          )}
          {value.state === 'interrupted' && (!collisionError || value.result?.started) && (
            <button disabled={busy || !enabled} onClick={() => void act('/retry')}>
              Try Again
            </button>
          )}
          {value.state === 'interrupted' && value.result?.started && retained && (
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
            (['applying', 'interrupted'].includes(value.state) && !value.result?.started)) && (
            <button disabled={busy} onClick={() => void act('', undefined, 'DELETE')}>
              Cancel item
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
