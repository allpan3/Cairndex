import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A card's cover, decoded off the main thread and faded in over the neutral
 * placeholder its frame already paints. A cover the browser already holds
 * (a card scrolled back into view, say) appears at once rather than fading
 * again. A cover that fails to load leaves the placeholder.
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
  if (failed === src) return null
  const shown = loaded?.src === src
  return (
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
  )
}
