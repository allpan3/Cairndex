import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { catalogNavigation } from '../../api/catalogQuery'
import { getConnectionScopeKey } from '../../api/requestScope'
import type { CollectionRead } from '../../api/client'
import { DiscoveryPrepared } from '../DiscoveryPrepared'
import { DiscoveryReviewDialog } from '../ReplicaDiscovery'
import { useModalDialog } from '../useModalDialog'
import type { ReplicaDiscoveryState } from '../useReplicaDiscovery'
import { GroupingMoveDialog, type GroupingMove } from './GroupingMoveDialog'
import { GroupingTree } from './GroupingTree'
import { useGroupingWorkspace } from './useGroupingWorkspace'
import { useGroupingTree } from './useGroupingTree'

export function GroupingReviewDialog(props: {
  discovery: ReplicaDiscoveryState
  library: string
  editor: string
}) {
  return createPortal(
    <GroupingReviewSession key={`${getConnectionScopeKey()}:${props.library}`} {...props} />,
    document.body,
  )
}

function GroupingReviewSession({
  discovery: d,
  library,
  editor,
}: {
  discovery: ReplicaDiscoveryState
  library: string
  editor: string
}) {
  const state = useGroupingWorkspace(library, d.refresh)
  const [fileChanges, setFileChanges] = useState(false)
  const [attention, setAttention] = useState(false)
  const [verify, setVerify] = useState(false)
  const [move, setMove] = useState<GroupingMove | null>(null)
  const { ref, close } = useModalDialog(() => d.setOpen(false), state.sending)
  const tree = useGroupingTree(state, attention)
  const collections = useQuery({
    queryKey: ['catalog-navigation', library, 'collections'],
    queryFn: () => catalogNavigation<CollectionRead>(library, 'collections'),
  })
  const options = (collections.data ?? []).map((item) => {
    const names = [item.name]
    const seen = new Set([item.id])
    let parent = item.parent_id
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const found = collections.data?.find((candidate) => candidate.id === parent)
      if (!found) break
      names.unshift(found.name)
      parent = found.parent_id
    }
    return { id: item.id, parent_id: item.parent_id, name: item.name, path: names.join(' / ') }
  })
  const status = state.status.data
  const review = state.review.data
  const editingBlocked = state.busy || tree.stale || Boolean(status?.accepting)
  const choosingBlocked =
    state.sending ||
    Boolean(state.pending) ||
    Boolean(status && status.state !== 'ready' && state.command.data?.state !== 'paused')
  const message =
    state.error ||
    state.status.error?.message ||
    state.lists.error?.message ||
    status?.error ||
    state.review.error?.message ||
    state.command.error?.message ||
    state.command.data?.error
  const canPrepare = !editingBlocked && Boolean(status?.selected)
  return (
    <>
      <div
        className="modal-backdrop"
        onMouseDown={close}
        style={fileChanges ? { display: 'none' } : undefined}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-label="Grouping review"
          className="modal grp-modal portable-grp-modal"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canPrepare) {
              event.preventDefault()
              state.edit({ action: 'prepare', verify_content: verify })
            }
          }}
        >
          <div className="modal__head">
            <h2>Review grouping suggestions</h2>
            <button className="btn" disabled={state.sending} onClick={close}>
              Close
            </button>
          </div>
          <p className="grp-intro">
            Choose how files form bundles and collections. Your draft stays private until you accept
            it.
          </p>
          <div className="grp-selectbar">
            <span>
              {status
                ? `${status.selected} / ${status.files} files selected · ${status.bundles} ${status.bundles === 1 ? 'bundle' : 'bundles'}`
                : 'Loading grouping suggestions…'}
            </span>
            <button
              className="btn btn--sm"
              onClick={() => {
                d.setAfter('')
                setFileChanges(true)
              }}
            >
              File changes and saved reviews…
            </button>
          </div>
          <details>
            <summary>Retained grouping drafts</summary>
            {state.lists.data?.items.map((item) => (
              <button
                className="btn btn--sm"
                key={item.id}
                disabled={choosingBlocked || item.id === state.workspace}
                onClick={() => void state.choose(item.id)}
              >
                {item.files} files · {item.state}
                {item.accepting ? ' · Pending review' : ''}
              </button>
            ))}
            {state.lists.data?.available_run &&
              state.lists.data.available_run !== state.workspace && (
                <button
                  className="btn"
                  disabled={choosingBlocked}
                  onClick={() => void state.choose(state.lists.data!.available_run!)}
                >
                  Review latest Update
                </button>
              )}
            {state.lists.data?.next_cursor != null && (
              <button onClick={() => state.setAfter(state.lists.data!.next_cursor!)}>
                Older drafts
              </button>
            )}
            {state.after !== null && (
              <button onClick={() => state.setAfter(null)}>Latest drafts</button>
            )}
          </details>
          <div className="grp-status" role={message ? 'alert' : 'status'}>
            {message ||
              (status?.state === 'ready'
                ? status.accepting
                  ? 'Grouping draft is held for the prepared review.'
                  : 'Edits are saved in this private draft.'
                : status
                  ? `Preparing grouping draft · ${status.phase}`
                  : '')}
            {state.error && state.pending && (
              <button disabled={state.sending} onClick={state.retry}>
                Retry exact edit
              </button>
            )}
            {(state.status.error || state.lists.error) && (
              <button
                onClick={() => {
                  void state.status.refetch()
                  void state.lists.refetch()
                }}
              >
                Retry grouping status
              </button>
            )}
          </div>
          {!state.workspace && !state.lists.isPending && !message && (
            <p className="grp-empty">Run Update to discover grouping suggestions.</p>
          )}
          {state.command.data?.state === 'paused' && (
            <button className="btn" disabled={state.sending} onClick={() => void state.resume()}>
              Resume retained grouping edit
            </button>
          )}
          {status && status.revision > 0 && (
            <>
              <div className="grp-selectbar">
                <div className="grp-selectbar__group">
                  <button
                    className="btn btn--sm"
                    disabled={editingBlocked}
                    onClick={() => state.edit({ action: 'select', selected: true })}
                  >
                    Select all
                  </button>
                  <button
                    className="btn btn--sm"
                    disabled={editingBlocked}
                    onClick={() => state.edit({ action: 'select', selected: false })}
                  >
                    Select none
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={attention}
                      onChange={(event) => setAttention(event.target.checked)}
                    />
                    Needs a look ({status.uncertain})
                  </label>
                </div>
                <div className="grp-selectbar__group">
                  <button className="btn btn--sm" onClick={tree.expandCollections}>
                    Expand shown collections
                  </button>
                  <button className="btn btn--sm" onClick={tree.collapseCollections}>
                    Collapse collections
                  </button>
                  <button className="btn btn--sm" onClick={tree.showFiles}>
                    Show files
                  </button>
                  <button className="btn btn--sm" onClick={tree.hideFiles}>
                    Hide files
                  </button>
                </div>
              </div>
              <GroupingTree state={state} tree={tree} collections={options} onMove={setMove} />
            </>
          )}
          {state.verification.data && (
            <section aria-label="Complete content verification">
              <p role="status">
                {state.verification.data.verified} / {state.verification.data.files} files ·{' '}
                {state.verification.data.bytes_read.toLocaleString()} /{' '}
                {state.verification.data.total_bytes.toLocaleString()} bytes verified
              </p>
              <progress
                value={state.verification.data.bytes_read}
                max={Math.max(1, state.verification.data.total_bytes)}
              />
              {['queued', 'running'].includes(state.verification.data.state) && (
                <button disabled={state.sending} onClick={() => void state.cancelVerification()}>
                  Cancel content verification
                </button>
              )}
            </section>
          )}
          {status?.accepting && (
            <section className="portable-grp-prepared" aria-label="Prepared grouping review">
              <p role="status">
                {review?.state === 'ready'
                  ? 'Ready for your confirmation'
                  : review?.state === 'apply_queued'
                    ? 'Rechecking files and saving…'
                    : review?.state === 'applied'
                      ? 'Grouping saved here.'
                      : review?.state === 'queued'
                        ? 'Preparing reviewed grouping…'
                        : 'Review retained; return to the draft to prepare again.'}
              </p>
              {review?.progress && (
                <p>
                  {review.progress.progress} / {review.progress.total} files
                </p>
              )}
              {review?.error && <p role="alert">{review.error}</p>}
              {review?.prepared && (
                <details>
                  <summary>Review prepared files and metadata</summary>
                  <DiscoveryPrepared library={library} review={review} />
                </details>
              )}
              {review?.state === 'ready' && (
                <button
                  className="btn btn--primary"
                  disabled={state.sending}
                  onClick={() => void state.accept()}
                >
                  Accept reviewed grouping
                </button>
              )}
              {review && !['applied', 'apply_queued'].includes(review.state) && (
                <button
                  className="btn"
                  disabled={state.busy}
                  onClick={() => state.edit({ action: 'cancel_review', review: review.id })}
                >
                  Return to editing
                </button>
              )}
            </section>
          )}
          <div className="modal__foot">
            <label className="grp-foot__note">
              <input
                type="checkbox"
                checked={verify}
                disabled={editingBlocked}
                onChange={(event) => setVerify(event.target.checked)}
              />
              Verify complete content before preparing
            </label>
            <button
              className="btn btn--primary"
              disabled={!canPrepare}
              onClick={() => state.edit({ action: 'prepare', verify_content: verify })}
            >
              Prepare selected grouping
            </button>
          </div>
          {move && <GroupingMoveDialog state={state} move={move} onClose={() => setMove(null)} />}
        </div>
      </div>
      {fileChanges && (
        <DiscoveryReviewDialog
          discovery={d}
          library={library}
          editor={editor}
          fileChangesOnly
          onBack={() => {
            setFileChanges(false)
            d.setCandidate(null)
            d.setReviewId(null)
          }}
        />
      )}
      {collections.error && (
        <p role="alert">
          {collections.error.message}
          <button className="btn btn--sm" onClick={() => void collections.refetch()}>
            Retry collection destinations
          </button>
        </p>
      )}
    </>
  )
}
