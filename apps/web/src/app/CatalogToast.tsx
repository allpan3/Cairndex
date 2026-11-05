import { useEffect } from 'react'

/** One message for the owner; an alert reports a failure rather than a result. */
export interface CatalogNotice {
  text: string
  alert?: boolean
  /** One follow-up, such as Undo; choosing it also dismisses the message. */
  action?: { label: string; run: () => void }
}

/**
 * The browser's one transient message, at the bottom of the window as the
 * legacy shell showed it, so results and failures never push the toolbar or
 * the grid down. A result clears itself; a failure stays until dismissed.
 */
export function CatalogToast({
  notice,
  onDismiss,
}: {
  notice: CatalogNotice | null
  onDismiss: () => void
}) {
  useEffect(() => {
    if (!notice || notice.alert) return
    // A message with a follow-up stays longer, so Undo is there to reach
    const timer = setTimeout(onDismiss, notice.action ? 10000 : 5000)
    return () => clearTimeout(timer)
  }, [notice, onDismiss])
  if (!notice) return null
  return (
    <div className="mb-toast" role={notice.alert ? 'alert' : 'status'}>
      {notice.text}
      {notice.action && (
        <button
          className="btn btn--sm mb-toast__action"
          onClick={() => {
            notice.action!.run()
            onDismiss()
          }}
        >
          {notice.action.label}
        </button>
      )}
      <button className="btn btn--sm mb-toast__action" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}
