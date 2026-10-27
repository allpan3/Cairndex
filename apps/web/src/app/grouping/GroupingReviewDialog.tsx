import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { catalogNavigation } from '../../api/catalogQuery'
import { getConnectionScopeKey } from '../../api/requestScope'
import type { CollectionRead } from '../../api/client'
import { formatBytes } from '../../lib/format'
import { DiscoveryPrepared } from '../DiscoveryPrepared'
import { InfoTip } from '../InfoTip'
import { DiscoveryReviewDialog } from '../ReplicaDiscovery'
import { useModalDialog } from '../useModalDialog'
import type { ReplicaDiscoveryState } from '../useReplicaDiscovery'
import { GroupingMoveDialog, type GroupingMove } from './GroupingMoveDialog'
import { GroupingTree } from './GroupingTree'
import { useFileChangeEntry } from './useFileChangeEntry'
import { useGroupingWorkspace } from './useGroupingWorkspace'
import { useGroupingTree } from './useGroupingTree'

export function GroupingReviewDialog(props: {
  discovery: ReplicaDiscoveryState
  library: string
  editor: string
  /** The server lists additions to existing bundles separately (grouping_version 2) */
  separateAdditions?: boolean
}) {
  return createPortal(
    <GroupingReviewSession key={`${getConnectionScopeKey()}:${props.library}`} {...props} />,
    document.body,
  )
}

const VERIFY_HELP =
  'Optional. Reads every selected file in full to confirm its contents before preparing. ' +
  'This can take a long time for large files or network storage. You can cancel it.'

function GroupingReviewSession({
  discovery: d,
  library,
  editor,
  separateAdditions = false,
}: {
  discovery: ReplicaDiscoveryState
  library: string
  editor: string
  separateAdditions?: boolean
}) {
  const state = useGroupingWorkspace(library, d.refresh)
  // Which side view replaces the tree: file changes, or the earlier choices
  const [fileChanges, setFileChanges] = useState<'changes' | 'earlier' | null>(null)
  const [attention, setAttention] = useState(false)
  const [verify, setVerify] = useState(false)
  const [move, setMove] = useState<GroupingMove | null>(null)
  const { ref, close } = useModalDialog(() => d.setOpen(false), state.sending)
  const tree = useGroupingTree(state, attention, separateAdditions)
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
  const verification = state.verification.data
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
  // One plain line for work in progress; the draft's internal phases stay out of view
  const working = !status
    ? state.workspace
      ? 'Loading suggestions…'
      : ''
    : status.state === 'building'
      ? 'Building suggestions…'
      : status.state === 'editing'
        ? status.phase === 'export'
          ? 'Preparing the review…'
          : status.phase === 'verification'
            ? 'Reading files…'
            : 'Saving…'
        : state.pending || state.sending
          ? 'Saving…'
          : ''
  const paused = state.command.data?.state === 'paused'
  const canPrepare = !editingBlocked && Boolean(status?.selected)
  // Other drafts are offered only when there is one to switch to
  const others = (state.lists.data?.items ?? []).filter((item) => item.id !== state.workspace)
  const latest = state.lists.data?.available_run
  const offerLatest =
    Boolean(latest) && latest !== state.workspace && !others.some((item) => item.id === latest)
  const drafts =
    others.length > 0 ||
    offerLatest ||
    state.after !== null ||
    state.lists.data?.next_cursor != null
  const sideEntry = useFileChangeEntry(library, d)
  const prepared = Boolean(status?.accepting)
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
            <button
              className="modal__close"
              aria-label="Close"
              disabled={state.sending}
              onClick={close}
            >
              ×
            </button>
          </div>
          {/* One line by default; the points are the same every time */}
          <details className="grp-intro-details">
            <summary className="grp-intro">
              Proposed grouping for new files. <strong>Nothing on disk changes.</strong>
            </summary>
            <ul className="grp-intro-points">
              <li>
                Edits save to a private draft. The catalog changes only when you accept a prepared
                review.
              </li>
              <li>
                The tree shows where each bundle goes. Hover a name to see the folder its files come
                from.
              </li>
              <li>
                Drag files between bundles. Double-click a name to rename it, or right-click a row
                (Shift+F10) for more actions.
              </li>
              <li>Reflects the last Update. Run Update again if files changed since.</li>
            </ul>
          </details>
          {/* One reserved line, so a notice never pushes the list under the pointer */}
          <div className="grp-status" role={message ? 'alert' : 'status'} aria-live="polite">
            {message ? (
              <span className="grp-error">{message}</span>
            ) : paused ? (
              'An edit was interrupted.'
            ) : (
              working
            )}{' '}
            {state.error && state.pending && (
              <button
                className="btn btn--compact"
                title="Send the same edit again"
                disabled={state.sending}
                onClick={state.retry}
              >
                Retry edit
              </button>
            )}
            {paused && (
              <button
                className="btn btn--compact"
                title="Continue the interrupted edit exactly as it was sent"
                disabled={state.sending}
                onClick={() => void state.resume()}
              >
                Resume edit
              </button>
            )}
            {(state.status.error || state.lists.error) && (
              <button
                className="btn btn--compact"
                aria-label="Retry grouping status"
                onClick={() => {
                  void state.status.refetch()
                  void state.lists.refetch()
                }}
              >
                Retry
              </button>
            )}
          </div>
          {collections.error && (
            <p className="grp-error" role="alert">
              Collections could not be loaded, so placement choices are unavailable.{' '}
              <button
                className="btn btn--compact"
                aria-label="Retry collection destinations"
                title={collections.error.message}
                onClick={() => void collections.refetch()}
              >
                Retry
              </button>
            </p>
          )}
          {!state.workspace && !state.lists.isPending && !message && (
            <p className="grp-empty">Run Update to discover grouping suggestions.</p>
          )}
          {status && status.revision > 0 && (
            <>
              <div className="grp-selectbar">
                <div className="grp-selectbar__group">
                  {(status.uncertain > 0 || attention) && (
                    <button
                      className="btn btn--compact grp-attention"
                      aria-pressed={attention}
                      title={
                        attention
                          ? 'Show every suggestion again'
                          : 'Show only the suggestions that need a look. Accept still uses every selected file.'
                      }
                      onClick={() => setAttention((value) => !value)}
                    >
                      {status.uncertain} {status.uncertain === 1 ? 'needs' : 'need'} a look
                    </button>
                  )}
                  <span>
                    {`${status.selected} / ${status.files} files selected · ${status.bundles} ${status.bundles === 1 ? 'bundle' : 'bundles'}`}
                  </span>
                  <button
                    className="btn btn--compact"
                    disabled={editingBlocked}
                    onClick={() => state.edit({ action: 'select', selected: true })}
                  >
                    Select all
                  </button>
                  <button
                    className="btn btn--compact"
                    disabled={editingBlocked}
                    onClick={() => state.edit({ action: 'select', selected: false })}
                  >
                    Select none
                  </button>
                </div>
                <div className="grp-selectbar__group">
                  <button
                    className="btn btn--compact"
                    title="Collapse every collection"
                    onClick={tree.collapseCollections}
                  >
                    Collapse all
                  </button>
                  <button
                    className="btn btn--compact"
                    title="Expand the collections loaded so far; deeper ones load as they open"
                    onClick={tree.expandCollections}
                  >
                    Expand all
                  </button>
                  <button
                    className="btn btn--compact"
                    onClick={tree.filesShown ? tree.hideFiles : tree.showFiles}
                  >
                    {tree.filesShown ? 'Hide files' : 'Show files'}
                  </button>
                </div>
              </div>
              <GroupingTree
                state={state}
                tree={tree}
                collections={options}
                collectionsLoading={collections.isPending}
                collectionsError={Boolean(collections.error)}
                onMove={setMove}
              />
            </>
          )}
          {verification && (
            <section className="grp-verify" aria-label="Complete content verification">
              <span role="status">
                {verification.state === 'failed'
                  ? 'Reading files stopped.'
                  : verification.state === 'cancelled'
                    ? 'Reading files cancelled.'
                    : verification.state === 'succeeded'
                      ? 'Files read in full.'
                      : 'Reading files in full…'}{' '}
                {verification.verified} / {verification.files} files ·{' '}
                {formatBytes(verification.bytes_read)} of {formatBytes(verification.total_bytes)}
              </span>
              <progress
                value={verification.bytes_read}
                max={Math.max(1, verification.total_bytes)}
              />
              {['queued', 'running'].includes(verification.state) && (
                <button
                  className="btn btn--compact"
                  aria-label="Cancel content verification"
                  disabled={state.sending}
                  onClick={() => void state.cancelVerification()}
                >
                  Cancel
                </button>
              )}
              {verification.error && <span className="grp-error">{verification.error}</span>}
            </section>
          )}
          {prepared && (
            <section className="portable-grp-prepared" aria-label="Prepared grouping review">
              <p role="status">
                {!review || review.state === 'queued'
                  ? 'Preparing the review…'
                  : review.state === 'ready'
                    ? 'Ready for your confirmation'
                    : review.state === 'apply_queued'
                      ? 'Rechecking files and saving…'
                      : review.state === 'applied'
                        ? 'Grouping saved.'
                        : 'This review can no longer be accepted. Return to editing to prepare it again.'}
              </p>
              {/* Its own line, so the status above names only the review's state */}
              {review?.progress && (
                <p className="grp-hint">
                  {review.progress.progress} / {review.progress.total} files
                </p>
              )}
              {review?.error && (
                <p className="grp-error" role="alert">
                  {review.error}
                </p>
              )}
              {review?.prepared && (
                <details>
                  <summary>Review prepared files and metadata</summary>
                  <DiscoveryPrepared library={library} review={review} />
                </details>
              )}
            </section>
          )}
          <div className="modal__foot grp-foot">
            {drafts && (
              <details className="grp-drafts">
                <summary title="Switch to another Update's draft. Each keeps its own choices.">
                  Other drafts
                </summary>
                <div className="grp-drafts__list">
                  {offerLatest && (
                    <button
                      className="btn btn--compact"
                      disabled={choosingBlocked}
                      onClick={() => void state.choose(latest!)}
                    >
                      Review latest Update
                    </button>
                  )}
                  {others.map((item) => (
                    <button
                      className="btn btn--compact"
                      key={item.id}
                      disabled={choosingBlocked}
                      onClick={() => void state.choose(item.id)}
                    >
                      {item.selected} / {item.files} files
                      {item.accepting ? ' · prepared' : ''}
                    </button>
                  ))}
                  {state.lists.data?.next_cursor != null && (
                    <button
                      className="btn btn--compact"
                      onClick={() => state.setAfter(state.lists.data!.next_cursor!)}
                    >
                      Older drafts
                    </button>
                  )}
                  {state.after !== null && (
                    <button className="btn btn--compact" onClick={() => state.setAfter(null)}>
                      Latest drafts
                    </button>
                  )}
                </div>
              </details>
            )}
            {sideEntry && (
              <button
                className="btn btn--compact"
                title={
                  sideEntry.earlier
                    ? 'This Update’s suggestions as separate choices, as the earlier review offered them'
                    : 'Moved or replaced files, and reviews prepared earlier'
                }
                onClick={() => {
                  d.setAfter('')
                  setFileChanges(sideEntry.earlier ? 'earlier' : 'changes')
                }}
              >
                {sideEntry.label}
              </button>
            )}
            {!prepared && (
              <span className="grp-foot__note">
                <label>
                  <input
                    type="checkbox"
                    checked={verify}
                    disabled={editingBlocked}
                    onChange={(event) => setVerify(event.target.checked)}
                  />{' '}
                  Verify file contents
                </label>{' '}
                <InfoTip label="About verifying file contents">{VERIFY_HELP}</InfoTip>
              </span>
            )}
            <div className="grp-foot__spacer" />
            {prepared ? (
              <>
                {review && !['applied', 'apply_queued'].includes(review.state) && (
                  <button
                    className="btn"
                    disabled={state.busy}
                    onClick={() => state.edit({ action: 'cancel_review', review: review.id })}
                  >
                    Return to editing
                  </button>
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
              </>
            ) : (
              <button
                className="btn btn--primary"
                disabled={!canPrepare}
                title="Prepare a review of the selected grouping to check before accepting (⌘/Ctrl+Enter)"
                onClick={() => state.edit({ action: 'prepare', verify_content: verify })}
              >
                Prepare selected grouping
              </button>
            )}
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
          earlier={fileChanges === 'earlier'}
          onBack={() => {
            setFileChanges(null)
            d.setCandidate(null)
            d.setReviewId(null)
          }}
        />
      )}
    </>
  )
}
