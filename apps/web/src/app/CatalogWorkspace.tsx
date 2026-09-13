// Shared bundle-first navigation and creation across every authored catalog family
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  advancedCatalogFields,
  catalog,
  entityLabel,
  FAMILIES,
  operationId,
  runJob,
  type Control,
  type Entity,
  type Job,
  type Page,
} from '../api/catalog'
import { holdEditor, replicaRequest, type ReplicaStatus } from '../api/replicas'
import type { LibraryRead } from '../api/client'
import { CatalogFilter } from './CatalogFilter'
import { CatalogJobs } from './CatalogJobs'
import { CatalogEditor } from './CatalogEditor'
import { CatalogFileBrowser } from './CatalogFileBrowser'
import { CatalogValue } from './CatalogControls'
import { useCatalogDraft } from './useCatalogDraft'
import { ReplicaViewer, type ReplicaOpen } from './viewer/ReplicaViewer'

// New identities are created from complete authored defaults and reviewed before saving
function CatalogCreate({
  library,
  family,
  editor,
  onDone,
}: {
  library: string
  family: string
  editor: string
  onDone: () => void
}) {
  const [instance] = useState(operationId)
  const template = useQuery({
    queryKey: ['catalog-create', library, family, instance],
    queryFn: () =>
      catalog<{ cells: Record<string, string>; controls: Control[] }>(
        library,
        `/creation/${family}`,
      ),
  })
  const draft = useCatalogDraft(library, `create/${family}`, editor, {
    cells: {} as Record<string, string>,
    operation: instance,
  })
  const cells = draft.body.cells
  // Keep all authored defaults, including the new identity, with the creation draft
  const setCells = (next: Record<string, string>) =>
    draft.update({ cells: { ...template.data?.cells, ...next }, operation: operationId() })
  const [prepared, setPrepared] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  // Review complete creation values before committing the prepared intent
  async function prepare() {
    setBusy(true)
    setError('')
    try {
      draft.update({
        cells: { ...template.data!.cells, ...cells },
        operation: draft.body.operation,
      })
      setPrepared(
        await runJob(
          library,
          'preview',
          { action: 'create', family, cells: { ...template.data!.cells, ...cells } },
          draft.body.operation,
        ),
      )
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // Stable commit identity survives retries and response loss
  async function commit() {
    if (!prepared) return
    setBusy(true)
    setError('')
    try {
      await runJob(
        library,
        'commit_preview',
        { job: prepared.id, receipt: prepared.receipt },
        `commit_${prepared.id}`,
      )
      await draft.discard()
      onDone()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Create catalog object">
      <h2>Create {FAMILIES[family]}</h2>
      {draft.error && <p role="alert">{draft.error}</p>}
      {draft.copies.map((copy) => (
        <button key={copy.id} onClick={() => draft.update(copy.body)}>
          Recover creation draft {copy.revision}
        </button>
      ))}
      {template.isPending && <p>Preparing complete metadata…</p>}
      {template.error && <p role="alert">{template.error.message}</p>}
      <label>
        <input
          type="checkbox"
          checked={advanced}
          onChange={(event) => setAdvanced(event.target.checked)}
        />
        Show identity, provenance and exact metadata
      </label>
      {template.data?.controls
        .filter((control) => advanced || !advancedCatalogFields.has(control.field))
        .map((control) => (
          <label key={control.field}>
            {control.label}
            {control.field === 'filter_json' ? (
              <CatalogFilter
                library={library}
                raw={cells[control.field] ?? template.data!.cells[control.field]!}
                onChange={(raw) => {
                  setCells({ ...cells, [control.field]: raw })
                  setPrepared(null)
                }}
              />
            ) : (
              <CatalogValue
                library={library}
                control={control}
                raw={cells[control.field] ?? template.data!.cells[control.field]!}
                onChange={(raw) => {
                  setCells({ ...cells, [control.field]: raw })
                  setPrepared(null)
                }}
              />
            )}
          </label>
        ))}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || !template.data} onClick={() => void prepare()}>
        Prepare creation
      </button>
      {prepared?.result && (
        <>
          <p>
            {prepared.result.changes.length} complete metadata values and relationships prepared.
          </p>
          <details>
            <summary>Review creation values</summary>
            {prepared.result.changes.map((change) => (
              <p key={change.unit}>
                <strong>{change.unit}</strong> {change.value}
              </p>
            ))}
          </details>
          <button disabled={busy} onClick={() => void commit()}>
            Create reviewed object
          </button>
        </>
      )}
      <button onClick={onDone}>Close creation</button>
    </section>
  )
}

// List and editor requests retain explicit library scope through navigation and retries
export function CatalogWorkspace({
  libraryId,
  libraries,
  onChangeLibrary,
  onManage,
}: {
  libraryId: string
  libraries: LibraryRead[]
  onChangeLibrary: (id: string) => void
  onManage: () => void
}) {
  const [editor, setEditor] = useState<string | null>(null)
  useEffect(() => holdEditor(setEditor), [])
  const [family, setFamily] = useState('asset_bundles')
  const [fileBrowser, setFileBrowser] = useState(false)
  const [showJobs, setShowJobs] = useState(false)
  const [media, setMedia] = useState<ReplicaOpen | null>(null)
  const [after, setAfter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)
  const [creating, setCreating] = useState(false)
  const status = useQuery({
    queryKey: ['catalog-status', libraryId],
    queryFn: () => replicaRequest<ReplicaStatus>(libraryId, '/status'),
    refetchInterval: 1000,
  })
  const page = useQuery({
    queryKey: ['catalog-page', libraryId, family, after, deleted],
    queryFn: () =>
      catalog<Page>(
        libraryId,
        `/entities/${family}?after=${encodeURIComponent(after)}&deleted=${deleted}`,
      ),
    refetchInterval: 2000,
  })
  const identity = selected ?? page.data?.items[0]?.id
  const detail = useQuery({
    queryKey: ['catalog-detail', libraryId, family, identity],
    enabled: Boolean(identity),
    queryFn: () => catalog<Entity>(libraryId, `/entities/${family}/${identity}`),
    refetchInterval: 2000,
  })
  // Refresh the selected projection after a durable local operation
  function refresh() {
    void page.refetch()
    void detail.refetch()
    void status.refetch()
  }
  const state = status.data
  return (
    <main className="replica-workspace catalog-workspace">
      <header>
        <div>
          <h1>Library catalog</h1>
          <p>Authored metadata · private drafts stay on this device</p>
        </div>
        <label>
          Library
          <select
            aria-label="Library"
            value={libraryId}
            onChange={(event) => onChangeLibrary(event.target.value)}
          >
            {libraries.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={onManage}>Manage libraries</button>
      </header>
      <section aria-label="Metadata delivery status">
        <p role="status">
          {state?.blocked
            ? 'Recovery or upgrade required'
            : !state?.ready
              ? 'Waiting for the complete library baseline'
              : state.outbox
                ? `${state.outbox} saved here · waiting to exchange`
                : 'Saved here · available metadata published'}
        </p>
        <p>Peer delivery unknown · {state?.waiting ?? 0} deliveries waiting</p>
        {(status.error || state?.exchange_error || state?.blocked) && (
          <p role="alert">{status.error?.message ?? state?.exchange_error ?? state?.blocked}</p>
        )}
        <button onClick={refresh}>Refresh catalog status</button>
      </section>
      {state?.media_version === 1 &&
        detail.data &&
        detail.data.fields.$alive?.value === 'true' &&
        ['asset_bundles', 'asset_files', 'moments', 'subtitle_tracks'].includes(family) && (
          <button
            onClick={() => {
              if (family === 'asset_bundles') setMedia({ bundleId: detail.data!.id })
              else if (family === 'asset_files') setMedia({ fileId: detail.data!.id })
              else {
                const field = detail.data!.fields[family === 'moments' ? '$span' : '$source']
                const value = JSON.parse(field?.value ?? '{}') as {
                  bundle_id: string
                  file_id?: string
                  video_file_id?: string
                  start_s?: number
                }
                setMedia({
                  bundleId: value.bundle_id,
                  fileId: value.file_id ?? value.video_file_id,
                  time: value.start_s,
                })
              }
            }}
          >
            Open media on this device
          </button>
        )}
      {media && (
        <ReplicaViewer
          key={`${libraryId}/${media.bundleId}/${media.fileId}/${media.time}`}
          library={libraryId}
          target={media}
          onClose={() => setMedia(null)}
        />
      )}
      <button onClick={() => setShowJobs(!showJobs)}>Saved operations</button>
      {showJobs && (
        <CatalogJobs
          key={libraryId}
          library={libraryId}
          blocked={!state?.ready || Boolean(state?.blocked)}
          onSaved={refresh}
        />
      )}
      <button onClick={() => setFileBrowser(!fileBrowser)}>File Browser</button>
      {fileBrowser && (
        <CatalogFileBrowser
          library={libraryId}
          onOpen={(id) => {
            setFamily('asset_files')
            setSelected(id)
            setFileBrowser(false)
          }}
        />
      )}
      <nav aria-label="Catalog families">
        {Object.entries(FAMILIES).map(([name, label]) => (
          <button
            key={name}
            aria-pressed={family === name}
            onClick={() => {
              setFamily(name)
              setAfter('')
              setSelected(null)
              setCreating(false)
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <label>
        <input
          type="checkbox"
          checked={deleted}
          onChange={(event) => setDeleted(event.target.checked)}
        />
        Include deleted objects and recovery history
      </label>
      <button disabled={!state?.ready || Boolean(state?.blocked)} onClick={() => setCreating(true)}>
        Create {FAMILIES[family]}
      </button>
      {['tags', 'collections'].includes(family) && (
        <button onClick={() => setSelected('_')}>Edit hierarchy and sibling order</button>
      )}
      {page.error && <p role="alert">{page.error.message}</p>}
      {page.isPending && <p>Loading catalog…</p>}
      <div className="replica-layout">
        <nav aria-label={FAMILIES[family]}>
          {page.data?.items.map((item) => (
            <button
              key={item.id}
              aria-pressed={identity === item.id}
              onClick={() => {
                setSelected(item.id)
                setCreating(false)
              }}
            >
              {entityLabel(item)}
              {item.has_conflicts ? ' · Review conflict' : ''}
            </button>
          ))}
          {page.data?.items.length === 0 && <p>No objects on this page.</p>}
          {page.data?.next_cursor && (
            <button
              onClick={() => {
                setAfter(page.data!.next_cursor!)
                setSelected(null)
              }}
            >
              Next objects
            </button>
          )}
          {after && (
            <button
              onClick={() => {
                setAfter('')
                setSelected(null)
              }}
            >
              First objects
            </button>
          )}
        </nav>
        {creating && editor ? (
          <CatalogCreate
            key={`${libraryId}/${family}/${editor}`}
            library={libraryId}
            family={family}
            editor={editor}
            onDone={() => {
              setCreating(false)
              refresh()
            }}
          />
        ) : detail.data && editor ? (
          <CatalogEditor
            key={`${libraryId}/${family}/${detail.data.id}/${editor}`}
            library={libraryId}
            entity={detail.data}
            editor={editor}
            blocked={!state?.ready || Boolean(state?.blocked)}
            refresh={refresh}
          />
        ) : (
          <p>Select an object to edit.</p>
        )}
      </div>
      {detail.error && <p role="alert">{detail.error.message}</p>}
    </main>
  )
}
