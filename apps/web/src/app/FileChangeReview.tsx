// One file change, settled by one explicit action. When samples alone can't prove
// the file, the action first reads it completely; it then prepares the reviewed
// change and accepts it. The server checks the file again at every step.
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import {
  discovery,
  type DiscoveryCandidate,
  type DiscoveryReview,
  type DiscoveryVerification,
} from '../api/discovery'
import { formatBytes } from '../lib/format'
import type { FileChangeKind } from './fileChange'
import { useCatalogDraft } from './useCatalogDraft'

const COPY: Record<
  FileChangeKind,
  { lead: string; detail: string; action: string; plain: string; done: string }
> = {
  verification: {
    lead: 'Cairndex can’t confirm this file is unchanged.',
    detail:
      'Its size and sampled parts still match, but its date or disk ID changed. This is normal after a network share reconnects. Until it is checked, it won’t open or play.',
    action: 'Check and Restore',
    plain: 'Restore',
    done: 'restored',
  },
  repair: {
    lead: 'This file may be a library file that moved.',
    detail:
      'A file is missing from the library, and this one has the same size and sampled parts. Choose which missing file it is. Linking keeps that file’s bundle, tags and notes.',
    action: 'Check and Link',
    plain: 'Link',
    done: 'linked to the missing file',
  },
  replacement: {
    lead: 'This file’s content changed.',
    detail:
      'The file at this path is different from what Cairndex recorded. Use the new content to keep the file’s bundle, tags and notes with it. If you do nothing, the library stays as it is.',
    action: 'Use New Content',
    plain: 'Use New Content',
    done: 'updated with its new content',
  },
}

type Progress = { verification: string; review: string; repair: string }

function friendly(message: string): string {
  if (message.includes('different bytes'))
    return 'The whole file is different from what Cairndex recorded. Run Update to review it as changed content.'
  return message
}

export function FileChangeReview({
  library,
  editor,
  candidate,
  onSettled,
  onUpdate,
}: {
  library: string
  editor: string
  candidate: DiscoveryCandidate
  /** Called once when the change is saved, with a line for the list's notice */
  onSettled: (notice: string) => void
  /** Starts Update, when the server asks for one */
  onUpdate?: () => void
}) {
  const { body } = candidate
  const kind = body.kind as FileChangeKind
  const copy = COPY[kind]
  const file = body.files[0]
  const folder = candidate.path.includes('/')
    ? candidate.path.slice(0, candidate.path.lastIndexOf('/'))
    : ''
  const needsCheck =
    (body.unverified_count ??
      body.files.filter((item) => item.evidence.algorithm !== 'sha256').length) > 0
  // The operation identities persist first, so closing the window never loses a started step
  const draft = useCatalogDraft<Progress>(
    library,
    `file-change/${candidate.id}`,
    editor,
    { verification: '', review: '', repair: '' },
    undefined,
    false,
  )
  const { verification: verifyId, review: reviewId, repair } = draft.body
  const check = useQuery({
    queryKey: ['discovery-verification', library, verifyId],
    enabled: Boolean(verifyId),
    queryFn: () => discovery<DiscoveryVerification>(library, `/verifications/${verifyId}`),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.state ?? 'queued') ? 500 : false,
  })
  const review = useQuery({
    queryKey: ['discovery-review', library, reviewId],
    enabled: Boolean(reviewId),
    queryFn: () => discovery<DiscoveryReview>(library, `/reviews/${reviewId}`),
    refetchInterval: (query) =>
      ['applied', 'failed', 'cancelled'].includes(query.state.data?.state ?? '') ? false : 500,
  })
  const choices = useQuery({
    queryKey: ['discovery-choices', library, candidate.id],
    enabled: kind === 'repair',
    queryFn: () =>
      discovery<{ items: { file_id: string; path: string }[]; next_cursor: string | null }>(
        library,
        `/candidates/${candidate.id}/choices?after=`,
      ),
  })
  const sent = useRef<string | null>(null)
  const [requestError, setRequestError] = useState('')

  async function prepare(verification: string | null, base: Progress = draft.body) {
    const operation = operationId()
    draft.update({ ...base, review: operation })
    try {
      await discovery(library, '/reviews', 'POST', {
        operation,
        candidate: candidate.id,
        title: body.title,
        repair_file: repair || null,
        use_replacement: kind === 'replacement',
        ...(verification ? { verification } : {}),
      })
    } catch (reason) {
      draft.update({ ...base, review: '' })
      setRequestError(friendly((reason as Error).message))
    }
  }

  // Every attempt starts with new operations; a failed one is kept only on the server
  async function start() {
    setRequestError('')
    sent.current = null
    const base = { verification: '', review: '', repair }
    if (!needsCheck) return prepare(null, base)
    const operation = operationId()
    draft.update({ ...base, verification: operation })
    try {
      await discovery(library, '/verifications', 'POST', { operation, candidate: candidate.id })
    } catch (reason) {
      draft.update(base)
      setRequestError(friendly((reason as Error).message))
    }
  }

  // A complete check continues into the review, and a ready review into its acceptance
  const checked = check.data?.state === 'succeeded' ? check.data.id : null
  useEffect(() => {
    if (checked && !reviewId && sent.current !== `prepare:${checked}`) {
      sent.current = `prepare:${checked}`
      void prepare(checked)
    }
  })
  const ready = review.data?.state === 'ready' ? review.data : null
  useEffect(() => {
    if (ready?.receipt && sent.current !== `accept:${ready.id}`) {
      sent.current = `accept:${ready.id}`
      discovery(library, `/reviews/${ready.id}/accept`, 'POST', { receipt: ready.receipt })
        .then(() => review.refetch())
        .catch((reason: Error) => setRequestError(friendly(reason.message)))
    }
  })
  const applied = review.data?.state === 'applied'
  useEffect(() => {
    if (applied && sent.current !== 'settled') {
      sent.current = 'settled'
      onSettled(`${body.title} ${copy.done}.`)
    }
  })

  const checking = check.data && ['queued', 'running'].includes(check.data.state)
  const saving =
    Boolean(reviewId) && !applied && !['failed', 'cancelled'].includes(review.data?.state ?? '')
  const failure =
    requestError ||
    (check.data?.state === 'failed' ? friendly(check.data.error || 'The check stopped.') : '') ||
    (review.data && ['failed', 'cancelled'].includes(review.data.state)
      ? friendly(review.data.error ?? 'The change was not saved.')
      : '') ||
    (check.error ? check.error.message : '') ||
    (review.error ? review.error.message : '')
  const working = Boolean(checking || saving) && !failure
  const blocked = kind === 'repair' && !repair

  return (
    <div className="fc-detail" aria-label="File change">
      <h3 className="fc-detail__name">{body.title}</h3>
      <p className="fc-detail__path">
        {folder || 'Library folder'}
        {file ? ` · ${formatBytes(file.evidence.size)}` : ''}
      </p>
      <p className="fc-detail__lead">{copy.lead}</p>
      <p className="fc-detail__text">{copy.detail}</p>

      {kind === 'repair' && (
        <fieldset className="fc-choices" disabled={working || applied}>
          <legend>Which missing file is this?</legend>
          {choices.isPending && <p className="fc-muted">Loading missing files…</p>}
          {choices.error && <p className="fc-alert">{choices.error.message}</p>}
          {(choices.data?.items ?? body.choices ?? []).map((item) => (
            <label key={item.file_id} className="fc-choice">
              <input
                type="radio"
                name={`missing-${candidate.id}`}
                checked={repair === item.file_id}
                onChange={() => draft.update({ ...draft.body, repair: item.file_id })}
              />
              <span>{item.path}</span>
            </label>
          ))}
        </fieldset>
      )}

      {applied ? (
        <p className="fc-done" role="status">
          Done: {body.title} {copy.done}.
        </p>
      ) : checking && !failure ? (
        <div className="fc-progress" role="status">
          <div className="fc-progress__line">
            <span>Reading the whole file…</span>
            <span>
              {formatBytes(check.data!.bytes_read)} of {formatBytes(check.data!.total_bytes)}
            </span>
          </div>
          <progress max={Math.max(1, check.data!.total_bytes)} value={check.data!.bytes_read} />
          <div className="fc-actions">
            <span className="fc-muted">You can close this window; the check continues.</span>
            <span className="fc-spacer" />
            <button
              className="btn"
              onClick={() => {
                void discovery(library, `/verifications/${verifyId}`, 'DELETE').finally(() =>
                  draft.update({ ...draft.body, verification: '', review: '' }),
                )
              }}
            >
              Cancel Check
            </button>
          </div>
        </div>
      ) : working ? (
        <p className="fc-muted" role="status">
          Saving…
        </p>
      ) : (
        <>
          {failure && (
            <div className="fc-alert" role="alert">
              <p>{failure}</p>
              {onUpdate && /run update/i.test(failure) && (
                <button className="btn" onClick={onUpdate}>
                  Run Update
                </button>
              )}
            </div>
          )}
          <div className="fc-actions">
            {needsCheck && file && (
              <span className="fc-muted">
                Reads the whole file ({formatBytes(file.evidence.size)}) once.
              </span>
            )}
            <span className="fc-spacer" />
            <button className="btn btn--primary" disabled={blocked} onClick={() => void start()}>
              {failure ? 'Try Again' : needsCheck ? copy.action : copy.plain}
            </button>
          </div>
        </>
      )}
      {draft.error && <p className="fc-alert">{draft.error}</p>}
    </div>
  )
}
