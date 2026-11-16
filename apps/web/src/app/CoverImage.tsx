import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A card's cover, decoded off the main thread and faded in over one neutral
 * placeholder, the same for every cover. A cover the browser already holds
 * (a card scrolled back into view, say) appears at once rather than fading
 * again. A cover that fails to load leaves the placeholder, without its sweep.
 *
 * It is inert decoration, like every cover (see the inert-media rule in
 * index.css): the card beneath owns clicks, menus and drags.
 */
export function CoverImage({ src }: { src: string }) {
  const image = useRef<HTMLImageElement | null>(null)
  // Which source has loaded or failed, so a new cover starts over
  const [loaded, setLoaded] = useState<{ src: string; instant: boolean } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useLayoutEffect(() => {
    const element = image.current
    if (element?.complete && element.naturalWidth > 0) setLoaded({ src, instant: true })
  }, [src])
  if (failed === src) return <span className="cover-pending cover-pending--still" aria-hidden />
  const shown = loaded?.src === src
  return (
    <>
      <span className={`cover-pending${shown ? ' cover-pending--done' : ''}`} aria-hidden />
      <img
        ref={image}
        className={`cover-image${shown ? ' cover-image--shown' : ''}${
          shown && loaded.instant ? ' cover-image--instant' : ''
        }`}
        src={src}
        alt=""
        decoding="async"
        draggable={false}
        onLoad={() =>
          setLoaded((current) => (current?.src === src ? current : { src, instant: false }))
        }
        onError={() => setFailed(src)}
      />
    </>
  )
}
