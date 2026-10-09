// Explicit content verification retains its operation independently of grouping text and choices
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import { discovery, type DiscoveryVerification as Verification } from '../api/discovery'
import { useCatalogDraft } from './useCatalogDraft'

// Full reads stay asynchronous and cancellable while the owner edits the grouping decision
export function DiscoveryVerification({
  library,
  editor,
  candidate,
  onVerified,
}: {
  library: string
  editor: string
  candidate: string
  onVerified: (operation: string | null) => void
}) {
  const draft = useCatalogDraft(library, `verify/${candidate}`, editor, { operation: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const job = useQuery({
    queryKey: ['discovery-verification', library, draft.body.operation],
    enabled: Boolean(draft.body.operation),
    queryFn: () => discovery<Verification>(library, `/verifications/${draft.body.operation}`),
    refetchInterval: 500,
  })
  useEffect(() => {
    onVerified(job.data?.state === 'succeeded' ? job.data.id : null)
  }, [job.data?.id, job.data?.state, onVerified])

  // Persist the request identity first so an interrupted response remains retryable
  async function start() {
    const operation = draft.body.operation || operationId()
    draft.update({ operation })
    setBusy(true)
    setError('')
    try {
      await discovery(library, '/verifications', 'POST', { operation, candidate })
      await job.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const running = job.data && ['queued', 'running'].includes(job.data.state)
  return (
    <section aria-label="Complete content verification">
      <p>Samples select possible matches. Verify complete content to prove large-file identity.</p>
      {draft.error && <p role="alert">{draft.error}</p>}
      {error && <p role="alert">{error}</p>}
      {job.error && <p role="alert">{job.error.message}</p>}
      {job.data && (
        <>
          <p role="status">
            {job.data.state === 'succeeded'
              ? 'Complete content verified'
              : `Content verification: ${job.data.state}`}
            {' · '}
            {job.data.verified} / {job.data.files} files{' · '}
            {job.data.bytes_read.toLocaleString()} / {job.data.total_bytes.toLocaleString()} bytes
          </p>
          {job.data.error && <p role="alert">{job.data.error}</p>}
          <progress max={Math.max(1, job.data.total_bytes)} value={job.data.bytes_read} />
        </>
      )}
      {!running && job.data?.state !== 'succeeded' && (
        <button disabled={busy} onClick={() => void start()}>
          Verify complete content
        </button>
      )}
      {running && (
        <button
          disabled={busy}
          onClick={() => {
            void discovery(library, `/verifications/${draft.body.operation}`, 'DELETE')
              .then(() => job.refetch())
              .catch((reason: Error) => setError(reason.message))
          }}
        >
          Cancel content verification
        </button>
      )}
    </section>
  )
}
