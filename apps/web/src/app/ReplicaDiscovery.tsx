// Manual Update keeps pending discoveries and grouping review separate from catalog editors
import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { discovery, type DiscoveryCandidate, type DiscoveryRun } from '../api/discovery'
import { CandidateReview } from './DiscoveryCandidateReview'
import { DiscoveryPrepared } from './DiscoveryPrepared'
import { FILE_CHANGE_LABEL, isFileChange, type FileChangeKind } from './fileChange'
import { FileChangeReview } from './FileChangeReview'
import { useModalDialog } from './useModalDialog'
import type { ReplicaDiscoveryState } from './useReplicaDiscovery'

function completeStatus(run: DiscoveryRun): string {
  return `${run.initial_scan ? 'Initial scan' : 'Update'} complete · ${run.observed} files checked · ${run.repaired} links repaired`
}

function InitialScanInfo({ idle = false }: { idle?: boolean }) {
  return (
    <div className="discovery-setup">
      <strong>{idle ? 'Files not scanned on this server yet' : 'Initial library scan'}</strong>
      <p>
        {idle
          ? 'Run Update to check local files. Your saved organization is already available.'
          : 'First file scan on this server. Large libraries can take several minutes.'}
      </p>
      <details>
        <summary>About initial setup</summary>
        <p>
          The catalog and media cache are stored on the server. Browsers using this server share
          them. A different server, including the desktop app’s local server, prepares its own copy.
          Later Updates check all folders again and reuse unchanged file information.
        </p>
      </details>
    </div>
  )
}

function phaseLabel(run: DiscoveryRun | undefined): string {
  switch (run?.phase) {
    case 'walk':
      return 'Finding files'
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
      return `${run.data.initial_scan ? 'Initial scan' : 'Update'} cancelled. Run Update to retry.`
    case 'failed':
      return `${run.data.initial_scan ? 'Initial scan' : 'Update'} could not finish. Run Update to retry.`
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
      {d.run.data?.initial_scan && d.run.data.state !== 'succeeded' && (
        <InitialScanInfo idle={d.run.data.state === 'idle'} />
      )}
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
  const initial = d.run.data?.initial_scan && state !== 'succeeded'
  // The hook forgets the run once it is reported, not this row: the row
  // unmounts with the sidebar, and showing it again must not repeat the result
  const { finished, clearFinished } = d
  useEffect(() => {
    if (!finished) return
    clearFinished()
    onComplete(completeStatus(finished))
  }, [finished, clearFinished, onComplete])
  const problem = Boolean(d.error || d.run.error || d.run.data?.error)
  if (!initial && !d.running && !stopped && !problem && !d.pending) return null
  return (
    <section className="sidebar__job-progress" aria-label="Library Update">
      {initial && <InitialScanInfo idle={state === 'idle'} />}
      {(d.running || stopped) && (
        <div className="job-progress" role="status" aria-live="polite">
          <div className="job-progress__row">
            <span className="job-progress__label">
              {d.running
                ? phaseLabel(d.run.data)
                : state === 'cancelled'
                  ? `${initial ? 'Initial scan' : 'Update'} cancelled`
                  : `${initial ? 'Initial scan' : 'Update'} failed`}
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
  fileChangesOnly = false,
  earlier = false,
  onBack,
}: {
  discovery: ReplicaDiscoveryState
  library: string
  editor: string
  fileChangesOnly?: boolean
  /** Open on the earlier grouping choices rather than on file changes */
  earlier?: boolean
  onBack?: () => void
}) {
  const { ref, close } = useModalDialog(() => d.setOpen(false), d.busy)
  const [earlierChoices, setEarlierChoices] = useState(earlier)
  const changesView = fileChangesOnly && !earlierChoices
  const changes = useQuery({
    queryKey: ['discovery-file-changes', library, d.after],
    enabled: changesView,
    queryFn: ({ signal }) =>
      discovery<{ items: DiscoveryCandidate[]; next_cursor: string | null }>(
        library,
        `/candidates?file_changes=true&after=${encodeURIComponent(d.after)}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: 1500,
  })
  const candidates = changesView ? changes : d.candidates
  const { reviews, review, reviewId } = d
  const candidate = changesView && d.candidate && !isFileChange(d.candidate) ? null : d.candidate
  const items = candidates.data?.items ?? []
  // The first change is open by default, so the pane never starts empty
  const shown = candidate ?? (changesView && !reviewId ? (items[0] ?? null) : null)
  const [notice, setNotice] = useState('')
  const { setCandidate, refresh } = d
  const refetch = candidates.refetch
  const settled = useCallback(
    (line: string) => {
      setNotice(line)
      setCandidate(null)
      void refetch()
      refresh()
    },
    [setCandidate, refetch, refresh],
  )
  const savedCount = reviews.data?.items.length ?? 0
  // The earlier choices are offered only when grouping proposals exist to choose from
  const hasGrouping = Boolean(d.candidates.data?.items.some((item) => !isFileChange(item)))
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Discovery review"
        className="modal discovery-review-dialog fc-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head fc-head">
          <h2>{changesView ? 'File changes' : 'Earlier grouping choices'}</h2>
          {changesView && items.length > 0 && (
            <span className="fc-count">
              {items.length}
              {candidates.data?.next_cursor ? '+' : ''}
            </span>
          )}
          <span className="fc-spacer" />
          {fileChangesOnly && (earlierChoices || hasGrouping) && (
            <button
              className="btn btn--compact"
              onClick={() => {
                if (earlierChoices && d.candidate && !isFileChange(d.candidate))
                  d.setCandidate(null)
                setEarlierChoices((value) => !value)
                d.setAfter('')
              }}
            >
              {earlierChoices ? 'File changes only' : 'Earlier grouping choices…'}
            </button>
          )}
          {onBack && (
            <button className="btn btn--compact" disabled={d.busy} onClick={onBack}>
              Back to grouping
            </button>
          )}
          <button className="modal__close" aria-label="Close" disabled={d.busy} onClick={close}>
            ×
          </button>
        </div>
        <div className="fc-intro">
          <p>
            {changesView
              ? 'Files that changed on disk since Cairndex last checked them. Your library changes only when you act on one.'
              : 'Choices stay private until you accept a prepared review.'}
          </p>
          {notice && (
            <p className="fc-notice" role="status">
              {notice}
            </p>
          )}
        </div>
        <div className="fc-body">
          <div className="fc-list">
            {candidates.isPending && <p className="fc-muted">Loading discoveries…</p>}
            {candidates.error && (
              <div className="fc-alert" role="alert">
                <p>{candidates.error.message}</p>
                <button className="btn btn--compact" onClick={() => void candidates.refetch()}>
                  Retry discoveries
                </button>
              </div>
            )}
            {candidates.data?.items.length === 0 && (
              <p className="fc-muted">No new files or identity choices on this page.</p>
            )}
            <nav aria-label="Discovery suggestions">
              {items.map((item) => {
                const change = isFileChange(item)
                const folder = item.path.includes('/')
                  ? item.path.slice(0, item.path.lastIndexOf('/'))
                  : ''
                const count = item.body.file_count ?? item.body.files.length
                return (
                  <button
                    key={item.id}
                    className="fc-row"
                    aria-pressed={shown?.id === item.id && !reviewId}
                    aria-label={change ? undefined : `${item.body.title} · ${count} files`}
                    title={item.path}
                    onClick={() => {
                      setNotice('')
                      d.setCandidate(item)
                      d.setReviewId(null)
                    }}
                  >
                    <span className="fc-row__name">{item.body.title}</span>
                    <span className="fc-row__meta">
                      {change ? (
                        <span className={`fc-badge fc-badge--${item.body.kind}`}>
                          {FILE_CHANGE_LABEL[item.body.kind as FileChangeKind]}
                        </span>
                      ) : (
                        <span>{count === 1 ? '1 file' : `${count} files`}</span>
                      )}
                      {folder && <span className="fc-row__folder">{folder}</span>}
                    </span>
                  </button>
                )
              })}
            </nav>
            {(candidates.data?.next_cursor || d.after) && (
              <div className="fc-pager">
                {d.after && (
                  <button className="btn btn--compact" onClick={() => d.setAfter('')}>
                    First discoveries
                  </button>
                )}
                {candidates.data?.next_cursor && (
                  <button
                    className="btn btn--compact"
                    onClick={() => d.setAfter(candidates.data!.next_cursor!)}
                  >
                    Next discoveries
                  </button>
                )}
              </div>
            )}
            {savedCount > 0 && (
              <details className="fc-saved">
                <summary>Saved discovery reviews</summary>
                {reviews.isPending && <p className="fc-muted">Loading saved reviews…</p>}
                {reviews.error && <p className="fc-alert">{reviews.error.message}</p>}
                {reviews.data?.items.map((item) => (
                  <button
                    key={item.id}
                    className="fc-row"
                    aria-pressed={reviewId === item.id}
                    onClick={() => d.setReviewId(item.id)}
                  >
                    {item.prepared?.title ?? 'Discovery review'} · {item.state}
                  </button>
                ))}
                {reviews.data?.next_cursor && (
                  <button
                    className="btn btn--compact"
                    onClick={() => d.setReviewsAfter(reviews.data!.next_cursor!)}
                  >
                    Next saved reviews
                  </button>
                )}
                {d.reviewsAfter && (
                  <button className="btn btn--compact" onClick={() => d.setReviewsAfter('')}>
                    First saved reviews
                  </button>
                )}
              </details>
            )}
          </div>
          <div className="fc-pane">
            {!shown && !reviewId && (
              <p className="fc-muted fc-pane__empty">
                {changesView ? 'Nothing to review.' : 'Choose a discovery to review it.'}
              </p>
            )}
            {shown && !reviewId && isFileChange(shown) && (
              <FileChangeReview
                key={shown.id}
                library={library}
                editor={editor}
                candidate={shown}
                onSettled={settled}
                onUpdate={d.canStart ? () => void d.start() : undefined}
              />
            )}
            {shown && !reviewId && !isFileChange(shown) && (
              <CandidateReview
                key={shown.id}
                library={library}
                editor={editor}
                candidate={shown}
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
                    <div className="fc-actions">
                      <button
                        className="btn"
                        onClick={() => {
                          d.setReviewId(null)
                          d.setCandidate(null)
                          void candidates.refetch()
                          d.refresh()
                        }}
                      >
                        Back to discoveries
                      </button>
                      <span className="fc-spacer" />
                      {['queued', 'ready', 'apply_queued'].includes(review.data.state) && (
                        <button
                          className="btn"
                          disabled={d.busy}
                          onClick={() => void d.action(`/reviews/${reviewId}`, 'DELETE')}
                        >
                          Cancel this review
                        </button>
                      )}
                      {['failed', 'cancelled'].includes(review.data.state) && (
                        <button
                          className="btn"
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
                      {review.data.state === 'ready' && (
                        <button
                          className="btn btn--primary"
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
                    </div>
                  </>
                )}
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
