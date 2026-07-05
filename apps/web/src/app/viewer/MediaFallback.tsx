interface MediaFallbackProps {
  heading: string
  message: string
  meta: string
}

/** Shared fallback card for unsupported, missing, or failed media previews. */
export function MediaFallback({ heading, message, meta }: MediaFallbackProps) {
  return (
    <div className="media-fallback" role="alert">
      <div className="media-fallback__icon">▦</div>
      <strong>{heading}</strong>
      <p>{message}</p>
      <p className="media-fallback__meta">{meta}</p>
    </div>
  )
}
