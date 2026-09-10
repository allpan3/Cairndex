// Shared app entry for explicitly capable bundle metadata packages
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LibraryRead } from '../api/client'
import type { components } from '../api/schema'
import { holdEditor, replicaRequest, type ReplicaStatus } from '../api/replicas'
import { ReplicaEditor } from './ReplicaEditor'

// Keep library navigation available during incomplete delivery or recoverable storage errors
export function ReplicaWorkspace({
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
  const [cursor, setCursor] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [exchanging, setExchanging] = useState(false)
  const [error, setError] = useState('')
  const status = useQuery({
    queryKey: ['replica', libraryId, 'status'],
    queryFn: () => replicaRequest<ReplicaStatus>(libraryId, '/status'),
    refetchInterval: 2000,
  })
  const bundles = useQuery({
    queryKey: ['replica', libraryId, 'bundles', cursor],
    queryFn: () =>
      replicaRequest<components['schemas']['ReplicaBundlePage']>(
        libraryId,
        `/bundles?after=${cursor}`,
      ),
    refetchInterval: 2000,
  })
  const bundle = bundles.data?.items.find((item) => item.id === selected) ?? bundles.data?.items[0]
  const state = status.data
  const blocked = !state?.ready || Boolean(state?.blocked) || status.isError

  // Refresh only this replica's scoped read models after local edits
  function refresh() {
    void bundles.refetch()
    void status.refetch()
  }

  // A bounded retry reports storage failure without abandoning private work
  async function exchange() {
    setExchanging(true)
    setError('')
    try {
      await replicaRequest(libraryId, '/exchange', 'POST')
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setExchanging(false)
    }
  }

  return (
    <main className="replica-workspace">
      <header>
        <div>
          <h1>Bundle metadata</h1>
          <p>Titles, ordered notes and ratings · private drafts stay on this device</p>
        </div>
        <label>
          Library
          <select
            aria-label="Library"
            value={libraryId}
            onChange={(event) => onChangeLibrary(event.target.value)}
          >
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={onManage}>Manage libraries</button>
      </header>
      <section className="replica-status" aria-label="Metadata delivery status">
        {status.isPending && <p>Opening private metadata…</p>}
        {state && (
          <>
            <p role="status">
              {state.blocked
                ? 'Recovery or upgrade required'
                : !state.ready
                  ? 'Waiting for the complete library baseline'
                  : state.outbox
                    ? `${state.outbox} saved here · waiting to exchange`
                    : 'Saved here · available metadata published'}
            </p>
            <p>
              {state.waiting} deliveries waiting or unverified · {state.invalid} incompatible
              deliveries · Peer delivery unknown
            </p>
            {state.blocked && <p role="alert">{state.blocked}</p>}
            {state.exchange_error && <p role="alert">{state.exchange_error}</p>}
          </>
        )}
        {(status.error || error) && <p role="alert">{status.error?.message ?? error}</p>}
        <button disabled={exchanging} onClick={() => void exchange()}>
          {exchanging ? 'Checking…' : 'Exchange metadata'}
        </button>
      </section>
      {bundles.isPending && <p>Loading bundles…</p>}
      {bundles.error && <p role="alert">{bundles.error.message}</p>}
      {bundles.data?.items.length === 0 && (
        <p>
          {state?.ready
            ? 'No bundles on this page.'
            : 'Bundle metadata will appear when the baseline arrives.'}
        </p>
      )}
      <div className="replica-layout">
        <nav aria-label="Bundles">
          {bundles.data?.items.map((item) => (
            <button
              key={item.id}
              aria-pressed={item.id === bundle?.id}
              onClick={() => setSelected(item.id)}
            >
              {String(item.fields.title.value)}
            </button>
          ))}
          {bundles.data?.next_cursor && (
            <button
              onClick={() => {
                setCursor(bundles.data!.next_cursor!)
                setSelected(null)
              }}
            >
              Next bundles
            </button>
          )}
          {cursor && (
            <button
              onClick={() => {
                setCursor('')
                setSelected(null)
              }}
            >
              First bundles
            </button>
          )}
        </nav>
        {bundle && editor && (
          <ReplicaEditor
            key={bundle.id}
            libraryId={libraryId}
            bundle={bundle}
            editor={editor}
            blocked={blocked}
            refresh={refresh}
          />
        )}
      </div>
    </main>
  )
}
