// Manual Update keeps pending discoveries and grouping review separate from catalog editors
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import {
  discovery,
  type DiscoveryCandidate,
  type DiscoveryReview,
  type DiscoveryRun,
} from '../api/discovery'
import { CandidateReview } from './DiscoveryCandidateReview'
import { DiscoveryPrepared } from './DiscoveryPrepared'

// Update and review remain mounted alongside the selected editor so refresh cannot discard drafts
export function ReplicaDiscovery({
  library,
  editor,
  refresh,
}: {
  library: string
  editor: string
  refresh: () => void
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const [dismissedRun, setDismissedRun] = useState<string | null>(null)
  const [after, setAfter] = useState('')
  const [candidate, setCandidate] = useState<DiscoveryCandidate | null>(null)
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [reviewsAfter, setReviewsAfter] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [startOperation, setStartOperation] = useState(operationId)
  const run = useQuery({
    queryKey: ['discovery-run', library],
    queryFn: ({ signal }) => discovery<DiscoveryRun>(library, '/status', 'GET', undefined, signal),
    refetchInterval: 1000,
  })
  const candidates = useQuery({
    queryKey: ['discovery-candidates', library, after],
    queryFn: ({ signal }) =>
      discovery<{ items: DiscoveryCandidate[]; next_cursor: string | null }>(
        library,
        `/candidates?after=${encodeURIComponent(after)}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: 1500,
  })
  const open =
    manualOpen ||
    (run.data?.state === 'succeeded' &&
      run.data.id !== dismissedRun &&
      Boolean(candidates.data?.items.length))
  // Closing acknowledges this completed run without changing any review intent
  function setOpen(value: boolean) {
    setManualOpen(value)
    if (!value) setDismissedRun(run.data?.id ?? null)
  }
  const reviews = useQuery({
    queryKey: ['discovery-reviews', library, reviewsAfter],
    queryFn: ({ signal }) =>
      discovery<{ items: DiscoveryReview[]; next_cursor: string | null }>(
        library,
        `/reviews?after=${encodeURIComponent(reviewsAfter)}`,
        'GET',
        undefined,
        signal,
      ),
    enabled: open,
    refetchInterval: 2000,
  })
  const review = useQuery({
    queryKey: ['discovery-review', library, reviewId],
    queryFn: ({ signal }) =>
      discovery<DiscoveryReview>(library, `/reviews/${reviewId}`, 'GET', undefined, signal),
    enabled: Boolean(reviewId),
    refetchInterval: 500,
  })
  // A failed network request retains its operation ID; only a successful enqueue starts a new one
  async function start() {
    setBusy(true)
    setError('')
    try {
      await discovery(library, '/runs', 'POST', { operation: startOperation })
      setStartOperation(operationId())
      void run.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true)
    setError('')
    try {
      await discovery(library, path, method, body)
      void run.refetch()
      if (reviewId) void review.refetch()
      void candidates.refetch()
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="replica-discovery" aria-label="Library Update">
      <button
        disabled={busy || run.isPending || run.data?.state === 'running'}
        onClick={() => void start()}
      >
        Update
      </button>
      <button onClick={() => setOpen(!open)}>
        {open ? 'Close discovery review' : 'Review discoveries'}
      </button>
      {run.data?.state === 'running' && (
        <button disabled={busy} onClick={() => void action(`/runs/${run.data!.id}`, 'DELETE')}>
          Cancel Update
        </button>
      )}
      <p role="status">
        {run.isPending
          ? 'Loading Update status…'
          : run.data?.state === 'running'
            ? `Updating · ${run.data.observed} files checked · ${run.data.repaired} links repaired`
            : run.data?.state === 'succeeded'
              ? `Update complete · ${run.data.observed} files checked · ${run.data.repaired} links repaired`
              : run.data?.state === 'cancelled'
                ? 'Update cancelled. Run Update to retry.'
                : run.data?.state === 'failed'
                  ? 'Update could not finish. Run Update to retry.'
                  : 'Update discovers local files when you choose it.'}
      </p>
      {(error || run.error || run.data?.error) && (
        <p role="alert">
          {error || run.error?.message || run.data?.error}
          <button onClick={() => void run.refetch()}>Retry Update status</button>
        </p>
      )}
      {open && (
        <section aria-label="Discovery review">
          <h2>Review discovered files</h2>
          <p>Choices stay private until you accept a prepared review.</p>
          {candidates.isPending && <p>Loading discoveries…</p>}
          {candidates.error && (
            <p role="alert">
              {candidates.error.message}
              <button onClick={() => void candidates.refetch()}>Retry discoveries</button>
            </p>
          )}
          {candidates.data?.items.length === 0 && (
            <p>No new files or identity choices on this page.</p>
          )}
          <nav aria-label="Discovery suggestions">
            {candidates.data?.items.map((item) => (
              <button
                key={item.id}
                aria-pressed={candidate?.id === item.id}
                onClick={() => {
                  setManualOpen(true)
                  setCandidate(item)
                  setReviewId(null)
                }}
              >
                {item.body.title} · {item.body.file_count ?? item.body.files.length} files
              </button>
            ))}
          </nav>
          {candidates.data?.next_cursor && (
            <button onClick={() => setAfter(candidates.data!.next_cursor!)}>
              Next discoveries
            </button>
          )}
          {after && <button onClick={() => setAfter('')}>First discoveries</button>}
          {candidate && !reviewId && (
            <CandidateReview
              key={candidate.id}
              library={library}
              editor={editor}
              candidate={candidate}
              onPrepared={setReviewId}
            />
          )}
          {reviewId && (
            <section aria-label="Prepared discovery review">
              {review.isPending && <p>Loading prepared review…</p>}
              {review.error && (
                <p role="alert">
                  {review.error.message}
                  <button onClick={() => void review.refetch()}>Retry prepared review</button>
                </p>
              )}
              {review.data && (
                <>
                  <p role="status">
                    {review.data.state === 'queued'
                      ? 'Preparing reviewed grouping…'
                      : review.data.state === 'apply_queued'
                        ? 'Revalidating files and saving…'
                        : review.data.state === 'applied'
                          ? 'Reviewed changes saved here. Any competing changes remain in catalog conflict review.'
                          : review.data.state === 'ready'
                            ? 'Ready for your confirmation'
                            : 'Review retained; prepare again before applying.'}
                  </p>
                  {review.data.progress &&
                    ['queued', 'apply_queued'].includes(review.data.state) && (
                      <p>
                        {review.data.progress.phase} · {review.data.progress.progress} /{' '}
                        {review.data.progress.total} files
                      </p>
                    )}
                  {review.data.error && <p role="alert">{review.data.error}</p>}
                  {review.data.prepared && (
                    <DiscoveryPrepared library={library} review={review.data} />
                  )}
                  {review.data.state === 'ready' && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(`/reviews/${reviewId}/accept`, 'POST', {
                          receipt: review.data!.receipt,
                        })
                      }
                    >
                      Accept reviewed changes
                    </button>
                  )}
                  {['failed', 'cancelled'].includes(review.data.state) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action('/reviews', 'POST', {
                          operation: reviewId,
                          ...review.data!.intent,
                        })
                      }
                    >
                      Revalidate saved review
                    </button>
                  )}
                  {['queued', 'ready', 'apply_queued'].includes(review.data.state) && (
                    <button
                      disabled={busy}
                      onClick={() => void action(`/reviews/${reviewId}`, 'DELETE')}
                    >
                      Cancel this review
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setReviewId(null)
                      setCandidate(null)
                      void candidates.refetch()
                      refresh()
                    }}
                  >
                    Back to discoveries
                  </button>
                </>
              )}
            </section>
          )}
          <details>
            <summary>Saved discovery reviews</summary>
            {reviews.isPending && <p>Loading saved reviews…</p>}
            {reviews.error && <p role="alert">{reviews.error.message}</p>}
            {reviews.data?.items.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setManualOpen(true)
                  setReviewId(item.id)
                }}
              >
                {item.prepared?.title ?? 'Discovery review'} · {item.state}
              </button>
            ))}
            {reviews.data?.next_cursor && (
              <button onClick={() => setReviewsAfter(reviews.data!.next_cursor!)}>
                Next saved reviews
              </button>
            )}
            {reviewsAfter && (
              <button onClick={() => setReviewsAfter('')}>First saved reviews</button>
            )}
          </details>
        </section>
      )}
    </section>
  )
}
