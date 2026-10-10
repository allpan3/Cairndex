import { usePersistentState } from '../state/usePersistentState'
import { getConnectionScopeKey } from '../api/requestScope'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { configureLibraryAccess } from '../api/client'
import { useLibraryAuth, useLibraryLock, useLibraryServing } from '../api/hooks'
import {
  controlRecovery,
  recoveryTask,
  recoveryTasks,
  startRecovery,
  type RecoveryRequest,
} from '../api/privateRecovery'
import { getActiveConnection } from '../desktop/connections'
import { isDesktopHost } from '../platform'

type RecoveryAction = Omit<RecoveryRequest, 'operation' | 'source' | 'after' | 'limit'> &
  Partial<Pick<RecoveryRequest, 'source' | 'after' | 'limit'>>

/** Access configuration and private recovery remain scoped to the selected server. */
export function LibraryPrivateControls({
  libraryId,
  released,
}: {
  libraryId: string
  released: boolean
}) {
  const auth = useLibraryAuth(libraryId)
  const lock = useLibraryLock(libraryId)
  const qc = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const local = !isDesktopHost() || getActiveConnection()?.kind === 'local'
  const configure = useMutation({
    mutationFn: (passphrase: string | null) =>
      configureLibraryAccess(libraryId, passphrase, current),
    onSuccess: (status) => {
      setCurrent('')
      setNext('')
      setConfirm('')
      qc.setQueryData(['auth-status', libraryId], status)
      void qc.invalidateQueries({ queryKey: ['auth-status', libraryId] })
    },
  })
  const error = auth.error ?? configure.error ?? lock.unlock.error ?? lock.lock.error
  if (auth.isPending) return <p role="status">Reading access settings…</p>
  if (!auth.data) return <p role="alert">{error?.message ?? 'Access settings are unavailable.'}</p>
  const locked = auth.data.protected && !auth.data.unlocked
  return (
    <section aria-label="Access and private backups" className="library-private">
      <h3>Access on this server</h3>
      <p>
        This passphrase protects access through this server. It does not encrypt files. Set
        protection separately on each server.
      </p>
      {locked ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            lock.unlock.mutate(current, { onSuccess: () => setCurrent('') })
          }}
        >
          {local ? (
            <>
              <label>
                Owner passphrase
                <input
                  className="edit"
                  type="password"
                  value={current}
                  onChange={(event) => setCurrent(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <button className="btn" disabled={!current || lock.unlock.isPending}>
                Unlock
              </button>
            </>
          ) : (
            <p>
              Pair this device in Settings. Unlock the library in the server's web app to approve
              pairing.
            </p>
          )}
        </form>
      ) : (
        <>
          {auth.data.access_settings_version === 1 ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                configure.mutate(next)
              }}
            >
              <p>
                {auth.data.protected
                  ? 'Passphrase protection is on.'
                  : 'Passphrase protection is off.'}{' '}
                Changing it revokes paired access for this library. Other servers keep their
                settings.
              </p>
              {auth.data.protected && (
                <label>
                  Current passphrase
                  <input
                    className="edit"
                    type="password"
                    value={current}
                    onChange={(event) => setCurrent(event.target.value)}
                    autoComplete="current-password"
                  />
                </label>
              )}
              <label>
                New passphrase
                <input
                  className="edit"
                  type="password"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <label>
                Confirm passphrase
                <input
                  className="edit"
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <button
                className="btn"
                disabled={
                  configure.isPending ||
                  !next ||
                  next !== confirm ||
                  (auth.data.protected && !current)
                }
              >
                {auth.data.protected ? 'Change passphrase' : 'Set passphrase'}
              </button>
              {auth.data.protected && (
                <>
                  <button
                    type="button"
                    className="btn"
                    disabled={configure.isPending || !current}
                    onClick={() => configure.mutate(null)}
                  >
                    Remove protection here
                  </button>
                  {local && (
                    <button type="button" className="btn" onClick={() => lock.lock.mutate()}>
                      Lock
                    </button>
                  )}
                </>
              )}
            </form>
          ) : (
            <p>Update this server to configure access here.</p>
          )}
          {auth.data.private_recovery_version === 1 ? (
            <PrivateBackups libraryId={libraryId} released={released} />
          ) : (
            <p>Update this server to use private backup controls.</p>
          )}
        </>
      )}
      {error && <p role="alert">{error.message}</p>}
    </section>
  )
}

/** Server tasks preserve exact identities; a late response cannot select another connection. */
function PrivateBackups({ libraryId, released }: { libraryId: string; released: boolean }) {
  const [after, setAfter] = useState('')
  const storage = `cairndex.privateRecovery:${getConnectionScopeKey() ?? 'web'}:${libraryId}`
  const [selected, setSelected] = usePersistentState(`${storage}:operation`, '')
  const [backup, setBackup] = usePersistentState(`${storage}:backup`, '')
  const [recovery, setRecovery] = usePersistentState(`${storage}:recovery`, '')
  const [review, setReview] = usePersistentState<{ receipt: string; state: string } | null>(
    `${storage}:review`,
    null,
  )
  const qc = useQueryClient()
  const serving = useLibraryServing(libraryId)
  const tasks = useQuery({
    queryKey: ['private-recovery', libraryId, after],
    queryFn: () => recoveryTasks(libraryId, after),
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  })
  const detail = useQuery({
    queryKey: ['private-recovery-task', libraryId, selected],
    queryFn: () => recoveryTask(libraryId, selected),
    enabled: !!selected,
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.state ?? '') ? 700 : false,
  })
  const start = useMutation({
    mutationFn: (body: RecoveryAction) =>
      startRecovery(libraryId, {
        source: 'prepared',
        after: '',
        limit: 20,
        ...body,
        operation: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      }),
    onSuccess: (result) => {
      setSelected(result.id)
      void qc.invalidateQueries({ queryKey: ['private-recovery', libraryId] })
    },
  })
  const control = useMutation({
    mutationFn: (action: 'stop' | 'retry') => controlRecovery(libraryId, selected, action),
    onSuccess: () => void detail.refetch(),
  })
  const result = detail.data?.result
  const rows = tasks.data?.items ?? []
  const running =
    start.isPending ||
    rows.some((row) => ['queued', 'running'].includes(row.state)) ||
    ['queued', 'running'].includes(detail.data?.state ?? '')
  const inventory = result?.inventory as
    { outbox?: number; tables?: Record<string, number>; author?: string } | undefined
  const items = result?.items as Record<string, unknown>[] | undefined
  const error = tasks.error ?? detail.error ?? start.error ?? control.error ?? serving.error
  const run = (body: RecoveryAction) => start.mutate(body)
  return (
    <section aria-label="Private backups">
      <h3>Private backups</h3>
      <p>
        A snapshot includes this server's received drafts, unpublished edits and saved operations.
        It is not a complete library backup.
      </p>
      <p>
        Back up source media, cloud-delivered metadata, credentials and server settings separately.
        Text held only in another or offline browser is not included. Keep that browser open until
        its drafts reach this server.
      </p>
      <button className="btn" disabled={running} onClick={() => run({ action: 'backup' })}>
        Create private snapshot
      </button>
      <p>
        Snapshots stay in this server's configured backup storage, outside the library. Keep another
        protected copy on separate storage.
      </p>
      <label>
        Saved operations
        <select
          className="edit"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value)
          }}
        >
          <option value="">Select an operation</option>
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.action} — {row.state} — {row.id.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn"
        onClick={() => {
          void tasks.refetch()
          if (selected) void detail.refetch()
        }}
      >
        Refresh operations
      </button>
      {after && (
        <button className="btn" onClick={() => setAfter('')}>
          First page
        </button>
      )}
      {tasks.data?.next_cursor && (
        <button className="btn" onClick={() => setAfter(tasks.data!.next_cursor!)}>
          More operations
        </button>
      )}
      {detail.data && (
        <div role="status">
          {detail.data.action}: {detail.data.state}
        </div>
      )}
      {detail.data?.error && <p role="alert">{detail.data.error}</p>}
      {detail.data?.state === 'queued' && (
        <button className="btn" onClick={() => control.mutate('stop')}>
          Cancel queued operation
        </button>
      )}
      {detail.data?.state === 'running' && (
        <p>The operation must finish before another can start. Original stores remain intact.</p>
      )}
      {['failed', 'interrupted'].includes(detail.data?.state ?? '') && (
        <button className="btn" disabled={running} onClick={() => control.mutate('retry')}>
          Retry exact operation
        </button>
      )}
      {inventory && (
        <p>
          Received drafts: {inventory.tables?.drafts ?? 0}. Unpublished events:{' '}
          {inventory.outbox ?? 0}. Saved jobs: {inventory.tables?.catalog_jobs ?? 0}.
        </p>
      )}
      {detail.data?.state === 'succeeded' && detail.data.action === 'backup' && (
        <>
          <button
            className="btn"
            disabled={running}
            onClick={() => run({ action: 'verify', backup: selected })}
          >
            Verify snapshot
          </button>
          <button
            className="btn"
            onClick={() => {
              setBackup(selected)
              setReview(null)
            }}
          >
            Use this snapshot
          </button>
        </>
      )}
      <h3>Recover on this server</h3>
      <p>
        Release the library before preparation. Review the separate recovery, then activate it.
        Original stores stay intact. Drafts are not submitted. Pending jobs need an exact-intent
        retry.
      </p>
      <p>
        {backup
          ? `Selected snapshot: ${backup.slice(0, 8)}`
          : 'No snapshot selected: only available shared metadata will be reconstructed.'}
      </p>
      {backup && (
        <button className="btn" onClick={() => setBackup('')}>
          Use shared metadata only
        </button>
      )}
      <button
        className="btn"
        disabled={running || serving.isPending}
        onClick={() => serving.mutate(released ? 'reopen' : 'release')}
      >
        {released ? 'Reopen library' : 'Release library'}
      </button>
      <button
        className="btn"
        disabled={!released || running}
        onClick={() => {
          setReview(null)
          run({ action: 'prepare', ...(backup ? { backup } : {}) })
        }}
      >
        Prepare separate recovery
      </button>
      {detail.data?.state === 'succeeded' && detail.data.action === 'prepare' && (
        <button
          className="btn"
          disabled={running}
          onClick={() => {
            setRecovery(selected)
            setReview(null)
            run({ action: 'review', recovery: selected })
          }}
        >
          Review this recovery
        </button>
      )}
      {result &&
        ['prepare', 'review', 'activate', 'cancel'].includes(detail.data?.action ?? '') && (
          <p>
            Recovery state: {String(result.state)}.
            {result.backup_only_events !== undefined &&
              ` Events found only in the snapshot: ${String(result.backup_only_events)}.`}
          </p>
        )}
      {Boolean(result?.previous_private_gaps) &&
        Object.values(result?.previous_private_gaps as Record<string, number>).some(
          (value) => value > 0,
        ) && (
          <p role="alert">
            The original store has newer private work. Make a new snapshot and prepare again.
          </p>
        )}
      {detail.data?.state === 'succeeded' &&
        detail.data.action === 'review' &&
        typeof result?.receipt === 'string' && (
          <button
            className="btn"
            onClick={() =>
              setReview({ receipt: result.receipt as string, state: String(result.state) })
            }
          >
            I reviewed this recovery
          </button>
        )}
      {recovery && (
        <>
          <div className="library-private__actions">
            {(['drafts', 'jobs', 'events', 'catalog'] as const).map((kind) => (
              <button
                className="btn"
                key={kind}
                disabled={running}
                onClick={() => run({ action: 'inspect', recovery, kind })}
              >
                Inspect {kind}
              </button>
            ))}
          </div>
          <button
            className="btn"
            disabled={!released || running || review?.state !== 'prepared'}
            onClick={() => run({ action: 'activate', recovery, receipt: review!.receipt })}
          >
            Activate reviewed recovery
          </button>
          <button
            className="btn"
            disabled={!released || running || !review || review.state === 'active'}
            onClick={() => run({ action: 'cancel', recovery, receipt: review!.receipt })}
          >
            Cancel reviewed recovery
          </button>
        </>
      )}
      {items && (
        <>
          <ul>
            {items.map((item, index) => (
              <li key={String(item.id ?? index)}>
                <pre className="library-private__record">{JSON.stringify(item, null, 2)}</pre>
                {typeof item.intent_receipt === 'string' && (
                  <button
                    className="btn"
                    disabled={!released || running}
                    onClick={() =>
                      run({
                        action: 'retry_job',
                        recovery,
                        job: String(item.id),
                        receipt: String(item.intent_receipt),
                      })
                    }
                  >
                    Retry this exact job
                  </button>
                )}
              </li>
            ))}
          </ul>
          {typeof result?.next_cursor === 'string' && (
            <button
              className="btn"
              disabled={running}
              onClick={() =>
                run({
                  action: 'inspect',
                  recovery,
                  kind: result.kind as RecoveryRequest['kind'],
                  source: result.source as RecoveryRequest['source'],
                  after: String(result.next_cursor),
                })
              }
            >
              More records
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error.message}</p>}
    </section>
  )
}
