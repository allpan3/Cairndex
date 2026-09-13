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
import { CatalogValue } from './CatalogControls'
import { useCatalogDraft } from './useCatalogDraft'

// Persisted nested JSON must be a bounded selection before rendering or sending it
function validSelection(body: { files: string }): boolean {
  try {
    const files: unknown = JSON.parse(body.files)
    return (
      Array.isArray(files) && files.length <= 128 && files.every((id) => typeof id === 'string')
    )
  } catch {
    return false
  }
}

// Prepared bytes and original draft values remain stable while catalog queries refresh
function CandidateReview({
  library,
  editor,
  candidate,
  onPrepared,
}: {
  library: string
  editor: string
  candidate: DiscoveryCandidate
  onPrepared: (id: string) => void
}) {
  const { body } = candidate
  const [initialOperation] = useState(operationId)
  const draft = useCatalogDraft(
    library,
    `discovery/${candidate.id}`,
    editor,
    {
      title: body.title,
      target: body.target ?? '',
      files: JSON.stringify(body.files.flatMap((file) => (file.id ? [file.id] : []))),
      repair: '',
      replacement: false,
      operation: initialOperation,
    },
    validSelection,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected = JSON.parse(draft.body.files) as string[]
  // Each revised selection is a new intent; retrying an unchanged request retains its identity
  function update(value: Partial<typeof draft.body>) {
    draft.update({ ...draft.body, ...value, operation: operationId() })
  }
  async function prepare() {
    setBusy(true)
    setError('')
    try {
      const review = await discovery<DiscoveryReview>(library, '/reviews', 'POST', {
        operation: draft.body.operation,
        candidate: candidate.id,
        title: draft.body.title,
        target: draft.body.target || null,
        ...(body.kind === 'new' ? { files: selected } : {}),
        repair_file: draft.body.repair || null,
        use_replacement: draft.body.replacement,
      })
      onPrepared(review.id)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Discovery grouping choice">
      <h3>{body.title}</h3>
      <p>{body.reason}</p>
      {draft.error && <p role="alert">{draft.error}</p>}
      {draft.copies.map((copy) => (
        <button key={copy.id} onClick={() => draft.update(copy.body)}>
          Recover discovery draft {copy.revision}
        </button>
      ))}
      {body.kind === 'new' && (
        <>
          <label>
            Bundle title
            <input
              value={draft.body.title}
              onChange={(event) => update({ title: event.target.value })}
            />
          </label>
          <label>
            Destination
            <CatalogValue
              library={library}
              control={{
                field: 'bundle_id',
                label: 'Destination',
                kind: 'reference',
                nullable: true,
                choices: [],
                reference_family: 'asset_bundles',
                columns: [],
              }}
              raw={JSON.stringify(draft.body.target || null)}
              onChange={(raw) => update({ target: (JSON.parse(raw) as string | null) ?? '' })}
            />
          </label>
          <p>
            {draft.body.target
              ? 'Add selected files to this bundle; its existing order and metadata remain.'
              : 'Create a new bundle from the selected files.'}
          </p>
        </>
      )}
      {body.kind === 'repair' && (
        <label>
          Missing file to repair
          <select
            value={draft.body.repair}
            onChange={(event) => update({ repair: event.target.value })}
          >
            <option value="">Choose a missing file</option>
            {body.choices?.map((choice) => (
              <option key={choice.file_id} value={choice.file_id}>
                {choice.path}
              </option>
            ))}
          </select>
        </label>
      )}
      {body.kind === 'replacement' && (
        <label>
          <input
            type="checkbox"
            checked={draft.body.replacement}
            onChange={(event) => update({ replacement: event.target.checked })}
          />
          Use these replacement bytes for the existing file identity and its metadata
        </label>
      )}
      <ol aria-label="Discovered files">
        {[...body.files]
          .sort((a, b) => selected.indexOf(a.id!) - selected.indexOf(b.id!))
          .map((file) => (
            <li key={file.path}>
              {body.kind === 'new' ? (
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(file.id!)}
                    onChange={(event) =>
                      update({
                        files: JSON.stringify(
                          event.target.checked
                            ? [...selected, file.id!]
                            : selected.filter((id) => id !== file.id),
                        ),
                      })
                    }
                  />
                  {file.path}
                </label>
              ) : (
                file.path
              )}
              {body.kind === 'new' && selected.includes(file.id!) && (
                <button
                  aria-label={`Move ${file.path} earlier`}
                  disabled={selected.indexOf(file.id!) <= 0}
                  onClick={() => {
                    const order = [...selected]
                    const index = order.indexOf(file.id!)
                    ;[order[index - 1], order[index]] = [order[index]!, order[index - 1]!]
                    update({ files: JSON.stringify(order) })
                  }}
                >
                  Move earlier
                </button>
              )}
            </li>
          ))}
      </ol>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={
          busy ||
          (body.kind === 'new' && !selected.length) ||
          (body.kind === 'repair' && !draft.body.repair) ||
          (body.kind === 'replacement' && !draft.body.replacement)
        }
        onClick={() => void prepare()}
      >
        {busy ? 'Preparing…' : 'Prepare grouping review'}
      </button>
    </section>
  )
}

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
                {item.body.title} · {item.body.files.length} files
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
                  {review.data.error && <p role="alert">{review.data.error}</p>}
                  {review.data.prepared && (
                    <>
                      <h3>{review.data.prepared.title}</h3>
                      <ol>
                        {review.data.prepared.files.map((file) => (
                          <li key={file.path}>{file.path}</li>
                        ))}
                      </ol>
                      <details>
                        <summary>Review complete metadata and order</summary>
                        <pre>
                          {JSON.stringify(
                            review.data.prepared.catalog.changes.map((change) => ({
                              field: change.unit,
                              value: JSON.parse(change.value) as unknown,
                            })),
                            null,
                            2,
                          )}
                        </pre>
                      </details>
                    </>
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
