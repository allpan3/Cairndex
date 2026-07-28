import type { ReactNode } from 'react'

interface MediaFallbackProps {
  heading: string
  message: string
  meta: string
  /** Card-specific glyph. Decorative — the heading carries the meaning. */
  icon?: ReactNode
  /** Optional recovery action (e.g. "Try again" for a transient server error). */
  action?: { label: string; onClick: () => void }
}

/** Shared fallback card for unsupported, missing, or failed media previews. */
export function MediaFallback({ heading, message, meta, icon, action }: MediaFallbackProps) {
  return (
    <div className="media-fallback" role="alert">
      {/* Hidden from assistive tech: this container is a live region, so anything
          left readable here is announced ahead of the heading — and a bare glyph
          announces as its Unicode name ("square with orthogonal crosshatch
          fill"), which is noise in front of the sentence that matters. */}
      <div className="media-fallback__icon" aria-hidden="true">
        {icon ?? '▦'}
      </div>
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
