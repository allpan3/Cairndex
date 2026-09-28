import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FAMILIES, operationId } from '../api/catalog'
import { fetchWriteMode, type FileBrowserEntry } from '../api/client'
import { useWriteModeMutation } from '../api/hooks'
import {
  sourceRequest,
  uploadSource,
  type ReceiptPage,
  type SourceJob,
  type SourcePage,
  type SourceRequest,
} from '../api/sourceOperations'
import { SourceOperationReview } from './SourceOperationReview'
import { useCatalogDraft } from './useCatalogDraft'
import { useModalDialog } from './useModalDialog'

type Props = {
  library: string
  editor: string
  file: FileBrowserEntry | null
  directory: string
  onReviewEntity: (family: string, id: string) => void
}

function validInput(body: { request: string }) {
  if (!body.request) return true
  try {
    const request = JSON.parse(body.request) as SourceRequest
    return (
      request !== null &&
      typeof request === 'object' &&
      typeof request.operation === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(request.operation) &&
      ['copy', 'rename', 'move', 'trash', 'undo', 'restore'].includes(request.action) &&
      [request.source, request.destination].every(
        (path) => path === undefined || (typeof path === 'string' && path.length <= 4096),
      ) &&
      [request.prior, request.upload].every(
        (id) => id == null || (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)),
      ) &&
      (request.collision === undefined ||
        ['fail', 'skip', 'suffix', 'replace'].includes(request.collision)) &&
      (request.version === undefined ||
        ['source', 'destination', 'output'].includes(request.version)) &&
      (request.byte_limit === undefined ||
        (Number.isSafeInteger(request.byte_limit) &&
          request.byte_limit > 0 &&
          request.byte_limit <= 1024 ** 4))
    )
  } catch {
    return false
  }
}

export function SourceOperations(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="toolbar source-operation-toolbar" aria-label="File operations">
        <button className="btn" onClick={() => setOpen(true)}>
          Copy, Rename and Move
        </button>
        <button className="btn" onClick={() => setOpen(true)}>
          Trash and Undo
        </button>
      </div>
      {open && <SourceOperationPanel {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

function SourceOperationPanel({
  library,
  editor,
  file,
  directory,
  onReviewEntity,
  onClose,
}: Props & { onClose: () => void }) {
  const cache = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [after, setAfter] = useState(0)
  const [receiptAfter, setReceiptAfter] = useState('')
  const [error, setError] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [receiving, setReceiving] = useState('')
  const [recoveryPath, setRecoveryPath] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const uploadAbort = useRef<AbortController | null>(null)
  const { ref, close } = useModalDialog(onClose, busy)
  const draft = useCatalogDraft(library, 'source-operations', editor, { request: '' }, validInput)
  const writeMode = useQuery({
    queryKey: ['source-write-mode', library],
    queryFn: () => fetchWriteMode(library),
  })
  const permission = useWriteModeMutation()
  const enabled = Boolean(writeMode.data?.effective)
  const jobs = useQuery({
    queryKey: ['source-operations', library, after],
    queryFn: () => sourceRequest<SourcePage>(library, `?after=${after}`),
    refetchInterval: 1000,
    refetchIntervalInBackground: true,
  })
  const receipts = useQuery({
    queryKey: ['source-receipts', library, receiptAfter],
    queryFn: () =>
      sourceRequest<ReceiptPage>(library, `/receipts?after=${encodeURIComponent(receiptAfter)}`),
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
  })
  useEffect(() => () => uploadAbort.current?.abort(), [])

  function saveRequest(request: SourceRequest) {
    draft.update({ request: JSON.stringify(request) })
  }
  async function setPermission(next: boolean) {
    setError('')
    try {
      await permission.mutateAsync({
        libraryId: library,
        enabled: next,
        passphrase: passphrase || undefined,
      })
      setPassphrase('')
      await writeMode.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    }
  }
  function start(action: SourceRequest['action']) {
    if (!file) return
    saveRequest({
      operation: operationId(),
      action,
      source: file.relative_path,
      destination: action === 'trash' ? '' : file.relative_path,
      collision: 'fail',
    })
    setSelected(null)
  }
  function changeDestination(value: string) {
    if (!pending) return
    saveRequest({ ...pending, destination: value, operation: operationId() })
  }
  async function queue(request: SourceRequest) {
    saveRequest(request)
    setBusy(true)
    setError('')
    try {
      const queued = await sourceRequest<SourceJob>(library, '', 'POST', request)
      setSelected(queued.id)
      await draft.discard()
      await cache.invalidateQueries({ queryKey: ['source-operations', library] })
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function copyFiles(files: File[]) {
    const controller = new AbortController()
    uploadAbort.current = controller
    setBusy(true)
    setError('')
    try {
      for (const incoming of files) {
        if (controller.signal.aborted) break
        const request: SourceRequest =
          pending?.upload && files.length === 1
            ? pending
            : {
                operation: operationId(),
                action: 'copy',
                upload: operationId(),
                destination: `${directory ? directory + '/' : ''}${incoming.name}`,
                collision: 'fail',
              }
        saveRequest(request)
        setReceiving(incoming.name)
        await uploadSource(library, request.upload!, incoming, controller.signal)
        const queued = await sourceRequest<SourceJob>(library, '', 'POST', request)
        setSelected(queued.id)
        await draft.discard()
      }
      await cache.invalidateQueries({ queryKey: ['source-operations', library] })
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
      setReceiving('')
      uploadAbort.current = null
    }
  }
  const pending: SourceRequest | null = draft.body.request
    ? (JSON.parse(draft.body.request) as SourceRequest)
    : null
  const undone = new Set(receipts.data?.items.map((item) => item.receipt?.undo_of).filter(Boolean))
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="File operations and recovery"
        className="modal source-operation-panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2>File operations and recovery</h2>
          <button className="btn" disabled={busy} onClick={close}>
            Close
          </button>
        </div>
        {writeMode.error && <p role="alert">{writeMode.error.message}</p>}
        <p>
          {enabled
            ? 'File operations are on for this library on this server.'
            : 'File operations are off. Browsing does not change source files.'}
        </p>
        {!enabled && writeMode.data?.requires_passphrase && (
          <label>
            Library passphrase
            <input
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>
        )}
        <button
          className="btn"
          disabled={
            permission.isPending ||
            busy ||
            !writeMode.data ||
            (!enabled && !writeMode.data.allowed_by_deployment)
          }
          onClick={() => void setPermission(!enabled)}
        >
          {enabled ? 'Disable file operations' : 'Enable file operations'}
        </button>
        {writeMode.data && !writeMode.data.allowed_by_deployment && (
          <p>This server does not permit source writes.</p>
        )}
        <div className="source-operation-actions">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              void copyFiles(files)
            }}
          />
          <button
            className="btn"
            disabled={!enabled || busy}
            onClick={() => picker.current?.click()}
          >
            Copy files…
          </button>
          {(['copy', 'rename', 'move', 'trash'] as const).map((action) => (
            <button
              key={action}
              className="btn"
              disabled={!enabled || busy || !file}
              onClick={() => start(action)}
            >
              {action === 'copy'
                ? file?.kind === 'directory'
                  ? 'Copy selected folder'
                  : 'Copy selected file'
                : action === 'trash'
                  ? 'Move to Trash'
                  : action[0]!.toUpperCase() + action.slice(1)}
            </button>
          ))}
        </div>
        {file && <p>Selected: {file.relative_path}</p>}
        {receiving && (
          <p role="status">
            Receiving {receiving}. The original file stays in place.{' '}
            <button onClick={() => uploadAbort.current?.abort()}>Cancel upload</button>
          </p>
        )}
        {draft.error && <p role="alert">{draft.error}</p>}
        {draft.copies.map((copy) => (
          <button key={copy.id} onClick={() => draft.update(copy.body)}>
            Recover saved file operation
          </button>
        ))}
        {pending && (
          <section aria-label="Prepare file operation">
            <h3>{pending.action === 'trash' ? 'Move to Trash' : pending.action}</h3>
            <p>{pending.source || 'Selected recovery or uploaded bytes'}</p>
            {pending.action !== 'trash' && pending.action !== 'undo' && (
              <label>
                Destination path
                <input
                  value={pending.destination ?? ''}
                  onChange={(event) => changeDestination(event.target.value)}
                  placeholder="Folder/name.ext"
                />
              </label>
            )}
            <p>
              Paths are relative to this library. Files changed since review will stop the
              operation.
            </p>
            <label>
              Operation storage limit (GiB)
              <input
                type="number"
                min="1"
                max="1024"
                step="1"
                value={(pending.byte_limit ?? 128 * 1024 ** 3) / 1024 ** 3}
                onChange={(event) =>
                  saveRequest({
                    ...pending,
                    operation: operationId(),
                    byte_limit: Math.max(1, Math.min(1024, Number(event.target.value))) * 1024 ** 3,
                  })
                }
              />
            </label>
            <p>The limit includes recovery versions and working copies.</p>
            <button
              className="btn btn--primary"
              disabled={busy || !enabled}
              onClick={() => void queue(pending)}
            >
              Prepare operation
            </button>
            <button className="btn" disabled={busy} onClick={() => void draft.discard()}>
              Discard input
            </button>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        {selected && (
          <SourceOperationReview
            key={selected}
            library={library}
            operation={selected}
            enabled={enabled}
            onPrepare={saveRequest}
          />
        )}
        <section aria-label="Saved file operations">
          <h3>Saved file operations</h3>
          {jobs.isPending && <p role="status">Loading saved operations…</p>}
          {jobs.data?.items.length === 0 && <p>No saved operations on this server.</p>}
          {jobs.error && <p role="alert">{jobs.error.message}</p>}
          {jobs.data?.items.map((item) => (
            <button className="nav-item" key={item.id} onClick={() => setSelected(item.id)}>
              {item.action} ·{' '}
              {item.request.destination ||
                item.request.source ||
                receipts.data?.items.find((receipt) => receipt.id === item.request.prior)?.receipt
                  ?.source ||
                'Retained version'}{' '}
              · {item.state}
            </button>
          ))}
          {after > 0 && <button onClick={() => setAfter(0)}>Newest operations</button>}
          {jobs.data?.next_cursor && (
            <button onClick={() => setAfter(jobs.data!.next_cursor!)}>Older operations</button>
          )}
        </section>
        <section aria-label="Trash and retained versions">
          <h3>Trash and retained versions</h3>
          <p>
            Completed versions stay available without automatic deletion. Undo checks current files
            and metadata. A changed or occupied path requires review.
          </p>
          <label>
            Recovery copy destination
            <input
              value={recoveryPath}
              onChange={(event) => setRecoveryPath(event.target.value)}
              placeholder="Recovered/name.ext"
            />
          </label>
          {receipts.error && <p role="alert">{receipts.error.message}</p>}
          {receipts.isPending && <p role="status">Loading retained versions…</p>}
          {receipts.data?.items.length === 0 && <p>No completed retained versions.</p>}
          {receipts.data?.items.map((item) => (
            <div key={item.id} className="source-receipt">
              {item.error && <p role="alert">{item.error}</p>}
              {item.receipt && (
                <>
                  <p>
                    {item.receipt.action} · {item.receipt.destination || item.receipt.source}
                  </p>
                  {!!item.receipt.metadata?.changes.some(
                    (change) => change.unit.endsWith('/$alive') && change.value === 'false',
                  ) && (
                    <details>
                      <summary>Retained metadata</summary>
                      <p>
                        Review retained identity and references. Metadata review does not restore
                        file bytes.
                      </p>
                      {item.receipt.metadata.changes
                        .filter(
                          (change) => change.unit.endsWith('/$alive') && change.value === 'false',
                        )
                        .map((change) => {
                          const [family, identity] = change.unit.split('/')
                          return (
                            <button
                              key={change.unit}
                              onClick={() => {
                                onClose()
                                onReviewEntity(family!, identity!)
                              }}
                            >
                              Review {FAMILIES[family!] ?? family} metadata
                            </button>
                          )
                        })}
                    </details>
                  )}
                  <button
                    disabled={!enabled || busy || item.state === 'pending' || undone.has(item.id)}
                    onClick={() =>
                      void queue({ operation: operationId(), action: 'undo', prior: item.id })
                    }
                  >
                    Undo {item.receipt.action === 'undo' ? 'recovery' : item.receipt.action}
                  </button>
                  {Object.entries(item.receipt.versions_before)
                    .filter(([, value]) => value)
                    .map(([path, value]) => (
                      <div key={path}>
                        <span>
                          {path} · {value!.evidence.size.toLocaleString()} bytes{' '}
                        </span>
                        <button
                          disabled={!enabled || busy || !recoveryPath || item.state === 'pending'}
                          onClick={() =>
                            void queue({
                              operation: operationId(),
                              action: 'restore',
                              prior: item.id,
                              version: value!.version,
                              destination: recoveryPath,
                              collision: 'suffix',
                            })
                          }
                        >
                          Restore copy
                        </button>
                      </div>
                    ))}
                  {item.state === 'pending' && (
                    <p>
                      Waiting for the complete metadata receipt. Source files can arrive separately.
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
          {receiptAfter && <button onClick={() => setReceiptAfter('')}>First versions</button>}
          {receipts.data?.next_cursor && (
            <button onClick={() => setReceiptAfter(receipts.data!.next_cursor!)}>
              More versions
            </button>
          )}
        </section>
      </div>
    </div>
  )
}
