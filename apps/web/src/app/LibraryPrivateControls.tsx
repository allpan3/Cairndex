import { usePersistentState } from '../state/usePersistentState'
import { getConnectionScopeKey } from '../api/requestScope'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { configureLibraryAccess, type LibraryRead } from '../api/client'
import {
  useLibraryAuth,
  useLibraryLock,
  useLibraryOwnership,
  useLibraryServing,
} from '../api/hooks'
import {
  controlRecovery,
  recoveryTask,
  recoveryTasks,
  startRecovery,
  type RecoveryRequest,
} from '../api/privateRecovery'
import { getActiveConnection } from '../desktop/connections'
import { isDesktopHost } from '../platform'
import { InfoTip } from './InfoTip'
import { useModalDialog } from './useModalDialog'

type RecoveryAction = Omit<RecoveryRequest, 'operation' | 'source' | 'after' | 'limit'> &
  Partial<Pick<RecoveryRequest, 'source' | 'after' | 'limit'>>

/**
 * One library's settings on this server, opened from its row in the Libraries
 * dialog and shown over it.
 *
 * Its own dialog rather than a panel in the list: the list scrolls in a short
 * box, and these controls need the window's height. The dialog is bounded by
 * the window and scrolls its body, so the title and Back stay in view. Escape,
 * Back and a click outside all return to the Libraries list.
 */
export function LibrarySettingsDialog({
  library,
  onClose,
}: {
  library: LibraryRead
  onClose: () => void
}) {
  const titleId = useId()
  const ownership = useLibraryOwnership(library.id)
  const released = ownership.data?.state === 'locally_released'
  const { ref, close } = useModalDialog(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        className="modal library-settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id={titleId}>{library.name} settings</h2>
          <button
            className="modal__close"
            onClick={close}
            aria-label="Back to libraries"
            title="Back to libraries"
          >
            ×
          </button>
        </div>
        <div className="library-settings__body">
          <LibraryPrivateControls libraryId={library.id} released={released} />
        </div>
      </div>
    </div>
  )
}

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
  const accessId = useId()
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
  if (!auth.data)
    return (
      <div className="library-private">
        <p role="alert">{error?.message ?? 'Access settings are unavailable.'}</p>
        <div className="library-private__actions">
          <button className="btn" disabled={auth.isFetching} onClick={() => void auth.refetch()}>
            {auth.isFetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    )
  const locked = auth.data.protected && !auth.data.unlocked
  return (
    <div className="library-private">
      <section className="library-private__section" aria-labelledby={accessId}>
        <div className="library-private__title">
          <h3 id={accessId}>Access on this server</h3>
          <InfoTip label="About access on this server">
            The passphrase protects access through this server. It does not encrypt files. Each
            server keeps its own setting.
          </InfoTip>
        </div>
        {locked ? (
          local ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                lock.unlock.mutate(current, { onSuccess: () => setCurrent('') })
              }}
            >
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
              <div className="library-private__actions">
                <button className="btn" disabled={!current || lock.unlock.isPending}>
                  Unlock
                </button>
              </div>
            </form>
          ) : (
            <p>Locked. Pair this device in Settings, then approve it in the server's web app.</p>
          )
        ) : auth.data.access_settings_version === 1 ? (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              configure.mutate(next)
            }}
          >
            {/* Changing it revokes paired access before it is stored (ADR-0035) */}
            <p>
              {auth.data.protected
                ? 'Passphrase protection is on.'
                : 'Passphrase protection is off.'}{' '}
              Changing it revokes paired access.
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
            <div className="library-private__actions">
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
            </div>
          </form>
        ) : (
          <p>Update this server to configure access here.</p>
        )}
        {error && <p role="alert">{error.message}</p>}
      </section>
      {!locked &&
        (auth.data.private_recovery_version === 1 ? (
          <PrivateBackups libraryId={libraryId} released={released} />
        ) : (
          <p>Update this server to use private backup controls.</p>
        ))}
    </div>
  )
}

/** Server tasks preserve exact identities; a late response cannot select another connection. */
function PrivateBackups({ libraryId, released }: { libraryId: string; released: boolean }) {
  const backupsId = useId()
  const recoveryId = useId()
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
    <>
      <section className="library-private__section" aria-labelledby={backupsId}>
        <div className="library-private__title">
          <h3 id={backupsId}>Private backups</h3>
          <InfoTip label="About private backups">
            A snapshot holds this server's received drafts, unpublished edits and saved operations.
            It stays in this server's backup storage, outside the library; keep another protected
            copy on separate storage. Back up source media, cloud-delivered metadata, credentials
            and server settings separately. Drafts held only in another or offline browser are not
            included, so keep that browser open until they reach this server.
          </InfoTip>
        </div>
        <p>Not a complete library backup.</p>
        <div className="library-private__actions">
          <button className="btn" disabled={running} onClick={() => run({ action: 'backup' })}>
            Create private snapshot
          </button>
        </div>
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
        <div className="library-private__actions">
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
        </div>
        {detail.data && (
          <div role="status">
            {detail.data.action}: {detail.data.state}
          </div>
        )}
        {detail.data?.error && <p role="alert">{detail.data.error}</p>}
        {detail.data?.state === 'queued' && (
          <div className="library-private__actions">
            <button className="btn" onClick={() => control.mutate('stop')}>
              Cancel queued operation
            </button>
          </div>
        )}
        {detail.data?.state === 'running' && (
          <p>Another operation can start when this one finishes. Original stores stay intact.</p>
        )}
        {['failed', 'interrupted'].includes(detail.data?.state ?? '') && (
          <div className="library-private__actions">
            <button className="btn" disabled={running} onClick={() => control.mutate('retry')}>
              Retry exact operation
            </button>
          </div>
        )}
        {inventory && (
          <p>
            Received drafts: {inventory.tables?.drafts ?? 0}. Unpublished events:{' '}
            {inventory.outbox ?? 0}. Saved jobs: {inventory.tables?.catalog_jobs ?? 0}.
          </p>
        )}
        {detail.data?.state === 'succeeded' && detail.data.action === 'backup' && (
          <div className="library-private__actions">
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
          </div>
        )}
      </section>
      <section className="library-private__section" aria-labelledby={recoveryId}>
        <div className="library-private__title">
          <h3 id={recoveryId}>Recover on this server</h3>
          <InfoTip label="About recovery">
            Preparation builds a separate recovery from the selected snapshot, or from shared
            metadata alone. Review it, then activate it. Original stores stay intact. Drafts are not
            submitted. Pending jobs need an exact-intent retry.
          </InfoTip>
        </div>
        {/* The gate on Prepare, said where the disabled button is */}
        {!released && <p>Release the library before you prepare a recovery.</p>}
        <p>
          {backup
            ? `Selected snapshot: ${backup.slice(0, 8)}`
            : 'No snapshot selected. Recovery uses shared metadata only.'}
        </p>
        <div className="library-private__actions">
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
        </div>
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
            <div className="library-private__actions">
              <button
                className="btn"
                onClick={() =>
                  setReview({ receipt: result.receipt as string, state: String(result.state) })
                }
              >
                I reviewed this recovery
              </button>
            </div>
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
            <div className="library-private__actions">
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
            </div>
          </>
        )}
        {items && (
          <>
            <ul className="library-private__records">
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
              <div className="library-private__actions">
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
              </div>
            )}
          </>
        )}
        {error && <p role="alert">{error.message}</p>}
      </section>
    </>
  )
}
