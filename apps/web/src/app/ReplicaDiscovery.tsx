// Manual Update keeps pending discoveries and grouping review separate from catalog editors
import { useEffect } from 'react'
import type { DiscoveryRun } from '../api/discovery'
import { CandidateReview } from './DiscoveryCandidateReview'
import { DiscoveryPrepared } from './DiscoveryPrepared'
import { useModalDialog } from './useModalDialog'
import type { ReplicaDiscoveryState } from './useReplicaDiscovery'

function completeStatus(run: DiscoveryRun): string {
  return `Update complete · ${run.observed} files checked · ${run.repaired} links repaired`
}

function phaseLabel(run: DiscoveryRun | undefined): string {
  switch (run?.phase) {
    case 'walk':
      return 'Finding files · total not yet known'
    case 'known':
      return 'Checking cataloged files'
    case 'repair':
      return 'Checking moved files'
    case 'propose':
      return 'Indexing discovered files'
    case 'plan_known':
      return 'Indexing existing groupings'
    case 'group':
      return 'Grouping suggestions'
    case 'export':
      return 'Preparing suggestions'
    default:
      return 'Updating'
  }
}

function phaseCount(run: DiscoveryRun | undefined): string {
  return run?.total != null
    ? `${run.completed ?? 0} / ${run.total}`
    : run?.phase === 'walk'
      ? `${run.observed ?? 0} found`
      : run?.phase == null
        ? `${run?.observed ?? 0}`
        : ''
}

function runStatus(run: ReplicaDiscoveryState['run']): string {
  if (run.isPending) return 'Loading Update status…'
  switch (run.data?.state) {
    case 'running':
      return `${phaseLabel(run.data)} · ${phaseCount(run.data)}`
    case 'succeeded':
      return completeStatus(run.data)
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
  // The status line below reports the result, so the browser need not repeat it
  const { finished, clearFinished } = d
  useEffect(() => {
    if (finished) clearFinished()
  }, [finished, clearFinished])
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
 * The sidebar footer's Update row, as v0.2.1 showed a running job: what it is
 * doing, a count, × to stop it and a bar. A run leaves the footer when it
 * finishes, and `onComplete` reports the result of a run this window started,
 * as v0.2.1's scan-complete message did; a cancelled or failed run stays until
 * the next one, because it needs the owner. Discovered files that wait for
 * review keep a row of their own.
 */
export function DiscoveryNotice({
  discovery: d,
  onComplete,
}: {
  discovery: ReplicaDiscoveryState
  onComplete: (text: string) => void
}) {
  const state = d.run.data?.state
  const total = d.run.data?.total
  const completed = d.run.data?.completed ?? 0
  const determinate = d.running && total != null
  const stopped = state === 'failed' || state === 'cancelled'
  // The hook forgets the run once it is reported, not this row: the row
  // unmounts with the sidebar, and showing it again must not repeat the result
  const { finished, clearFinished } = d
  useEffect(() => {
    if (!finished) return
    clearFinished()
    onComplete(completeStatus(finished))
  }, [finished, clearFinished, onComplete])
  const problem = Boolean(d.error || d.run.error || d.run.data?.error)
  if (!d.running && !stopped && !problem && !d.pending) return null
  return (
    <section className="sidebar__job-progress" aria-label="Library Update">
      {(d.running || stopped) && (
        <div className="job-progress" role="status" aria-live="polite">
          <div className="job-progress__row">
            <span className="job-progress__label">
              {d.running
                ? phaseLabel(d.run.data)
                : state === 'cancelled'
                  ? 'Update cancelled'
                  : 'Update failed'}
            </span>
            {d.running && <span className="job-progress__count">{phaseCount(d.run.data)}</span>}
            {d.running && (
              <button
                type="button"
                className="job-progress__cancel"
                disabled={d.busy}
                onClick={d.cancel}
                title="Stop Update"
                aria-label="Cancel Update"
              >
                ×
              </button>
            )}
          </div>
          <div
            className={`job-progress__track${
              d.running
                ? determinate
                  ? ''
                  : ' job-progress__track--indeterminate'
                : ' job-progress__track--error'
            }`}
            role="progressbar"
            aria-label="Update progress"
            aria-valuemin={determinate ? 0 : undefined}
            aria-valuemax={determinate ? total : undefined}
            aria-valuenow={determinate ? completed : undefined}
            aria-valuetext={phaseLabel(d.run.data)}
          >
            <div
              className="job-progress__bar"
              style={
                determinate
                  ? { width: `${total ? Math.min(100, (completed / total) * 100) : 100}%` }
                  : undefined
              }
            />
          </div>
          {stopped && <div className="job-progress__error">Run Update to retry.</div>}
        </div>
      )}
      {d.pending && !d.running && (
        <div className="sidebar__job-review">
          <span>Discovered files wait for your review.</span>
          <button className="btn btn--sm" onClick={() => d.setOpen(true)}>
            Review Discoveries…
          </button>
        </div>
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
