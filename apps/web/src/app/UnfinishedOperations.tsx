import type { SourceJob } from '../api/sourceOperations'
import { SourceOperationReview } from './SourceOperationReview'
import { useModalDialog } from './useModalDialog'
import type { SourceTasks } from './useSourceTasks'

/** A sidebar line while saved operations wait for the owner. */
export function UnfinishedOperationsNotice({
  count,
  onReview,
}: {
  count: number
  onReview: () => void
}) {
  if (count === 0) return null
  return (
    <div className="sidebar__job-progress">
      <div className="sidebar__job-review">
        <span>
          {count === 1 ? '1 file operation waits' : `${count} file operations wait`} for you.
        </span>
        <button className="btn btn--sm" onClick={onReview}>
          Review…
        </button>
      </div>
    </div>
  )
}

/** Each waiting operation with its saved review: apply, retry or cancel it. */
export function UnfinishedOperationsDialog({
  library,
  operations,
  enabled,
  tasks,
  onClose,
}: {
  library: string
  operations: SourceJob[]
  enabled: boolean
  tasks: SourceTasks
  onClose: () => void
}) {
  const { ref, close } = useModalDialog(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unfinished-title"
        className="modal source-operation-panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="unfinished-title">File operations that wait for you</h2>
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
        {operations.length === 0 && <p className="modal__note">Nothing waits now.</p>}
        {operations.map((job) => (
          <SourceOperationReview
            key={job.id}
            library={library}
            operation={job.id}
            enabled={enabled}
            // A changed request is a new intent; it runs as a task like any other
            onPrepare={(request) =>
              tasks.start({
                title: 'Preparing a file operation',
                summary: 'Done.',
                finish: { kind: 'none' },
                items: [
                  { name: request.destination || request.source || job.id, size: null, request },
                ],
              })
            }
          />
        ))}
      </div>
    </div>
  )
}
