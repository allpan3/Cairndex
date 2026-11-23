import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { observeCover } from './coverViewport'
import { acquireCoverBlobUrl, canCacheCoverBlobs, getCachedCoverBlobUrl } from './coverMemoryCache'

/**
 * A card's cover, decoded off the main thread and faded in over one neutral
 * placeholder, the same for every cover. A cover the browser or session cache
 * already holds (a card scrolled back into view or across view switches)
 * appears at once rather than fading or re-fetching over SMB again. A cover
 * that fails to load leaves the placeholder, without its sweep.
 *
 * It is inert decoration, like every cover (see the inert-media rule in
 * index.css): the card beneath owns clicks, menus and drags.
 */
export function CoverImage({ src }: { src: string }) {
  const image = useRef<HTMLImageElement | null>(null)
  const useBlobs = canCacheCoverBlobs()
  const warmBlob = useBlobs ? getCachedCoverBlobUrl(src) : undefined

  const [blobState, setBlobState] = useState<{ src: string; blobUrl: string } | null>(() =>
    warmBlob ? { src, blobUrl: warmBlob } : null,
  )
  // Which source has loaded or failed, so a new cover starts over
  const [loaded, setLoaded] = useState<{ src: string; instant: boolean } | null>(() =>
    warmBlob ? { src, instant: true } : null,
  )
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    if (!useBlobs || !image.current || getCachedCoverBlobUrl(src)) return
    let handle: ReturnType<typeof acquireCoverBlobUrl> | undefined
    const stop = observeCover(image.current, (visibility) => {
      if (visibility === 'outside') {
        handle?.release()
        handle = undefined
        return
      }
      const visible = visibility === 'visible'
      if (handle) {
        handle.setVisible(visible)
        return
      }
      const request = acquireCoverBlobUrl(src, visible)
      handle = request
      void request.promise.then((objectUrl) => {
        if (handle !== request) return
        if (objectUrl) setBlobState({ src, blobUrl: objectUrl })
        else setFailed(src)
      })
    })
    return () => {
      stop()
      handle?.release()
      handle = undefined
    }
  }, [src, useBlobs])

  useLayoutEffect(() => {
    if (useBlobs && warmBlob) return
    const element = image.current
    if (element?.complete && element.naturalWidth > 0) setLoaded({ src, instant: true })
  }, [src, useBlobs, warmBlob])

  if (failed === src) return <span className="cover-pending cover-pending--still" aria-hidden />
  const effectiveBlob = warmBlob ?? (blobState?.src === src ? blobState.blobUrl : undefined)
  const shown = Boolean(warmBlob) || loaded?.src === src
  const instant = Boolean(warmBlob) || Boolean(shown && loaded?.instant)
  const imgSrc = useBlobs ? effectiveBlob : src

  return (
    <>
      <span className={`cover-pending${shown ? ' cover-pending--done' : ''}`} aria-hidden />
      <img
        ref={image}
        className={`cover-image${shown ? ' cover-image--shown' : ''}${
          instant ? ' cover-image--instant' : ''
        }`}
        src={imgSrc}
        alt=""
        decoding="async"
        draggable={false}
        onLoad={() =>
          setLoaded((current) => (current?.src === src ? current : { src, instant: false }))
        }
        onError={() => {
          if (!useBlobs || effectiveBlob) setFailed(src)
        }}
      />
    </>
  )
}
