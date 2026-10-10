// Durable job receipts recover work even when a browser lost the original queue response
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, displayCell, runJob, type Job } from '../api/catalog'

const actions: Record<Job['action'], string> = {
  save: 'Save metadata',
  preview: 'Prepare operation',
  recover: 'Prepare recovery',
  commit_preview: 'Apply reviewed operation',
}

// Only explicitly opened jobs fetch large review payloads; the list stays paginated
export function CatalogJobs({
  library,
  blocked,
  onSaved,
}: {
  library: string
  blocked: boolean
  onSaved: () => void
}) {
  const [after, setAfter] = useState(0)
  const [selected, setSelected] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const page = useQuery({
    queryKey: ['catalog-jobs', library, after],
    queryFn: () =>
      catalog<{ items: Job[]; next_cursor: number | null }>(library, `/jobs?after=${after}`),
    refetchInterval: 2000,
  })
  // Reopening a receipt never executes or repeats the saved intent
  async function open(id: string) {
    try {
      setSelected(await catalog<Job>(library, `/jobs/${id}`))
    } catch (reason) {
      setError((reason as Error).message)
    }
  }
  // Only queued jobs can be cancelled, and completed authored events remain retained
  async function cancel(id: string) {
    try {
      await catalog(library, `/jobs/${id}`, 'DELETE')
      void page.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    }
  }
  // Stable commit identity makes a recovered preview safe to retry after response loss
  async function apply() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      await runJob(
        library,
        'commit_preview',
        { job: selected.id, receipt: selected.receipt },
        `commit_${selected.id}`,
      )
      setSelected(null)
      onSaved()
      void page.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Saved operations">
      <h2>Saved operations</h2>
      <p>Queued work and prepared reviews remain here after reload or restart.</p>
      {(error || page.error) && <p role="alert">{error || page.error?.message}</p>}
      {page.isPending && <p>Loading saved operations…</p>}
      {page.data?.items.length === 0 && <p>No operations yet.</p>}
      {page.data?.items.map((job) => (
        <div key={job.id}>
          <span>
            {actions[job.action]} · {job.state}
          </span>
          <button onClick={() => void open(job.id)}>Open operation {job.id.slice(0, 8)}</button>
          {job.state === 'queued' && (
            <button onClick={() => void cancel(job.id)}>Cancel queued operation</button>
          )}
        </div>
      ))}
      {page.data?.next_cursor && (
        <button onClick={() => setAfter(page.data!.next_cursor!)}>Older operations</button>
      )}
      {after > 0 && <button onClick={() => setAfter(0)}>Latest operations</button>}
      {selected && (
        <section aria-label="Recovered operation">
          <h3>
            {actions[selected.action]} · {selected.state}
          </h3>
          {selected.error && <p role="alert">{selected.error}</p>}
          {selected.result?.changes?.map((change) => (
            <div key={change.unit}>
              <strong>{change.unit}</strong>
              <p className="catalog-exact">{displayCell(change.value)}</p>
            </div>
          ))}
          {selected.result?.event && <p>Saved here</p>}
          {selected.state === 'succeeded' && ['preview', 'recover'].includes(selected.action) && (
            <button disabled={busy || blocked} onClick={() => void apply()}>
              Apply recovered review
            </button>
          )}
          <button onClick={() => setSelected(null)}>Close operation</button>
        </section>
      )}
    </section>
  )
}
