interface MediaFallbackProps {
  heading: string
  message: string
  meta: string
  /** Optional recovery action (e.g. "Try again" for a transient server error). */
  action?: { label: string; onClick: () => void }
}

/** Shared fallback card for unsupported, missing, or failed media previews. */
export function MediaFallback({ heading, message, meta, action }: MediaFallbackProps) {
  return (
    <div className="media-fallback" role="alert">
      <div className="media-fallback__icon">▦</div>
      <strong>{heading}</strong>
      <p>{message}</p>
      {action && (
        <button type="button" className="media-fallback__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      <p className="media-fallback__meta">{meta}</p>
    </div>
  )
}
