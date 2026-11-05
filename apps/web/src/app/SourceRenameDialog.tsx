import { SourceOperationReview } from './SourceOperationReview'
import { useModalDialog } from './useModalDialog'
import type { useSourceRename } from './useSourceRename'

export function SourceRenameDialog({
  library,
  rename,
}: {
  library: string
  rename: ReturnType<typeof useSourceRename>
}) {
  const { prepare, enabled, queue } = rename
  const { ref, close } = useModalDialog(() => prepare.reset(), prepare.isPending)
  const request = prepare.variables
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Review rename"
        className="modal source-operation-panel"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2>Review rename</h2>
          <button className="btn" disabled={prepare.isPending} onClick={close}>
            Close
          </button>
        </div>
        {prepare.isPending && <p role="status">Preparing rename…</p>}
        {prepare.error && (
          <>
            <p role="alert">{prepare.error.message}</p>
            <button disabled={!enabled} onClick={() => request && queue(request)}>
              Retry preparation
            </button>
          </>
        )}
        {!enabled && <p>Write mode is off. Turn it on to apply this rename.</p>}
        {prepare.data && (
          <SourceOperationReview
            key={prepare.data.id}
            library={library}
            operation={prepare.data.id}
            enabled={enabled}
            onPrepare={queue}
          />
        )}
      </div>
    </div>
  )
}
