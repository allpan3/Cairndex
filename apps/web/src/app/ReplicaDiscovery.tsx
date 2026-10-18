// Manual Update keeps pending discoveries and grouping review separate from catalog editors
import { CandidateReview } from './DiscoveryCandidateReview'
import { DiscoveryPrepared } from './DiscoveryPrepared'
import { useModalDialog } from './useModalDialog'
import type { ReplicaDiscoveryState } from './useReplicaDiscovery'

function runStatus(run: ReplicaDiscoveryState['run']): string {
  if (run.isPending) return 'Loading Update status…'
  switch (run.data?.state) {
    case 'running':
      return `Updating · ${run.data.observed} files checked · ${run.data.repaired} links repaired`
    case 'succeeded':
      return `Update complete · ${run.data.observed} files checked · ${run.data.repaired} links repaired`
    case 'cancelled':
      return 'Update cancelled. Run Update to retry.'
    case 'failed':
      return 'Update could not finish. Run Update to retry.'
    default:
      return 'Update discovers local files when you choose it.'
  }
}

function RunProblem({ discovery: d }: { discovery: ReplicaDiscoveryState }) {
  const message = d.error || d.run.error?.message || d.run.data?.error
  if (!message) return null
  return (
    <p role="alert">
      {message}
      <button className="btn" onClick={() => void d.run.refetch()}>
        Retry Update status
      </button>
    </p>
  )
}

/** Metadata review's Update controls, with the last run's state always in view. */
export function DiscoveryControls({ discovery: d }: { discovery: ReplicaDiscoveryState }) {
  return (
    <section className="replica-discovery" aria-label="Library Update">
      <button disabled={!d.canStart} onClick={() => void d.start()}>
        Update
      </button>
      <button onClick={() => d.setOpen(true)}>Review discoveries</button>
      {d.running && (
        <button disabled={d.busy} onClick={d.cancel}>
          Cancel Update
        </button>
      )}
      <p role="status">{runStatus(d.run)}</p>
      <RunProblem discovery={d} />
    </section>
  )
}

/**
 * The sidebar's Update status: a run in progress, the result of the run this
 * window started, discovered files that wait for review, or a problem. Nothing
 * while Update sits idle with nothing to review.
 */
export function DiscoveryNotice({ discovery: d }: { discovery: ReplicaDiscoveryState }) {
  const state = d.run.data?.state
  const shown =
    d.running ||
    state === 'failed' ||
    state === 'cancelled' ||
    (state === 'succeeded' && d.run.data?.id === d.started)
  const problem = Boolean(d.error || d.run.error || d.run.data?.error)
  if (!shown && !problem && !d.pending) return null
  return (
    <section className="sidebar__notice" aria-label="Library Update">
      {shown && <p role="status">{runStatus(d.run)}</p>}
      {d.running && (
        <button className="btn" disabled={d.busy} onClick={d.cancel}>
          Cancel Update
        </button>
      )}
      {d.pending && !d.running && (
        <>
          <p>Discovered files wait for your review.</p>
          <button className="btn" onClick={() => d.setOpen(true)}>
            Review Discoveries…
          </button>
        </>
      )}
      <RunProblem discovery={d} />
    </section>
  )
}

/** The review of discovered files, over whichever view is open. */
export function DiscoveryReviewDialog({
  discovery: d,
  library,
  editor,
}: {
  discovery: ReplicaDiscoveryState
  library: string
  editor: string
}) {
  const { ref, close } = useModalDialog(() => d.setOpen(false), d.busy)
  const { candidates, reviews, review, candidate, reviewId } = d
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Discovery review"
        className="modal discovery-review-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2>Review discovered files</h2>
          <button className="btn" disabled={d.busy} onClick={close}>
            Close
          </button>
        </div>
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
                d.setCandidate(item)
                d.setReviewId(null)
              }}
            >
              {item.body.title} · {item.body.file_count ?? item.body.files.length} files
            </button>
          ))}
        </nav>
        {candidates.data?.next_cursor && (
          <button onClick={() => d.setAfter(candidates.data!.next_cursor!)}>
            Next discoveries
          </button>
        )}
        {d.after && <button onClick={() => d.setAfter('')}>First discoveries</button>}
        {candidate && !reviewId && (
          <CandidateReview
            key={candidate.id}
            library={library}
            editor={editor}
            candidate={candidate}
            onPrepared={d.setReviewId}
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
                {review.data.progress && ['queued', 'apply_queued'].includes(review.data.state) && (
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
                    disabled={d.busy}
                    onClick={() =>
                      void d.action(`/reviews/${reviewId}/accept`, 'POST', {
                        receipt: review.data!.receipt,
                      })
                    }
                  >
                    Accept reviewed changes
                  </button>
                )}
                {['failed', 'cancelled'].includes(review.data.state) && (
                  <button
                    disabled={d.busy}
                    onClick={() =>
                      void d.action('/reviews', 'POST', {
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
                    disabled={d.busy}
                    onClick={() => void d.action(`/reviews/${reviewId}`, 'DELETE')}
                  >
                    Cancel this review
                  </button>
                )}
                <button
                  onClick={() => {
                    d.setReviewId(null)
                    d.setCandidate(null)
                    void candidates.refetch()
                    d.refresh()
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
            <button key={item.id} onClick={() => d.setReviewId(item.id)}>
              {item.prepared?.title ?? 'Discovery review'} · {item.state}
            </button>
          ))}
          {reviews.data?.next_cursor && (
            <button onClick={() => d.setReviewsAfter(reviews.data!.next_cursor!)}>
              Next saved reviews
            </button>
          )}
          {d.reviewsAfter && (
            <button onClick={() => d.setReviewsAfter('')}>First saved reviews</button>
          )}
        </details>
      </div>
    </div>
  )
}
